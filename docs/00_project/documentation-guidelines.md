# ドキュメント運用ルール

目的: ドキュメントの置き場所・書き方・更新の決まりを定める。

ディレクトリごとの役割は [directory-structure.md](./directory-structure.md)、ファイル一覧は [document-index.md](./document-index.md) を参照する。

## 置き場所

- 新しいドキュメントは、内容に最も近い番号のディレクトリに置く。迷う場合は関係者に確認する
- サブディレクトリは `10_design/` のみ用意する。それ以外のディレクトリは直下にフラットに置き、ファイルが増えて見通しが悪くなったら相談のうえで分割する
- 空のディレクトリは `.gitkeep` で保持する。最初のドキュメントを追加したら `.gitkeep` は削除する
- コード内コメントには「なぜそうしたか」のみを書く。仕様・設計の説明は `docs/` に書く

## 記述ルール

- 形式は Markdown、言語は日本語とする
- ファイル名は英小文字・ハイフン区切り（例: `data-flow.md`）。ディレクトリは `NN_分類名` 形式（`10_design` 配下のサブディレクトリは分類名のみ）
- 各ドキュメントの冒頭に「目的（この文書で何がわかるか）」を書く
- 1ドキュメント1テーマとし、同じ内容を複数箇所に書かない（重複させず相互リンクで参照する）
- リンクは相対パスで記述する
- 用語は [glossary.md](./glossary.md) の表記に統一する。新しい業務用語・略語を使う場合は先に用語集へ追加する
- 図は Mermaid でテキストとして記述し、差分レビューできるようにする（画像のみの図は避ける）
- 未確定事項は `TODO:` を付けて明記し、推測で埋めない

## 更新ルール

- コードの変更に伴い影響するドキュメントも、同じPR内で更新する
- 変更内容とドキュメントの対応の目安

| 変更内容 | 更新するドキュメント |
|----------|----------------------|
| 機能の追加・仕様変更 | `10_design/requirements/functional-requirements.md`（必要に応じて `use-cases.md`） |
| 構成・コンポーネント・処理の流れの変更 | `10_design/architecture/architecture.md` / `system-overview.md` / `10_design/data/data-flow.md` |
| HITL（人の確認・承認フロー）の変更 | `10_design/architecture/human-in-the-loop.md` |
| 画面・API・処理の振る舞いの変更 | `10_design/functions/functional-specification.md` |
| データ項目・スキーマの変更 | `10_design/data/data-model.md` / `data-dictionary.md` |
| 実装・開発規約・コーディング規約・セキュリティ方針の変更 | `20_development/`（`coding-standards.md` / `security.md`） |
| ロボット・ハウスの健全性の評価観点・判断基準の変更 | `10_design/viewpoint/` |
| テスト方針の変更 | `30_quality/` |
| Git・ブランチ・PR運用、デプロイ・運用手順・リリース手順の変更 | `40_operations/` |
| 技術選定・設計方針の決定や変更 | `10_design/adr/` に新規ADRを追加 |
| ドキュメントの追加・移動・削除 | [document-index.md](./document-index.md)（ディレクトリ構成が変わる場合は [directory-structure.md](./directory-structure.md) も） |
| コマンドの追加・変更 | `00_project/commands.md` |
| 規約・作業ルールの変更 | `AGENTS.md` |

- ドキュメントのみの変更はコミットtype `docs` を使う

## ADR（設計判断の記録）

- 重要な技術選定・設計判断は `docs/10_design/adr/NNNN-タイトル.md`（例: `0001-select-database.md`）として残す
- 記載項目: ステータス（提案/承認/廃止/置換）・背景・決定内容・検討した選択肢・結果（トレードオフ）
- 承認済みADRは書き換えない。判断を変える場合は新しいADRを追加し、旧ADRのステータスを「置換」にする
