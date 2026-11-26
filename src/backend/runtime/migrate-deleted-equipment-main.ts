/**
 * 以前の論理削除済みの設備の移行コマンド（`pnpm migrate-deleted-equipment`）の起動エントリ。ロジックを持たない
 * （テストの対象は runtime/migrate-deleted-equipment-cli.ts の runMigrateDeletedEquipmentCli）。
 * `.env` は、読み込まない（ローカル開発用の設定が、AWS への操作に混ざらないよう、環境変数を明示して実行する）。
 */

import { runMigrateDeletedEquipmentCli } from './migrate-deleted-equipment-cli.ts';

process.exitCode = await runMigrateDeletedEquipmentCli(process.env, {
  info: (message) => {
    process.stdout.write(`${message}\n`);
  },
  error: (message) => {
    process.stderr.write(`${message}\n`);
  },
});
