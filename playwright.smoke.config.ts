import { defineConfig, devices } from '@playwright/test';
import { readSmokeEnv } from './tests/smoke/support/smoke-env.ts';

/**
 * Playwright の設定（サーバーレス環境（評価環境）に対するスモークテスト・性能の実測。`pnpm test:smoke`。Issue #79）。
 * - 接続先・ログインするユーザーは、環境変数で渡す（SMOKE_BASE_URL・SMOKE_USER_ID・SMOKE_PASSWORD。tests/smoke/support/smoke-env.ts）。
 *   サーバーは起動しない（AWS 上の環境を使う）。**手動で実行する**（CI には載せない。評価する人が使う環境への、予告のない書き込みを避けるため）
 * - テストは tests/smoke/smoke-NN-<英語の概略名>.ts。計測と許容時間は、負荷テストと同じ部品（tests/stress/support/）を使う
 * - 結果は、./test-result/smoketest.result.log（globalTeardown が、テストの失敗の有無によらず出力する）
 * - 動画・トレースは取らない（ログインのパスワードが、記録に残るため）
 */

// 計測の記録の出力先を、負荷テストと分ける（tests/stress/support/recorder.ts が読む。ワーカーにも引き継がれる）
process.env.MEASURE_OUTPUT_DIR = 'test-result/smoke';

// 設定の読み込み時に、環境変数の不足を、分かりやすいエラーにする（--list など、接続しない操作のときは、未設定でも読み込めるようにする）
const env = process.env.SMOKE_BASE_URL === undefined ? undefined : readSmokeEnv();

export default defineConfig({
  testDir: './tests/smoke',
  testMatch: /smoke-\d{2}-[a-z0-9-]+\.ts$/,
  outputDir: './test-result/smoke/output',
  fullyParallel: false,
  workers: 1,
  // 実測は、画面の操作を繰り返すため、時間がかかる
  timeout: 10 * 60_000,
  // 画面の応答の待ちの上限。許容時間（limits.ts）より十分に長くし、遅い操作も、時間を記録して、許容時間の超過として判定する
  expect: { timeout: 30_000 },
  reporter: [['list'], ['html', { outputFolder: './test-result/smoke/report', open: 'never' }]],
  globalSetup: './tests/smoke/support/global-setup.ts',
  globalTeardown: './tests/smoke/support/global-teardown.ts',
  use: {
    ...(env === undefined ? {} : { baseURL: env.baseUrl }),
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
});
