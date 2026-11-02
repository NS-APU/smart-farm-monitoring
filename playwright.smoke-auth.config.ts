import { defineConfig } from '@playwright/test';
import { readSmokeEnv } from './tests/smoke/support/smoke-env.ts';

/**
 * Playwright の設定（サーバーレス環境（評価環境）に対する、認証の確認。`pnpm test:smoke:auth`。Issue #243〜#245）。
 * - 接続先・ログインするユーザー（管理者）は、スモークテストと同じ環境変数（SMOKE_BASE_URL・SMOKE_USER_ID・SMOKE_PASSWORD。
 *   tests/smoke/support/smoke-env.ts）で渡す。サーバーは起動しない。**手動で実行する**（CI には載せない）
 * - 性能の実測（`playwright.smoke.config.ts`。結果ログ test-result/smoketest.result.log を出力する）とは、設定を分ける
 *   （この確認は、計測をしないため、結果ログを上書きしない）。確認用のユーザーを、環境に作り、終わりに削除する
 * - テストは tests/smoke/auth/auth-NN-<英語の概略名>.ts。動画・トレースは取らない（パスワードが、記録に残るため）
 */

const env = process.env.SMOKE_BASE_URL === undefined ? undefined : readSmokeEnv();

export default defineConfig({
  testDir: './tests/smoke/auth',
  testMatch: /auth-\d{2}-[a-z0-9-]+\.ts$/,
  outputDir: './test-result/smoke-auth/output',
  fullyParallel: false,
  workers: 1,
  timeout: 5 * 60_000,
  reporter: [['list']],
  use: {
    ...(env === undefined ? {} : { baseURL: env.baseUrl }),
    video: 'off',
    screenshot: 'off',
    trace: 'off',
  },
});
