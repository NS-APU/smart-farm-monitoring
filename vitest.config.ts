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
          // DynamoDB アダプタのテストが使う、DynamoDB Local（Java）の用意（tests/support/dynamodb-local-global-setup.ts）
          globalSetup: ['tests/support/dynamodb-local-global-setup.ts'],
          // ほかのプロジェクト（CDK のバンドル・jsdom）と並列に動くとき、DynamoDB への往復が遅れることがある
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'infra',
          environment: 'node',
          include: ['infra/test/**/*.test.ts'],
          // CDK の合成（synth）は、数秒かかる（1 つの Lambda のコードのまとめを含む合成で、単独でも約 4〜12 秒）。
          // ほかのプロジェクト（DynamoDB Local を使うテストなど）と同時に動くと、CPU を取り合い、30 秒を超えることがあった。
          // 時間の上限は緩めず、infra のプロジェクトは、ほかのプロジェクトが終わってから動かす（groupOrder）
          testTimeout: 30_000,
          sequence: { groupOrder: 1 },
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
      include: ['src/**/*.{ts,tsx}', 'infra/lib/**/*.ts'],
      // 計測の対象外（理由）:
      // - *.d.ts: 型定義のみ
      // - main.tsx / runtime/main.ts / runtime/data-backup-main.ts / runtime/initial-user-main.ts / runtime/demo-data-main.ts: 起動のみでロジックを持たないエントリ（結線は node-server.ts・app.tsx・data-backup.ts のテストで検証する）
      // - vite.config.ts: ビルド・開発サーバーの設定ファイル
      // （infra/bin/ は、環境変数を渡して lib/ を呼ぶだけのエントリのため、include に含めない）
      exclude: [
        'src/**/*.d.ts',
        'src/frontend/main.tsx',
        'src/backend/runtime/main.ts',
        'src/backend/runtime/data-backup-main.ts',
        'src/backend/runtime/initial-user-main.ts',
        'src/backend/runtime/demo-data-main.ts',
        'src/frontend/vite.config.ts',
      ],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
