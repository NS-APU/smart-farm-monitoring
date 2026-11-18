/**
 * ローカルで、デモ用の合成データの HTTP 配信を起動するコマンド（`pnpm dev:demo-feed`）の起動エントリ。ロジックを持たない
 * （テストの対象は runtime/demo-feed-server.ts）。`.env` は、読み込まない（ポートは、`--port` または環境変数 DEMO_FEED_PORT）。
 */

import { ConfigError } from './config.ts';
import { runDemoFeedCli } from './demo-feed-server.ts';

try {
  const server = await runDemoFeedCli(process.argv.slice(2), process.env, {
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
    `demo-feed の起動に失敗しました: ${error instanceof ConfigError ? error.message : '（ポートが使われている可能性があります。--port で、別のポートを指定してください）'}\n`,
  );
  process.exitCode = 1;
}
