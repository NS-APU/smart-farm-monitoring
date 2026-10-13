import { defineConfig, devices } from '@playwright/test';
import { DEV_BACKEND_PORT, DEV_FRONTEND_PORT } from './dev-ports.ts';
import { STRESS_USER } from './tests/stress/support/scale.ts';

/**
 * Playwright の設定（負荷テスト `pnpm test:stress`）。方針は docs/10_design/functions/dev_spec.md 6章。
 * - 大量の合成データ（1年分・約60万件の観測値など）を、バックエンドの起動時に投入して、End to End（ブラウザの操作）で、
 *   ユースケース（UC-01〜UC-24）の全操作の応答時間・次の操作が可能になるまでの時間を計測する（tests/stress/）
 * - 結果は、./test-result/stresstest.result.log（globalTeardown が、テストの失敗の有無によらず出力する）
 * - 通常の `pnpm test`（単体・結合・E2E）には含めない。ポート（dev-ports.ts）は E2E と同じため、同時に実行しない
 * - フロントエンドは、本番と同じ最適化（vite build）の成果物を、vite preview で配信する（開発サーバーは、モジュールを
 *   1つずつ配信するため、初期表示の時間が本番と異なる）
 */

const BACKEND_PORT = DEV_BACKEND_PORT;
const FRONTEND_PORT = DEV_FRONTEND_PORT;
const FRONTEND_DIST = '../../test-result/stress/dist';
/** 開発中の確認用: 起動済みのサーバーを使う（STRESS_REUSE_SERVER=1。通常の実行では使わない）。 */
const REUSE_SERVER = process.env.STRESS_REUSE_SERVER === '1';

export default defineConfig({
  testDir: './tests/stress',
  // tests/e2e の UC-NN-*.ts・scenario-*.ts とは別の名前（stress-NN-*.ts）
  testMatch: /stress-\d{2}-[a-z0-9-]+\.ts$/,
  outputDir: './test-result/stress/output',
  fullyParallel: false,
  workers: 1,
  // 全操作を1つのテストで通すため、時間がかかる（シナリオごとに、30分を上限とする）
  timeout: 30 * 60_000,
  // 画面の応答の待ちの上限。許容時間（limits.ts）より十分に長くし、遅い操作も、時間を記録して、許容時間の超過として判定する
  expect: { timeout: 30_000 },
  reporter: [['list'], ['html', { outputFolder: './test-result/stress/report', open: 'never' }]],
  globalSetup: './tests/stress/support/global-setup.ts',
  globalTeardown: './tests/stress/support/global-teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${String(FRONTEND_PORT)}`,
    // 操作・遷移の待ちの上限（応答しない操作を、長く待たずに、NG として記録する）
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    video: 'off',
    screenshot: 'off',
    trace: 'off',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: [
    {
      // 起動の直後に、大量の合成データを投入する。投入が終わると、`STRESS_SEED_DONE` を標準出力に出す
      command:
        'node --max-old-space-size=8192 --disable-warning=ExperimentalWarning tests/stress/support/stress-server.ts',
      wait: { stdout: /STRESS_SEED_DONE/ },
      stdout: 'pipe',
      reuseExistingServer: REUSE_SERVER,
      timeout: 10 * 60_000,
      env: {
        APP_MODE: 'test',
        // 開発用 API（時計・モック・ジョブの起動）は、既定で無効。UI のないユースケースの計測のため、明示的に有効にする
        DEV_API_ENABLED: 'true',
        TRUSTED_PROXY_HOPS: '1',
        PORT: String(BACKEND_PORT),
        PERSISTENCE: 'memory',
        FILE_SERVER_DIR: 'test-result/stress/file-server',
        SEED_MODE: 'NONE',
        INITIAL_USER_ID: STRESS_USER.userId,
        INITIAL_USER_NAME: STRESS_USER.userName,
        INITIAL_USER_PASSWORD: STRESS_USER.password,
        LOG_LEVEL: 'warn',
        INGESTION_RETRY_BASE_DELAY_MS: '10',
        // Web Push の公開鍵（ダミー）。ブラウザの購読は、負荷テストではスタブにする
        WEB_PUSH_PUBLIC_KEY:
          'ZHVtbXktd2ViLXB1c2gtcHVibGljLWtleS1mb3ItZTJlLTAxMjM0NTY3ODktYWJjZGVmZ2hpamtsbW5vcC1xcnM',
      },
    },
    {
      // pnpm 経由ではなく、Vite を直接起動する（Windows のシェルで pnpm の解決に失敗することがあるため）
      command: `node ../../node_modules/vite/bin/vite.js build --outDir ${FRONTEND_DIST} --emptyOutDir && node ../../node_modules/vite/bin/vite.js preview --outDir ${FRONTEND_DIST} --host 127.0.0.1 --port ${String(FRONTEND_PORT)} --strictPort`,
      cwd: 'src/frontend',
      url: `http://127.0.0.1:${String(FRONTEND_PORT)}`,
      reuseExistingServer: REUSE_SERVER,
      timeout: 5 * 60_000,
    },
  ],
});
