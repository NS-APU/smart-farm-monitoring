// ESLint の設定（flat config + typescript-eslint）。方針は docs/20_development/coding-standards.md。
// 書式のルールは Prettier のみで扱う（eslint-config-prettier で競合を無効化）。
// アクセシビリティ（jsx-a11y）のルールは、axe-core（MPL-2.0）に依存する eslint-plugin-jsx-a11y を使わず、oxlint（.oxlintrc.json）で検査する。
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** ドメイン・共通コードが依存してはいけないもの（ADR-0001、coding-standards.md「コードの構成」）。 */
const FRAMEWORK_PATTERNS = [
  {
    group: ['hono', 'hono/*', '@hono/*'],
    message: 'Hono への依存は、提示層（presentation / runtime）に限定します',
  },
  {
    group: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    message: 'React への依存は、フロントエンドに限定します',
  },
  {
    group: ['@aws-sdk/*', 'aws-lambda'],
    message: 'AWS SDK への依存は、インフラ層のアダプタに限定します',
  },
];

/** 内側の層が、外側の層を import してはいけない（依存は内向き。architecture.md 3.2）。 */
const OUTER_LAYER_PATTERNS = [
  {
    group: ['**/infrastructure/**', '**/presentation/**', '**/runtime/**'],
    message:
      'ドメイン・アプリケーション層は、インフラ・提示・実行形態の層に依存させません（ポートを介して使います）',
  },
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'dist/**',
      'test-result/**',
      'coverage/**',
      '.local-data/**',
      'work/**',
      'docs/**',
      // ブラウザへそのまま配信する静的ファイル（サービスワーカー）。TypeScript の対象外
      'src/frontend/public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // enum・namespace は使わない（coding-standards.md「命名規則」「避けること」）
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message:
            'enum は使わず、文字列リテラルのユニオン型、または as const のオブジェクトを使います',
        },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    // ドメイン層・共通コード: フレームワーク・SDK・外側の層に依存しない
    files: ['src/backend/domain/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...FRAMEWORK_PATTERNS,
            ...OUTER_LAYER_PATTERNS,
            {
              group: ['node:*'],
              message: 'ドメイン・共通コードは、Node 標準にも依存させません（純粋なロジックのみ）',
            },
          ],
        },
      ],
    },
  },
  {
    // アプリケーション層: フレームワーク・SDK・外側の層に依存しない
    files: ['src/backend/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...FRAMEWORK_PATTERNS, ...OUTER_LAYER_PATTERNS] },
      ],
    },
  },
  {
    // 提示層: 本番の経路（ハンドラなど）は、インフラ層（アダプタ）に依存しない。
    // 開発用 API（dev-routes.ts・api-deps.ts）のみ、ローカルのアダプタの型・生成関数を使う（as-built D-19）
    files: ['src/backend/presentation/**/*.ts'],
    ignores: ['src/backend/presentation/dev-routes.ts', 'src/backend/presentation/api-deps.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/**'],
              message:
                '本番の経路の提示層は、インフラ層に依存させません（開発用 API の dev-routes.ts・api-deps.ts を除く）',
            },
          ],
        },
      ],
    },
  },
  {
    // フロントエンド: バックエンドの実装に依存しない（共通コードは src/shared を使う）
    files: ['src/frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/backend/**', '@smart-farm/backend', '@smart-farm/backend/*'],
              message: 'フロントエンドは、バックエンドの実装に依存させません',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/backend/**/*.ts', 'tests/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['tests/unit/frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    // テスト: expect.stringContaining など非対称マッチャーの戻り値が any のため、次のルールは使えない
    files: ['tests/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
  {
    // 設定ファイル（JavaScript）は、型情報なしで検査する
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  prettier,
);
