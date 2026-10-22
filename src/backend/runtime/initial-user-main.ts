/**
 * 最初のユーザーを作るコマンド（`pnpm initial-user`）の起動エントリ。ロジックを持たない
 * （テストの対象は runtime/initial-user-cli.ts の runInitialUserCli）。
 * `.env` は、読み込まない（ローカル開発用の設定が、AWS への操作に混ざらないよう、環境変数を明示して実行する）。
 */

import { runInitialUserCli } from './initial-user-cli.ts';

process.exitCode = await runInitialUserCli(process.env, {
  info: (message) => {
    process.stdout.write(`${message}\n`);
  },
  error: (message) => {
    process.stderr.write(`${message}\n`);
  },
});
