/**
 * Lambda のハンドラ（関数の URL を想定）。Node サーバーと同じ Hono アプリを使う。
 * 組み立ては、最初の呼び出しで1度だけ行い、再利用する（ハンドラの中で毎回生成しない）。
 * 初期化が失敗した場合は、失敗を保持せず、次の呼び出しで再試行する（一時的な失敗で、
 * そのコンテナが以後すべてのリクエストに失敗し続けることを防ぐ。NFR-4.3）。
 * 設定は、`APP_MODE`・`PERSISTENCE` の明示を必須にし、開発用 API を常に無効にする（config.ts の parseLambdaConfig）。
 * 本番のアダプタ（DynamoDB・Cognito 等）は未実装のため、APP_MODE=production では、呼び出しがエラーになる。
 */

import { handle } from '@hono/aws-lambda';
import { createApp } from '../presentation/create-app.ts';
import { parseLambdaConfig } from './config.ts';
import { createContainer } from './container.ts';

type LambdaHandler = ReturnType<typeof handle>;

/** テストで、組み立てを差し替えるための依存。 */
export interface LambdaHandlerDeps {
  readonly createContainer?: typeof createContainer;
}

export function createLambdaHandler(
  env: Readonly<Record<string, string | undefined>>,
  deps: LambdaHandlerDeps = {},
): LambdaHandler {
  const build = deps.createContainer ?? createContainer;
  let ready: Promise<LambdaHandler> | undefined;

  async function initialize(): Promise<LambdaHandler> {
    const container = build(parseLambdaConfig(env));
    await container.initialize();
    return handle(createApp(container));
  }

  return async (event, context) => {
    const attempt = (ready ??= initialize());
    let handler: LambdaHandler;
    try {
      handler = await attempt;
    } catch (error) {
      // 失敗した Promise を保持しない。次の呼び出しで、初期化をやり直す（ほかの呼び出しが、すでに作り直していれば、残す）
      if (ready === attempt) {
        ready = undefined;
      }
      throw error;
    }
    return handler(event, context);
  };
}

export const handler: LambdaHandler = createLambdaHandler(process.env);
