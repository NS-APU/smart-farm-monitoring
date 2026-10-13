/**
 * データファイルのバックアップ・復元のコマンド（`pnpm data:backup`）の起動エントリ。ロジックを持たない
 * （テストの対象は infrastructure/local/data-backup.ts の runDataBackupCli）。
 */

import { runDataBackupCli } from '../infrastructure/local/data-backup.ts';

process.exitCode = runDataBackupCli(
  process.argv.slice(2),
  process.env,
  {
    info: (message) => {
      process.stdout.write(`${message}\n`);
    },
    error: (message) => {
      process.stderr.write(`${message}\n`);
    },
  },
  new Date(),
);
