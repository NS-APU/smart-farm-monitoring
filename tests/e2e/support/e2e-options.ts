/**
 * E2E の実行の設定（環境変数）。playwright.config.ts と、補助（app.ts）が共有する（Issue #519）。
 * - `E2E_VIDEO=1`: 動画を撮る（既定は撮らない。動画は、撮影のために、全体の所要時間が約 2 割延びる）
 * - `E2E_DEV_SERVER=1`: フロントエンドを、Vite の開発サーバーで配信する（既定は、本番ビルドを `vite preview` で配信する）
 * - `E2E_FRONTEND_DIST`: ビルド済みのフロントエンドのディレクトリ（絶対パス）。指定すると、ビルドせずに、これを配信する
 *   （`pnpm test:e2e:parallel` が、1 回だけビルドして、全インスタンスに渡す）
 * - `E2E_PORT_OFFSET`: インスタンスごとにポートを分ける値（dev-ports.ts）。出力先も、この値で分ける
 */

import { PORT_OFFSET } from '../../../dev-ports.ts';

/** 動画を撮るか。 */
export const E2E_VIDEO = process.env.E2E_VIDEO === '1';

/** フロントエンドを、Vite の開発サーバーで配信するか（false は、本番ビルドを配信する）。 */
export const E2E_DEV_SERVER = process.env.E2E_DEV_SERVER === '1';

/** ビルド済みのフロントエンドのディレクトリ。未指定なら、undefined。 */
export const E2E_FRONTEND_DIST: string | undefined =
  (process.env.E2E_FRONTEND_DIST ?? '') === '' ? undefined : process.env.E2E_FRONTEND_DIST;

/** 出力先（test-result/ 配下）のディレクトリ名に付ける接尾辞。ポートをずらしたインスタンスだけ、`-<ずらした値>`。 */
export const E2E_INSTANCE_SUFFIX = PORT_OFFSET === 0 ? '' : `-${String(PORT_OFFSET)}`;
