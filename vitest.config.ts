import { defineConfig } from 'vitest/config';

/**
 * Vitest の設定（単体・結合テスト）。方針は docs/30_quality/test-policy.md と docs/10_design/functions/dev_spec.md 6章。
 * - node プロジェクト: shared・backend の単体テストと、結合テスト（Hono アプリの app.request）
 * - infra プロジェクト: IaC（AWS CDK。infra/）のテスト。CDK は infra/ の依存のため、テストも infra/test/ に置く
 * - frontend プロジェクト: jsdom 上の React コンポーネントの単体テスト
 * - カバレッジ: 本体コード（src/）全体で、行・分岐・関数・文のすべて 95% 以上（test-policy.md の 90% より厳しい値を採用）。
 *   レポートは ./test-result/coverage に出力する
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'tests/unit/shared/**/*.test.ts',
            'tests/unit/backend/**/*.test.ts',
            'tests/integration/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'infra',
          environment: 'node',
          include: ['infra/test/**/*.test.ts'],
          // CDK の合成（synth）は、数秒かかることがある
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: ['tests/unit/frontend/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/unit/frontend/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './test-result/coverage',
      reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
      include: ['src/**/*.{ts,tsx}', 'infra/lib/**/*.ts', 'infra/lambda/**/*.ts'],
      // 計測の対象外（理由）:
      // - *.d.ts: 型定義のみ
      // - main.tsx / runtime/main.ts / runtime/data-backup-main.ts: 起動のみでロジックを持たないエントリ（結線は node-server.ts・app.tsx・data-backup.ts のテストで検証する）
      // - vite.config.ts: ビルド・開発サーバーの設定ファイル
      // （infra/bin/ は、環境変数を渡して lib/ を呼ぶだけのエントリのため、include に含めない）
      exclude: [
        'src/**/*.d.ts',
        'src/frontend/main.tsx',
        'src/backend/runtime/main.ts',
        'src/backend/runtime/data-backup-main.ts',
        'src/frontend/vite.config.ts',
      ],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
