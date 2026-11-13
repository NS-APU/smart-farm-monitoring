/**
 * Lambda のハンドラ（関数の URL を想定）。Node サーバーと同じ Hono アプリを使う。
 * 組み立ては、最初の呼び出しで1度だけ行い、再利用する（ハンドラの中で毎回生成しない）。
 * 初期化が失敗した場合は、失敗を保持せず、次の呼び出しで再試行する（一時的な失敗で、
 * そのコンテナが以後すべてのリクエストに失敗し続けることを防ぐ。NFR-4.3）。
 * 設定は、`APP_MODE`・`PERSISTENCE` の明示を必須にし、開発用 API・スケジューラ・デモデータの投入を使えなくする
 * （config.ts の parseLambdaConfig）。本番（APP_MODE=production）は、DynamoDB・Cognito が必須（ADR-0009）。
 */

import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { handle } from '@hono/aws-lambda';
import {
  createOriginSecretReader,
  type OriginSecretReader,
} from '../infrastructure/secrets-manager/origin-secret-reader.ts';
import { createApp } from '../presentation/create-app.ts';
import { ConfigError, parseLambdaConfig } from './config.ts';
import { createContainer } from './container.ts';

type LambdaHandler = ReturnType<typeof handle>;

/** テストで、組み立てを差し替えるための依存。 */
export interface LambdaHandlerDeps {
  readonly createContainer?: typeof createContainer;
  /** オリジンの秘密を、Secrets Manager から読む関数（テストで、偽物に差し替える。Issue #102）。 */
  readonly readOriginSecret?: OriginSecretReader;
}

export function createLambdaHandler(
  env: Readonly<Record<string, string | undefined>>,
  deps: LambdaHandlerDeps = {},
): LambdaHandler {
  const build = deps.createContainer ?? createContainer;
  const readOriginSecret =
    deps.readOriginSecret ??
    ((arn: string) => createOriginSecretReader({ client: new SecretsManagerClient({}) })(arn));
  let ready: Promise<LambdaHandler> | undefined;

  async function initialize(): Promise<LambdaHandler> {
    const config = parseLambdaConfig(env);
    // 本番の API は、関数の URL の直接の呼び出しを拒否する（秘密のヘッダーの検証。Issue #102）。設定がないまま、黙って無効にならないよう、起動しない
    if (config.mode === 'production' && config.originVerifyArn === undefined) {
      throw new ConfigError('本番の API の Lambda では、環境変数 ORIGIN_VERIFY_ARN が必須です');
    }
    // 秘密は、コールドスタートの 1 回だけ、Secrets Manager から読む（読めなければ、起動に失敗し、次の呼び出しで、読み直す）
    const originVerifySecret =
      config.originVerifyArn === undefined
        ? undefined
        : await readOriginSecret(config.originVerifyArn);
    const container = build(config);
    await container.initialize();
    return handle(createApp({ ...container, originVerifySecret }));
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
