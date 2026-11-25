/**
 * ローカルのファイルサーバー（`pnpm dev:file-server`）の起動エントリ。ロジックを持たない（テストの対象は runtime/dev-file-server.ts）。
 * `.env` は、読み込まない（ポートは、`--port` または環境変数 DEV_FILE_SERVER_PORT）。
 */

import { ConfigError } from './config.ts';
import { runDevFileServerCli } from './dev-file-server.ts';

try {
  const server = await runDevFileServerCli(process.argv.slice(2), process.env, {
    info: (message) => {
      process.stdout.write(`${message}\n`);
    },
  });
  const stop = (): void => {
    void server.close().then(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  process.stderr.write(
    `dev:file-server の起動に失敗しました: ${error instanceof ConfigError ? error.message : '（ポートが使われている可能性があります。--port で、別のポートを指定してください）'}\n`,
  );
  process.exitCode = 1;
}
