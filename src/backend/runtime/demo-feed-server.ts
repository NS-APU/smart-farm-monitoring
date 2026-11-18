/**
 * ローカルで、デモ用の合成データの HTTP 配信を起動する（`pnpm dev:demo-feed`。Issue #344。ADR-0025）。
 * 開発サイトで使う配信（runtime/demo-feed-http-lambda.ts。Lambda の Function URL）と、同じハンドラを、手元の HTTP サーバー
 * （127.0.0.1 だけ。外には公開しない）から返す。ローカルのバックエンド（`pnpm dev:backend`）の取り込みが、実際のファイルサーバーと
 * 同じ手順（設備ごとのファイルパスへの `HEAD`・`GET`）で、デモのデータを取り込む試しに使う（ディレクトリのモックの置き換え）。
 * 返すのは、合成データだけ（実データ・個人情報は持たない）。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEMO_FEED_FILE_PATHS } from '../application/demo/demo-feed-schedule.ts';
import type { ClockPort } from '../application/ports/clock-port.ts';
import { ConfigError } from './config.ts';
import { createDemoFeedHttpHandler } from './demo-feed-http-lambda.ts';

/** 既定のポート（開発サーバーの 8787・5173 と、重ならない値）。 */
export const DEFAULT_DEMO_FEED_PORT = 8790;

export interface DemoFeedServer {
  readonly port: number;
  close(): Promise<void>;
}

export interface CommandOutput {
  info(message: string): void;
}

/** デモ配信の HTTP サーバーを、127.0.0.1 で起動する。`port` に 0 を指定すると、空いているポートを使う。 */
export async function startDemoFeedServer(
  options: { readonly port?: number; readonly clock?: ClockPort } = {},
): Promise<DemoFeedServer> {
  const handler = createDemoFeedHttpHandler(
    options.clock === undefined ? {} : { clock: options.clock },
  );
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    void handler({
      rawPath: path,
      requestContext: { http: { method: request.method ?? '' } },
    }).then((result) => {
      response.writeHead(result.statusCode, result.headers);
      response.end(request.method === 'HEAD' ? undefined : result.body);
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_DEMO_FEED_PORT, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  return {
    port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** ポートの指定（`--port N` または環境変数 DEMO_FEED_PORT。0〜65535。指定がなければ既定）。不正な値は、設定エラー。 */
export function parseDemoFeedPort(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): number {
  const index = args.indexOf('--port');
  const text = index >= 0 ? args[index + 1] : env.DEMO_FEED_PORT?.trim();
  if (text === undefined || text === '') {
    if (index >= 0) {
      throw new ConfigError('--port には、ポート番号を指定してください');
    }
    return DEFAULT_DEMO_FEED_PORT;
  }
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > 65535) {
    throw new ConfigError('ポート番号は、0〜65535 の整数で指定してください');
  }
  return port;
}

/** コマンドの本体: 起動して、使い方（バックエンド側の設定）を示す。停止は、呼び出し元が、`close` する。 */
export async function runDemoFeedCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: CommandOutput,
): Promise<DemoFeedServer> {
  const server = await startDemoFeedServer({ port: parseDemoFeedPort(args, env) });
  const port = String(server.port);
  const robotPath = DEMO_FEED_FILE_PATHS.robot;
  const sensorPath = DEMO_FEED_FILE_PATHS['environment-sensor'];
  output.info(`デモ用の配信を起動しました（http://127.0.0.1:${port}/ だけ。停止は Ctrl+C）`);
  output.info(`  ファイル: ${robotPath}（ロボット）・${sensorPath}（環境センサー）`);
  output.info(
    'ローカルのバックエンドで、次のように設定すると、取り込み（JB-01・即時取得）が、この配信を読みます:',
  );
  output.info(
    '  1. バックエンドを、環境変数 HTTP_FILE_SOURCE_ALLOW_PRIVATE=true で起動する（ローカルだけ。本番の組み立てでは、無効）',
  );
  output.info(
    `  2. SC-11 の取り込み元（ロボット・環境センサー）の接続を、プロトコル HTTP・ホスト 127.0.0.1・ポート ${port}・認証方式 なし にして保存する`,
  );
  output.info(
    '  3. SC-10 の設備（ロボット・環境センサー）の「ファイルのパス」に、上のファイルを設定する',
  );
  return server;
}
