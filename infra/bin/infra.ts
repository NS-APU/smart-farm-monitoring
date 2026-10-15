/**
 * 評価環境（画面のホスティングと API）の CDK アプリのエントリ。環境変数は、lib/config.ts を参照。
 * 画面は、先に `pnpm build`（dist/frontend）しておく。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createEvaluationApp } from '../lib/apps.ts';

const frontendAssetPath = join(import.meta.dirname, '../../dist/frontend');
if (!existsSync(join(frontendAssetPath, 'index.html'))) {
  throw new Error(
    '画面のビルド（dist/frontend）がありません。先に、リポジトリのルートで pnpm build を実行してください',
  );
}
createEvaluationApp(process.env, frontendAssetPath).synth();
