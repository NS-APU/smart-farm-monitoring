# ADR-0005 技術スタックを TypeScript・Hono・React・DynamoDB 等で確定する

- ステータス: 承認（提案した候補で確定する。パッチバージョンは実装の開始時に確定する）
- 日付: 2026-10-09
- 関連: [architecture.md](../architecture/architecture.md) 13章、[ADR-0001](./0001-modular-monolith-ports-and-adapters.md)、[ADR-0002](./0002-deployment-serverless.md)、RQ-016〜RQ-021 / NFR-1, NFR-2, NFR-8

## 背景

- 技術スタックは、AGENTS.md から architecture.md を参照する方針で、architecture.md 13章に提案としてまとめていた。サーバーレス構成を基本とすること（ADR-0002）が決まったため、提案した候補を確定する
- 選定の基準は、(1) 低コストで動くこと、(2) 少人数で保守できること、(3) テストしやすいこと、(4) ライセンス・サポートの見通し、(5) `src/shared/` で共通コードを持てること

## 決定

| 区分 | 採用技術 |
|------|----------|
| 言語 | TypeScript（Node.js 24 LTS）。Lambda のランタイムも Node.js |
| バックエンド | Hono（軽量なHTTPフレームワーク。Lambda の関数のURLに適合する） |
| フロントエンド | React + Vite の SPA（PWA） |
| DB | DynamoDB（Repository のポートの裏に置く） |
| インフラ・ホスティング | AWS サーバーレス（Amplify Hosting、Lambda、DynamoDB、Cognito、EventBridge）。ADR-0002 |
| IaC・CI/CD | Amplify Gen 2（CDK ベース）。許されない場合は AWS CDK（TypeScript） |
| 認証 | Amazon Cognito（AuthPort のアダプタ） |
| パッケージ管理 | pnpm |
| テスト | 単体・結合: Vitest、E2E: Playwright |
| Formatter / Linter | Prettier、ESLint（flat config + typescript-eslint） |

- バージョンは、メジャーバージョンまでを architecture.md 13.1 に示す。パッチバージョンは、実装の開始時に、各パッケージの公式のレジストリで確認し、ロックファイルで固定する
- Formatter / Linter は、Prettier と ESLint（typescript-eslint）とする。詳細は [coding-standards.md](../../20_development/coding-standards.md)
- バックエンドのフレームワークは、提案で「Fastify または Hono」としていたが、Lambda での動作が軽く、サーバーレス構成に適合する Hono を選んだ

## 検討した選択肢

| 区分 | 採用 | 代替 | 採らなかった理由 |
|------|------|------|------------------|
| 言語 | TypeScript | Python | フロント・バックで型・検証・判定ロジックを共有できる（`src/shared/`）。画面と一体で保守できる。Python は、データ分析のライブラリが豊富で、高度な分析（RQ-006 のインサイト）では有利な可能性があるが、閾値判定・集計が中心の本システムでは、共通コードの利点を優先した。分析が必要になった場合は、別の関数として追加できる |
| バックエンド | Hono | Fastify | Fastify は、常駐のサーバーを前提とした設計で、Lambda では起動・アダプタの手間が増える |
| フロントエンド | React + Vite | Vue、サーバー側の画面生成 | エコシステムが大きく、PWA・Web Push に対応しやすい。Amplify Hosting との相性がよい |
| DB | DynamoDB | SQLite、PostgreSQL | 無料枠・少額で、固定費がない（ADR-0002）。SQLite は代替の1台の構成でのみ、PostgreSQL は常時のメモリ・運用が必要で採らない |
| パッケージ管理 | pnpm | npm | ディスク・インストール時間の効率がよい。ただし、メジャーバージョンの更新では互換性を確認する |
| テスト | Vitest、Playwright | Jest | Vite・TypeScript との統合がよい。E2E は、ブラウザの自動操作の標準的な選択 |

## 結果・トレードオフ

- 言語を TypeScript に統一することで、ドメインの判定ロジックを、フロントとバックで共有できる。一方、データ分析の用途では、Python に比べてライブラリが少ない
- Hono は、Fastify に比べて、プラグインやドキュメントの量が少ない。ポートとアダプタ（ADR-0001）により、フレームワークへの依存は、提示層に限定する
- DynamoDB は、期間の集計が苦手なため、評価の事前計算とアプリ側の集計で対応する。FR-6.5 を満たせるか、実装前に検証する（ADR-0002）
- バージョンの情報は、第三者の記事にもとづく（TypeScript は6系・7系の情報が混在し、pnpm は大きな書き換えを伴うメジャーバージョンの情報がある）。実装の開始時に確認が必要
- 技術スタックを変更する場合は、新しい ADR を追加する
