/**
 * 評価環境のデモデータを投入・リセットするコマンド（`pnpm demo-data`）の起動エントリ。ロジックを持たない
 * （テストの対象は runtime/demo-data-cli.ts の runDemoDataCli）。
 * `.env` は、読み込まない（ローカル開発用の設定が、AWS への操作に混ざらないよう、環境変数を明示して実行する）。
 */

import { runDemoDataCli } from './demo-data-cli.ts';

process.exitCode = await runDemoDataCli(process.argv.slice(2), process.env, {
  info: (message) => {
    process.stdout.write(`${message}\n`);
  },
  error: (message) => {
    process.stderr.write(`${message}\n`);
  },
});
