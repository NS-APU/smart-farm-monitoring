# Git・ブランチ・PR運用

目的: ブランチ戦略、コミットメッセージ規約、PRの作り方、レビュー観点、AIエージェントが勝手に行ってはいけない操作を定める。

## ブランチ戦略（git-flow）

| ブランチ | 役割 | 派生元 | マージ先 | 命名例 |
|----------|------|--------|----------|--------|
| `main` | 本番リリース済みのコード。常にデプロイ可能な状態を保つ | - | - | `main` |
| `develop` | 次回リリースに向けた開発の統合ブランチ | `main` | `release/*` | `develop` |
| `feature/*` | 機能追加・改善 | `develop` | `develop` | `feature/123-sensor-dashboard` |
| `release/*` | リリース準備（バージョン更新・最終バグ修正のみ） | `develop` | `main` と `develop` | `release/1.2.0` |
| `hotfix/*` | 本番の緊急バグ修正 | `main` | `main` と `develop` | `hotfix/1.2.1-fix-alert-crash` |

- ブランチ名は `種別/作業名`（英小文字・ハイフン区切り）とする
- `main` と `develop` への直接コミット・直接pushは禁止。必ずPR経由でマージする
- `release/*` では新機能を追加しない（バグ修正・ドキュメント・バージョン更新のみ）
- `main` へのマージ時はタグ `vX.Y.Z` を付与する（セマンティックバージョニング）
- `release/*`・`hotfix/*` を `main` にマージしたら、必ず `develop` にも反映する
- マージ済みのブランチは削除する
- 長期間ブランチを放置せず、こまめに `develop` の変更を取り込む（目安: feature は数日〜1週間以内にマージ）

## コミットメッセージ規約（Conventional Commits）

```
<type>(<scope>): <概要（日本語、50文字以内目安）>

<本文: 変更の理由・背景（任意）>

<フッター: 関連Issue（例: Refs #123 / Closes #123）>
```

| type | 用途 |
|------|------|
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `docs` | ドキュメントのみの変更 |
| `style` | 動作に影響しない書式変更（空白・フォーマット等） |
| `refactor` | 機能追加・バグ修正を伴わないコード改善 |
| `perf` | パフォーマンス改善 |
| `test` | テストの追加・修正 |
| `build` / `ci` | ビルド設定・CI設定の変更 |
| `chore` | その他の雑務（依存更新など） |

- 1コミット = 1つの論理的な変更とする（無関係な変更を混ぜない）
- 「何を」より「なぜ」を本文に書く
- 破壊的変更はtypeの後ろに `!` を付け、フッターに `BREAKING CHANGE:` を記載する
- 例: `feat(sensor): 土壌水分センサーの閾値アラートを追加`

## Issue の起票

- Issue は `.github/ISSUE_TEMPLATE/` のテンプレートから起票する（空の Issue は無効にしている）

| テンプレート | 用途 | ラベル |
|--------------|------|--------|
| バグ報告（`bug_report.yml`） | 期待と異なる動作・不具合 | `bug` |
| 機能要望・改善提案（`feature_request.yml`） | 新機能・既存機能の改善 | `enhancement` |
| タスク（`task.yml`） | リファクタリング・テスト・ドキュメント・CI・依存更新など | `task` |

- ラベル `bug`・`enhancement`・`task` は、リポジトリに作成しておく（未作成だとラベルは付かない）
- 秘密情報・個人情報・実データは、本文・ログ・画像に含めない
- ブランチ名・PR の関連 Issue には、Issue 番号を使う（例: `feature/123-sensor-dashboard`、`Closes #123`）

## Projects（Sprint）の使い方

作業の管理は、GitHub Projects（NS-APU 組織の [Projects #2](https://github.com/orgs/NS-APU/projects/2)）で行う。Sprint は 1 週間ごと（Sprint 1 は 2026-10-12 開始）。

- Issue を起票したら、Projects に追加し、**Sprint・Assignee・Status** を設定する。取り組む Sprint の Issue は、Status を Ready にする
- Status の進め方:

  | Status | 意味 | 変える時期 |
  |--------|------|------------|
  | Backlog | まだ Sprint に入れていない | 起票時（Sprint 未定） |
  | Ready | 着手できる（前提のタスクがない・内容が決まっている） | Sprint に入れたとき |
  | In progress | 作業中（ブランチを切った後） | 着手時 |
  | In review | PR を作成し、レビュー・CI・マージを待っている | PR の作成時 |
  | Done | マージして、Issue を閉じた | Issue のクローズ時（自動で変わる） |

- Issue の「作業内容」「完了条件」のチェックリストは、次のとおり更新する
  - PR を作成したときに、達成した項目にチェックを付ける（PR のマージを条件とする項目は除く）
  - マージされたことを確認してから、「PR をマージした」の項目にチェックを付け、Issue を閉じる（PR の本文に `Closes #123` があれば、マージで自動的に閉じる。`Refs #123` の場合は、手で閉じる）
- ラベルは、`task`・`bug`（Issue の種別）と、`ci:full`（PR に付けて、E2E・負荷テストを実行する。上の「PRの作り方」）。PR には、Issue と同じ Assignee を設定する
- Sprint の終わりに、Sprint の振り返り（レトロスペクティブ）を行い、見つかった課題・ルールの見直しを、次の Sprint に反映する

## PRの作り方

- PR は `.github/pull_request_template.md` のテンプレートに沿って書く（下記の記載事項と、チェックリストを含む）
- PRのマージ先は原則 `develop`（`release/*`・`hotfix/*` は `main`）
- タイトルはコミットメッセージ規約に準拠する
- 本文には以下を記載する
  - 概要（何を・なぜ変更したか）
  - 関連Issue
  - 変更内容の要点
  - テスト方法・確認結果
  - スクリーンショット（UI変更時）
  - レビュアーに特に見てほしい点
- PRは小さく保つ（目安: 差分400行以内）。大きくなる場合は分割する
- 作業途中で共有する場合はDraft PRにする
- **PR の前に、開発サイトで動作確認できる**（任意。Issue #131）: GitHub の Actions → 「Deploy development」→ Run workflow → 「Use workflow from」で、作業ブランチ（`feature/*`・`release/*`・`hotfix/*`）を選ぶ（`gh workflow run deploy-development.yml --ref <ブランチ>` でも可）。確認した結果は、PR の「テスト・確認結果」に書く。開発サイトは 1 つで、デプロイしたブランチの内容に置き換わる（IaC・データの変更も入る）。確認のあとは、`develop` をデプロイして戻す。手順は、operations.md 8.3
- **`develop` へのマージで、開発サイトが自動デプロイされる**（Issue #89）。上の「PR の前の動作確認」で、別のブランチをデプロイしている間は、`develop` にマージしない（マージすると、確認中の内容が `develop` の内容に置き換わる）。`main` へのマージ（リリース・hotfix）では、本番サイトのデプロイが始まり、承認者の承認を待つ（operations.md 9.3）
- CI（`.github/workflows/ci.yml`）がすべて成功していることをマージ条件とする。マージ先ごとの必須のチェックは、次のとおり（ブランチ保護で必須に設定する）

  | マージ先 | 必須のチェック（ジョブ名） | 内容 |
  |----------|----------------------------|------|
  | `develop` | `lint`・`typecheck`・`unit-test`・`build` | Lint（ESLint・oxlint）と整形（Prettier）、型検査、単体・結合テスト（カバレッジの閾値つき）、ビルド |
  | `main`（`release/*`・`hotfix/*`） | 上記に加えて、`e2e`・`stress` | E2E テスト（約 45 分）と、負荷テスト（約 2 分） |

  - `e2e`・`stress` は、`main` 宛ての PR で実行する。`develop` 宛ての PR でも、ラベル `ci:full` を付けると実行できる（長いため、必要なときだけ付ける）
  - `e2e`・`stress` は、速いチェック（`lint`・`typecheck`・`unit-test`・`build`）が成功してから始まる
- マージ方式: `feature/*` → `develop` は Squash merge、`release/*`・`hotfix/*` → `main` は Merge commit（履歴を保持）
- ラベル `ci:full` は、PR を作る時に付けるか、PR を作ってから少し待って付ける。ブランチを push した直後に付けると、ラベルのない実行が残り、`e2e`・`stress` が実行されない（skipped になる）ことがある（その場合は、もう一度 push するか、`ci:full` を付け直す）

## ブランチ保護（Rulesets）

`main` と `develop` は、GitHub の Rulesets（Settings → Rules → Rulesets）で保護する。上の決まり（直接 push の禁止・CI の成功・マージ方式）を、設定で強制する（Issue #59）。

| 設定 | `develop` | `main` |
|------|-----------|--------|
| 直接 push（PR を経由しない変更） | 禁止（PR 必須） | 禁止（PR 必須） |
| 強制 push・ブランチの削除 | 禁止 | 禁止 |
| 必須のステータスチェック | `lint`・`typecheck`・`unit-test`・`build` | 左に加えて、`e2e`・`stress` |
| 許可するマージ方式 | Squash merge と Merge commit（通常の PR は Squash。Merge commit は、`release/*`・`hotfix/*` を戻すときだけ使う） | Merge commit のみ |
| 必須のレビューの承認数 | 0 人 | 0 人 |
| マージ前に、ブランチを最新にする要求 | しない | しない |
| 管理者のバイパス | なし | なし |

- 承認数を 0 人にしているのは、現在のチームの運用（作成者がマージする）を止めないため。レビューの担当者が増えたら、1 人以上に引き上げる
- 「ブランチを最新にする」を要求しないのは、取り込みのように、順にマージする運用で、毎回の更新と再実行（E2E は約 20 分）が必要になるため。CI が成功していれば、マージできる
- 管理者にも適用する。緊急時は、ルールを一時的に無効にして対応する（変更の履歴が残る）
- 必須のチェックの名前は、`.github/workflows/ci.yml` のジョブ名と同じにする。ジョブ名を変えたら、Rulesets の設定も合わせて変える
- `develop` で Merge commit を許可するのは、`release/*`・`hotfix/*` を `main` にマージしたあと、`develop` へ戻すため（`main` のマージ履歴を取り込む。git-flow）。通常の `feature/*` の PR は、Squash merge にする（これは設定では強制せず、運用で守る）
- マージ後のブランチは、自動で削除される（リポジトリの設定 `delete_branch_on_merge`）

## レビュー観点

- 要件・Issueの内容を満たしているか
- バグ・エッジケース・エラーハンドリングの漏れがないか
- テストが追加・更新されているか
- 既存のコーディング規約・設計方針に沿っているか
- 秘密情報や個人情報が含まれていないか
- パフォーマンス・セキュリティ上の懸念がないか
- 影響するドキュメントが更新されているか

## AIエージェントが勝手に行ってはいけない操作

AIエージェントが守るルールは [AGENTS.md](../../AGENTS.md) の「11. Git・ブランチ・PR運用」に定める（二重管理を避けるため、ここには書かない）。
