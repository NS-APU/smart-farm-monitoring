/**
 * 既存の通知の移行コマンド（`pnpm migrate-notification-counters`）の起動エントリ。ロジックを持たない
 * （テストの対象は runtime/migrate-notification-counters-cli.ts の runMigrateNotificationCountersCli）。
 * `.env` は、読み込まない（ローカル開発用の設定が、AWS への操作に混ざらないよう、環境変数を明示して実行する）。
 */

import { runMigrateNotificationCountersCli } from './migrate-notification-counters-cli.ts';

process.exitCode = await runMigrateNotificationCountersCli(process.env, {
  info: (message) => {
    process.stdout.write(`${message}\n`);
  },
  error: (message) => {
    process.stderr.write(`${message}\n`);
  },
});
