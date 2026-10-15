# ドキュメント一覧

目的: `docs/` 以下のドキュメントの一覧と、それぞれの内容を示す。ドキュメントを追加・移動・削除したら、この表を更新する。

ディレクトリごとの役割は [directory-structure.md](./directory-structure.md) を参照する。

| ディレクトリ | ドキュメント | 内容 |
| --- | --- | --- |
| [00_project](./) | [project-overview.md](./project-overview.md) | プロジェクト全体のオーバービュー |
| | [goals.md](./goals.md) | ゴール・達成したいこと |
| | [glossary.md](./glossary.md) | 用語集 |
| | [directory-structure.md](./directory-structure.md) | ディレクトリ構成 |
| | [commands.md](./commands.md) | よく使うコマンド |
| | [documentation-guidelines.md](./documentation-guidelines.md) | ドキュメント運用ルール |
| | [document-index.md](./document-index.md) | ドキュメント一覧（本書） |
| [10_design/requirements](../10_design/requirements/) | [rfp.md](../10_design/requirements/rfp.md) | RFP（発注者の要求と要件定義への橋渡し） |
| | [functional-requirements.md](../10_design/requirements/functional-requirements.md) | 機能要件 |
| | [non-functional-requirements.md](../10_design/requirements/non-functional-requirements.md) | 非機能要件 |
| | [use-cases.md](../10_design/requirements/use-cases.md) | ユースケース |
| [10_design/architecture](../10_design/architecture/) | [system-overview.md](../10_design/architecture/system-overview.md) | システム全体像 |
| | [architecture.md](../10_design/architecture/architecture.md) | アーキテクチャ設計（設計時＝実装前に作成した記録。実装との関係は as-built.md を参照） |
| | [as-built.md](../10_design/architecture/as-built.md) | 実装に基づくアーキテクチャ（ソースコードの解析結果: 構成・ユースケース・ドメインモデル・処理の流れ・ライフサイクル・アルゴリズム・テスト。設計時との差分と課題を含む） |
| | [human-in-the-loop.md](../10_design/architecture/human-in-the-loop.md) | 人が判断に関与する仕組み（異常のライフサイクル、人の入力と評価への反映） |
| [10_design/data](../10_design/data/) | [data-flow.md](../10_design/data/data-flow.md) | データの流れ |
| | [data-model.md](../10_design/data/data-model.md) | データモデル（論理モデルと DynamoDB の物理設計の案） |
| | [data-dictionary.md](../10_design/data/data-dictionary.md) | データ項目定義（データ辞書） |
| [10_design/functions](../10_design/functions/) | [functional-specification.md](../10_design/functions/functional-specification.md) | 機能仕様書（画面・API・非同期処理の振る舞い） |
| | [dev_spec.md](../10_design/functions/dev_spec.md) | 開発仕様書（ディレクトリ・パッケージ構成、ポート／アダプタ、ローカル実行構成、暫定仕様、UC と画面・API・ジョブの対応、テスト構成） |
| [10_design/viewpoint](../10_design/viewpoint/) | [viewpoint-overview.md](../10_design/viewpoint/viewpoint-overview.md) | 健全性評価の観点（概要・記載形式・観点一覧） |
| | [evaluation.md](../10_design/viewpoint/evaluation.md) | 観点に共通する評価方針 |
| | [robot-health.md](../10_design/viewpoint/robot-health.md) | ロボットの健全性の観点（収穫精度・収穫速度・操作性・メンテナンス性・コスト効率・安全性・耐久性） |
| | [house-health.md](../10_design/viewpoint/house-health.md) | ハウスの健全性の観点（環境適応性） |
| | [operation-health.md](../10_design/viewpoint/operation-health.md) | 評価の運用面の観点（データ活用度合い・満足度） |
| [10_design/adr](../10_design/adr/) | [0001-modular-monolith-ports-and-adapters.md](../10_design/adr/0001-modular-monolith-ports-and-adapters.md) | ADR-0001 モジュラーモノリスとポート・アダプタ構成（提案） |
| | [0002-deployment-serverless.md](../10_design/adr/0002-deployment-serverless.md) | ADR-0002 デプロイ構成は、サーバーレスを基本とする（承認） |
| | [0003-ingestion-adapter-and-provisional-spec.md](../10_design/adr/0003-ingestion-adapter-and-provisional-spec.md) | ADR-0003 取り込みの取得・解釈の分離と仕様の仮決め（提案） |
| | [0004-federation-outbox-standalone.md](../10_design/adr/0004-federation-outbox-standalone.md) | ADR-0004 農業情報基盤との連携を連携キューによる非同期方式にする（提案） |
| | [0005-tech-stack.md](../10_design/adr/0005-tech-stack.md) | ADR-0005 技術スタックを TypeScript・Hono・React・DynamoDB 等で確定する（承認） |
| | [0006-iac-cdk-and-same-origin-delivery.md](../10_design/adr/0006-iac-cdk-and-same-origin-delivery.md) | ADR-0006 IaC に AWS CDK を使い、画面と API を CloudFront の同じオリジンで配信する（承認） |
| | [0007-dynamodb-table-design.md](../10_design/adr/0007-dynamodb-table-design.md) | ADR-0007 DynamoDB のテーブルを、観測値の専用テーブルと、そのほかの集約テーブルに分ける（承認） |
| | （今後追加） | 設計判断の記録（ADR） |
| [20_development](../20_development/) | [coding-standards.md](../20_development/coding-standards.md) | コーディング規約（草案） |
| | [security.md](../20_development/security.md) | セキュリティ・機密情報 |
| [30_quality](../30_quality/) | [test-policy.md](../30_quality/test-policy.md) | テスト方針 |
| | [test.spec.md](../../test-result/test.spec.md)（`test-result/` に置く） | テスト仕様書（E2E・単体・結合・負荷テストの、対応する UC・概要・詳細。UC・FR・NFR との対応） |
| | [stresstest.report.md](../../test-result/stresstest.report.md)（`test-result/` に置く） | 負荷試験の報告（結果のサマリ、採用した許容時間と根拠、データ規模、環境、対応で行ったこと（修正前後の値）、制約・限界） |
| | [stresstest.result.log](../../test-result/stresstest.result.log)（`test-result/` に置く） | 負荷試験の結果ログ（`pnpm test:stress` の最新の実行。操作ごとの応答時間・次の操作が可能になるまでの時間・判定、集計） |
| [40_operations](../40_operations/) | [git-workflow.md](../40_operations/git-workflow.md) | Git・ブランチ・PR運用 |
| | [operations.md](../40_operations/operations.md) | 運用手順（環境ごとの設定・起動停止・ログの見方・異常の通知への対応・定期作業・配信の前提。本番のデプロイ・ロールバックは TODO） |
| | [backup-restore.md](../40_operations/backup-restore.md) | バックアップ・復元の手順（ローカル実行は実装済み。本番は TODO） |
| [50_references](../50_references/) | （今後追加） | 外部資料・参考情報 |
| [.license-check](../../.license-check/)（リポジトリ直下） | [license-report.md](../../.license-check/license-report.md) | 依存パッケージのライセンス確認（コピーレフトの検出と対応、全依存のライセンス別の件数と一覧、配布物に含まれるものの区別）。`docs/` の外に置く |
| [.speccheck](../../.speccheck/)（リポジトリ直下） | UC-01〜UC-24 の整合性チェックレポート（例: [UC-01-view-dashboard.md](../../.speccheck/UC-01-view-dashboard.md)） | ユースケースごとの、要件（use-cases.md・FR・NFR）・設計・実装・テストの対応表と、不足・食い違いの記録（24 ファイル）。`docs/` の外に置く |
