import { defineConfig, devices } from '@playwright/test';
import { DEV_BACKEND_PORT, DEV_FRONTEND_PORT } from './dev-ports.ts';
import { E2E_ROLE_DEFINITIONS_JSON, E2E_USER } from './tests/e2e/support/e2e-user.ts';

/**
 * Playwright の設定（E2E テスト）。方針は docs/10_design/functions/dev_spec.md 6章。
 * - テストは tests/e2e/UC-NN-<英語の概略名>.ts（ユースケースごと）と、tests/e2e/scenario-<英語の概略名>.ts（複数のユースケース・複数の利用者をまたぐシナリオ）
 * - video 撮影は、手元では常に有効にし、出力は ./test-result/ 配下。CI（環境変数 CI がある）では、撮らない（保存せず、捨てていたため。時間がかかる。Issue #185）
 * - バックエンド（ローカルの Node サーバー。メモリ上のデータ・モックの外部サービス・テスト用の時計）と、
 *   フロントエンド（Vite の開発サーバー）を起動して、AWS なしで動かす
 */

const BACKEND_PORT = DEV_BACKEND_PORT;
const FRONTEND_PORT = DEV_FRONTEND_PORT;
const IN_CI = (process.env.CI ?? '') !== '';

export default defineConfig({
  testDir: './tests/e2e',
  // ユースケースごと（例: UC-01-view-dashboard.ts）と、複数のユースケース・複数の利用者をまたぐシナリオ（例: scenario-user-onboarding.ts）
  testMatch: /(?:UC-\d{2}|scenario)-[a-z0-9-]+\.ts$/,
  outputDir: './test-result/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: './test-result/playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${String(FRONTEND_PORT)}`,
    video: IN_CI ? 'off' : { mode: 'on', size: { width: 1280, height: 720 } },
    screenshot: 'on',
    trace: 'retain-on-failure',
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
      command: 'node --disable-warning=ExperimentalWarning src/backend/runtime/main.ts',
      url: `http://127.0.0.1:${String(BACKEND_PORT)}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        APP_MODE: 'test',
        // 開発用 API（時計・モック・リセット）は、既定で無効。E2E では、明示的に有効にする
        DEV_API_ENABLED: 'true',
        // ログインの試行回数の制限は、接続元ごと。E2E は、X-Forwarded-For（1段のプロキシが付けた値とみなす）で、テストごとに接続元を分ける
        TRUSTED_PROXY_HOPS: '1',
        PORT: String(BACKEND_PORT),
        PERSISTENCE: 'memory',
        FILE_SERVER_DIR: 'test-result/e2e-file-server',
        SEED_MODE: 'NONE',
        INITIAL_USER_ID: E2E_USER.userId,
        INITIAL_USER_NAME: E2E_USER.userName,
        INITIAL_USER_PASSWORD: E2E_USER.password,
        LOG_LEVEL: 'warn',
        INGESTION_RETRY_BASE_DELAY_MS: '10',
        // ロール: 農作業者（全権限）と閲覧者（権限なし）。権限による表示・操作の制限を、E2E で確かめる
        ROLE_DEFINITIONS_JSON: E2E_ROLE_DEFINITIONS_JSON,
        INITIAL_USER_ROLE: 'worker',
        // Web Push の公開鍵（ダミー）。ブラウザの購読は、E2E ではスタブにする
        WEB_PUSH_PUBLIC_KEY:
          'ZHVtbXktd2ViLXB1c2gtcHVibGljLWtleS1mb3ItZTJlLTAxMjM0NTY3ODktYWJjZGVmZ2hpamtsbW5vcC1xcnM',
      },
    },
    {
      // pnpm 経由ではなく、Vite を直接起動する（Windows のシェルで pnpm の解決に失敗することがあるため）
      command: 'node ../../node_modules/vite/bin/vite.js',
      cwd: 'src/frontend',
      url: `http://127.0.0.1:${String(FRONTEND_PORT)}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
