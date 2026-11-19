/**
 * 設備ごとの接続への移行コマンド（`pnpm migrate-equipment-connections`）の起動エントリ。ロジックを持たない
 * （テストの対象は runtime/migrate-equipment-connections-cli.ts の runMigrateEquipmentConnectionsCli）。
 * `.env` は、読み込まない（ローカル開発用の設定が、AWS への操作に混ざらないよう、環境変数を明示して実行する）。
 */

import { runMigrateEquipmentConnectionsCli } from './migrate-equipment-connections-cli.ts';

process.exitCode = await runMigrateEquipmentConnectionsCli(process.argv.slice(2), process.env, {
  info: (message) => {
    process.stdout.write(`${message}\n`);
  },
  error: (message) => {
    process.stderr.write(`${message}\n`);
  },
});
