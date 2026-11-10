import { defineConfig } from '@playwright/test';
import { DEV_FRONTEND_PORT } from './dev-ports.ts';
import base from './playwright.config.ts';

/**
 * Playwright の設定（画面の CSP の確認 `pnpm test:csp`。Issue #127。tests/csp/）。
 * - 本番と同じ成果物（vite build）を vite preview で配信し、CSP（infra/lib/content-security-policy.ts。CloudFront の応答ヘッダーポリシーと同じ値）を、
 *   画面の応答に付けて、主な画面を一巡する。CSP の違反が出ないことを確かめる（開発サーバーは、インラインのスクリプトを注入するため、使えない）
 * - バックエンド・ブラウザ・ロケールは、E2E（playwright.config.ts）と同じ。ポート（dev-ports.ts）も同じため、`pnpm test:e2e` と同時に実行しない
 */

const FRONTEND_PORT = DEV_FRONTEND_PORT;
const FRONTEND_DIST = '../../test-result/csp/dist';

const baseServers = Array.isArray(base.webServer) ? base.webServer : [];
const [backend] = baseServers;
if (backend === undefined) {
  throw new Error('playwright.config.ts の webServer（バックエンド）が見つかりません');
}

export default defineConfig({
  ...base,
  testDir: './tests/csp',
  testMatch: /csp-\d{2}-[a-z0-9-]+\.ts$/,
  outputDir: './test-result/csp/output',
  reporter: [['list']],
  use: { ...base.use, video: 'off', screenshot: 'off', trace: 'off' },
  webServer: [
    backend,
    {
      // pnpm 経由ではなく、Vite を直接起動する（Windows のシェルで pnpm の解決に失敗することがあるため）
      command: `node ../../node_modules/vite/bin/vite.js build --outDir ${FRONTEND_DIST} --emptyOutDir && node ../../node_modules/vite/bin/vite.js preview --outDir ${FRONTEND_DIST} --host 127.0.0.1 --port ${String(FRONTEND_PORT)} --strictPort`,
      cwd: 'src/frontend',
      url: `http://127.0.0.1:${String(FRONTEND_PORT)}`,
      reuseExistingServer: false,
      timeout: 5 * 60_000,
    },
  ],
});
