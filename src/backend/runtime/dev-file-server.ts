/**
 * ローカルで、自前のファイルサーバー（ADR-0027）と同じ動きをする HTTP サーバーを起動する（`pnpm dev:file-server`。Issue #375）。
 * ロボットと同じ `PUT`（書き込み用のトークン）で置いたファイルを、取り込み（JB-01）の `GET`・`HEAD`（読み取り用のトークン）で読める。
 * 処理は、開発サイト・本番と同じ中核（application/hosted-file-server/hosted-file-server.ts）。保管先・秘密情報は、メモリ（停止すると、消える）。
 * 127.0.0.1 だけで待ち受け（外には、公開しない）、トークンは、明らかにダミーとわかる固定値（実際の秘密情報では、ない）。
 * `pnpm simulate`（シミュレーション）の、置き先の 1 つとして使う（ローカルのバックエンドの取り込みが、読む）。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createHostedFileServer,
  HOSTED_FILE_READ_TOKEN_REFERENCE,
  HOSTED_FILE_WRITE_TOKEN_REFERENCE,
} from '../application/hosted-file-server/hosted-file-server.ts';
import { NULL_LOGGER } from '../application/ports/logger-port.ts';
import { createSystemClock } from '../infrastructure/local/clocks.ts';
import { createMemoryHostedFileStore } from '../infrastructure/local/memory-hosted-file-store.ts';
import { createMemorySecretPort } from '../infrastructure/local/env-secret.ts';
import { ConfigError } from './config.ts';
import type { CommandOutput } from './demo-feed-server.ts';
import {
  DEV_FILE_SERVER_READ_TOKEN,
  DEV_FILE_SERVER_WRITE_TOKEN,
} from './dev-file-server-tokens.ts';

/** 既定のポート（開発サーバーの 8787・5173、デモ配信の 8790 と、重ならない値）。 */
export const DEFAULT_DEV_FILE_SERVER_PORT = 8791;
export { DEV_FILE_SERVER_READ_TOKEN, DEV_FILE_SERVER_WRITE_TOKEN };

export interface DevFileServer {
  readonly port: number;
  close(): Promise<void>;
}

/** リクエストの本文を読む（上限の判定は、中核が行い、413 で返す。ローカルだけで使うため、読み込みの上限は、設けない）。 */
async function readBody(request: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** ファイルサーバーを、127.0.0.1 で起動する。`port` に 0 を指定すると、空いているポートを使う。 */
export async function startDevFileServer(options: {
  readonly port: number;
}): Promise<DevFileServer> {
  const handler = createHostedFileServer({
    store: createMemoryHostedFileStore(createSystemClock()),
    secrets: createMemorySecretPort({
      [HOSTED_FILE_READ_TOKEN_REFERENCE]: DEV_FILE_SERVER_READ_TOKEN,
      [HOSTED_FILE_WRITE_TOKEN_REFERENCE]: DEV_FILE_SERVER_WRITE_TOKEN,
    }),
    logger: NULL_LOGGER,
  });
  const server = createServer((request, response) => {
    void (async () => {
      const body = request.method === 'PUT' ? await readBody(request) : undefined;
      const result = await handler({
        method: String(request.method),
        path: new URL(String(request.url), 'http://localhost').pathname,
        authorization: request.headers.authorization,
        body,
      });
      response.writeHead(result.statusCode, result.headers);
      response.end(request.method === 'HEAD' ? undefined : result.body);
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
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

/** ポートの指定（`--port N` または環境変数 DEV_FILE_SERVER_PORT。0〜65535。指定がなければ既定）。不正な値は、設定エラー。 */
export function parseDevFileServerPort(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): number {
  const index = args.indexOf('--port');
  const text = index >= 0 ? args[index + 1] : env.DEV_FILE_SERVER_PORT?.trim();
  if (text === undefined || text === '') {
    if (index >= 0) {
      throw new ConfigError('--port には、ポート番号を指定してください');
    }
    return DEFAULT_DEV_FILE_SERVER_PORT;
  }
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > 65535) {
    throw new ConfigError('ポート番号は、0〜65535 の整数で指定してください');
  }
  return port;
}

/** コマンドの本体: 起動して、使い方（バックエンド・設備の設定、シミュレーションの実行）を示す。停止は、呼び出し元が、`close` する。 */
export async function runDevFileServerCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: CommandOutput,
): Promise<DevFileServer> {
  const server = await startDevFileServer({ port: parseDevFileServerPort(args, env) });
  const port = String(server.port);
  output.info(
    `ローカルのファイルサーバーを起動しました（http://127.0.0.1:${port}/ だけ。メモリに保管するため、停止すると、置いたファイルは消えます。停止は Ctrl+C）`,
  );
  output.info(`  読み取り用のトークン（ダミー）: ${DEV_FILE_SERVER_READ_TOKEN}`);
  output.info(`  書き込み用のトークン（ダミー）: ${DEV_FILE_SERVER_WRITE_TOKEN}`);
  output.info('ローカルのバックエンドで、このサーバーのファイルを取り込むには:');
  output.info(
    '  1. バックエンドを、環境変数 HTTP_FILE_SOURCE_ALLOW_PRIVATE=true で起動する（ローカルだけ。本番の組み立てでは、無効）',
  );
  output.info(
    `  2. メニューの「ハウス・設備」画面で、ロボット・環境センサーの接続を、プロトコル HTTP・ホスト 127.0.0.1・ポート ${port}・認証方式 Bearer（トークンは、上の読み取り用）にして保存する`,
  );
  output.info(
    '  3. 同じ画面で、設備の「ファイルのパス」に、シミュレーションが置くパス（既定: /robot/sim-robot-1/latest.json など）を設定する',
  );
  output.info(
    `シミュレーションを流すには、別のターミナルで: pnpm simulate --url http://127.0.0.1:${port}/`,
  );
  return server;
}
