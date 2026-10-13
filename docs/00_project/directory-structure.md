# ディレクトリ構成

目的: リポジトリ全体と `docs/` のディレクトリ構成、および各ディレクトリの役割を示す。

## リポジトリ全体

```text
smart-farm-monitoring/
├── .github/       # GitHub 設定（ISSUE_TEMPLATE/ の Issue テンプレート、pull_request_template.md の PR テンプレート）
├── docs/          # ドキュメント
├── src/
│   ├── backend/   # バックエンド（Hono）
│   │   ├── domain/          # ドメイン層（評価エンジン・通知の規則など。純粋なロジック）
│   │   ├── application/     # アプリケーション層（ユースケース）とポート（ports/）
│   │   ├── infrastructure/  # インフラ層（ポートのアダプタ。local/（repositories/ に集約ごとの Repository）・format-profiles/・logging/）
│   │   ├── presentation/    # 提示層（Hono アプリ・ルート・領域ごとのハンドラ・認証認可・共通エラー）
│   │   └── runtime/         # 実行形態（設定・組み立て・Node サーバー・Lambda ハンドラ・終了処理 shutdown.ts・バックアップのコマンドの入口）
│   ├── frontend/  # フロントエンド（React + Vite の SPA。pages/・components/・hooks/・api/・auth/・router/・push/・i18n/・styles/、public/＝サービスワーカー・マニフェスト）
│   └── shared/    # 共通コード（constants/・schemas/ の定数・Zod スキーマ・型、errors.ts・time.ts・omit-undefined.ts・criteria-text.ts などの補助）
├── scripts/       # 補助スクリプト
├── .license-check/  # 依存パッケージのライセンス確認のレポート（license-report.md。コピーレフトの検出と対応、全依存の一覧）
├── tests/
│   ├── unit/          # 単体テスト（src/ と同じ階層構成: backend・frontend・shared）
│   ├── integration/   # 結合テスト
│   ├── e2e/           # E2E テスト（Playwright。UC-NN-<英語の概略名>.ts と scenario-<英語の概略名>.ts。補助は support/）
│   ├── stress/        # 負荷テスト（Playwright。stress-NN-<英語の概略名>.ts。補助は support/: データ規模 scale.ts・データ投入 seed-data.ts・サーバー起動 stress-server.ts・許容時間 limits.ts・計測 recorder.ts・結果ログ report-log.ts・手動入力の計測日時 observed-at.ts など）
│   ├── fixtures/      # テストデータ（合成データ。ファイルサーバーのモック用のファイル）
│   └── support/       # テストの補助（組み立て・データ生成・API のスタブ。画面の単体テスト用は frontend.ts・management-frontend.ts）
├── test-result/   # テストの出力（Git 管理外。カバレッジ・動画・レポート）。例外として、テスト仕様書 test.spec.md と負荷テストの結果（stresstest.result.log・stresstest.report.md）は Git 管理
├── dist/          # ビルドの出力（Git 管理外）
└── .local-data/   # ローカル実行のデータ（Git 管理外。ファイル永続化・ファイルサーバーのモック）
```

各ディレクトリの詳細（層の責務・パッケージ・テスト）は [dev_spec.md](../10_design/functions/dev_spec.md) 1章・2章・6章を参照する。

ルート直下の主なファイルは次のとおり。

| ファイル | 役割 |
|----------|------|
| `README.md` | プロジェクトの入口（概要・目的・ドキュメントへの案内・ライセンス） |
| `AGENTS.md` | AIエージェント向けの作業ルール。詳細は `docs/` に書き、ここからは参照のみとする |
| `.env.example` | 必要な環境変数の一覧（値はダミー） |
| `.gitignore` | Git管理対象外のファイルの定義 |
| `package.json`・`pnpm-workspace.yaml`・`pnpm-lock.yaml` | pnpm ワークスペース（ルートはツール類、`src/` 配下の3つがアプリのパッケージ）とスクリプト |
| `tsconfig.json` | TypeScript の共通設定（各パッケージが継承） |
| `eslint.config.js`・`.oxlintrc.json`・`.prettierrc`・`.prettierignore`・`.editorconfig` | Lint（ESLint と、アクセシビリティ用の oxlint）・フォーマットの設定 |
| `vitest.config.ts`・`playwright.config.ts`・`playwright.stress.config.ts` | 単体・結合テスト（カバレッジ）、E2E テスト、負荷テスト（`pnpm test:stress`）の設定 |
| `dev-ports.ts` | 開発サーバーのポート（Vite 5173・バックエンド 8787）。`playwright.config.ts` と `src/frontend/vite.config.ts` が共有する |

## docs/ の構成

```text
docs/
├── 00_project/       # プロジェクト全般・管理
├── 10_design/        # 設計
│   ├── requirements/   # 要件（RFP・機能・非機能・ユースケース）
│   ├── architecture/   # アーキテクチャ・システム構成・HITL
│   ├── data/           # データの流れ・データモデル・データ項目定義
│   ├── functions/      # 機能（画面・API・処理の振る舞い）
│   ├── viewpoint/      # ロボット・ハウスの健全性の評価観点・判断基準
│   └── adr/            # 設計判断の記録（ADR）
├── 20_development/   # 実装・開発規約
├── 30_quality/       # テスト・品質保証
├── 40_operations/    # 運用・保守・リリース
└── 50_references/    # 外部資料・参考情報
```

| ディレクトリ | 内容 | 置くもの（例） |
|--------------|------|----------------|
| [00_project](./) | プロジェクト全般・管理 | 概要、ゴール、用語集、よく使うコマンド、ディレクトリ構成、ドキュメント運用、ドキュメント一覧 |
| [10_design/requirements](../10_design/requirements/) | 要件（何を作るか） | RFP、機能要件、非機能要件、ユースケース |
| [10_design/architecture](../10_design/architecture/) | 基本設計・構成（どう作るか） | システム全体像、アーキテクチャ設計（設計時）、実装に基づくアーキテクチャ（as-built） |
| [10_design/data](../10_design/data/) | データ設計 | データの流れ、データモデル、データ項目定義 |
| [10_design/functions](../10_design/functions/) | 機能ごとの仕様（各機能がどう動くか） | 機能仕様書 |
| [10_design/viewpoint](../10_design/viewpoint/) | ロボット・ハウスの健全性の評価観点・判断基準 | 評価観点、判断基準（閾値・区分）、基準の根拠 |
| [10_design/adr](../10_design/adr/) | 設計判断の記録（ADR） | `NNNN-タイトル.md` |
| [20_development](../20_development/) | 実装・開発規約 | コーディング規約、セキュリティ・機密情報、開発環境構築手順 |
| [30_quality](../30_quality/) | テスト・品質保証 | テスト計画、テスト方針 |
| [40_operations](../40_operations/) | 運用・保守・リリース | Git・ブランチ・PR運用、運用手順（operations.md）、バックアップ・復元（backup-restore.md）、デプロイ手順、リリース手順 |
| [50_references](../50_references/) | 外部資料・参考情報 | 論文、外部仕様書、調査メモ |

- ファイル単位の一覧は [document-index.md](./document-index.md) を参照する
- ドキュメントの置き方・書き方・更新の決まりは [documentation-guidelines.md](./documentation-guidelines.md) を参照する
