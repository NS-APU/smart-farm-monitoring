/**
 * 既存ユーザーのロールを移すコマンド（`pnpm migrate-user-roles`）の起動エントリ。ロジックを持たない
 * （テストの対象は runtime/migrate-user-roles-cli.ts の runMigrateUserRolesCli）。
 * `.env` は、読み込まない（ローカル開発用の設定が、AWS への操作に混ざらないよう、環境変数を明示して実行する）。
 */

import { runMigrateUserRolesCli } from './migrate-user-roles-cli.ts';

process.exitCode = await runMigrateUserRolesCli(process.env, {
  info: (message) => {
    process.stdout.write(`${message}\n`);
  },
  error: (message) => {
    process.stderr.write(`${message}\n`);
  },
});
