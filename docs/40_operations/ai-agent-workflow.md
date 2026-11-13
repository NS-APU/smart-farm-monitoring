# AI エージェントの作業手順（このプロジェクト固有）

AI エージェントが、このプロジェクトで作業するときの、具体的な手順（コマンド・ファイル名・環境の癖）。共通の行動ルール（確認の取り方・役割分担・報告）は [AGENTS.md](../../AGENTS.md) にある。Issue・ブランチ・コミット・PR の規約は [git-workflow.md](./git-workflow.md)、コマンドの一覧は [commands.md](../00_project/commands.md) にある。ここには、それらに書かれていない、AI エージェントの作業で必要な手順だけを書く。

## 1. Projects（NS-APU の Projects #2）の操作

Status・Sprint の変更は、AI エージェントが自分で行う（AGENTS.md 13 章）。**ID は、この文書に書かない**（反復の ID は、Sprint ごとに変わり、書くとすぐ古くなるため）。次のコマンドで、その都度、取得する。

| 目的 | コマンド |
| ---- | -------- |
| プロジェクトの ID | `gh project view 2 --owner NS-APU --format json --jq .id` |
| フィールドの ID・Status の選択肢（Backlog・Ready・In progress・In review・Done） | `gh project field-list 2 --owner NS-APU --format json` |
| Sprint の反復の ID | `gh api graphql -f query='query { node(id:"<Sprint のフィールド ID>") { ... on ProjectV2IterationField { configuration { iterations { id title startDate } } } } }'` |
| Issue 番号から、項目の ID | `gh project item-list 2 --owner NS-APU --limit 300 --format json --jq '.items[] | select(.content.number==<番号>) | .id'` |
| Issue をプロジェクトに追加 | `gh project item-add 2 --owner NS-APU --url <Issue の URL>` |
| Status を変更 | `gh project item-edit --id <項目の ID> --project-id <プロジェクトの ID> --field-id <Status のフィールド ID> --single-select-option-id <選択肢の ID>` |
| Sprint を設定 | `gh project item-edit --id <項目の ID> --project-id <プロジェクトの ID> --field-id <Sprint のフィールド ID> --iteration-id <反復の ID>` |

- Status は、着手で In progress、PR 作成で In review、マージ確認後に完了条件を確認して Done（Issue を閉じる）。作業の区切りごとに、`item-list` で実際の Status を確認する。
- **Issue を起票してプロジェクトに追加したら、一覧に出るかを、1 回確認する**（`item-list`）。GitHub の不具合で、Issue 側は「登録済み」なのに、一覧に出ないことがある。出ないときは、API で直そうとせず（削除 → 再追加は効かない）、ユーザーに、Web 画面（Issue の右側の Projects）で、プロジェクトを外して再追加するよう依頼する。再追加の後に、Sprint・Status を確認し、必要なら設定し直す。
- `item-list` などの GraphQL を、繰り返し呼ばない（レート制限に当たる）。待つときは、条件を 1 つ確認して、間隔を空ける。
- Sprint のプランニングの Issue には、作業時間・日ごとの進め方・事情を書かない。

## 2. 動作確認・E2E・負荷テストの手順

ポート 8787（バックエンド）・5173（フロントエンド）は、ユーザーの開発サーバーが使う。**止めない・使わない。**

- 動作確認でサーバーを起動するときは、別のポート（例: バックエンド 18787・フロントエンド 15173）を使う。起動の前に、`netstat -ano | grep :<ポート> | grep LISTENING` で、空きを確認する。
- 止めるのは、自分が起動したプロセスだけ。ポート番号から探して止めない。止める前に、PowerShell の `Get-CimInstance Win32_Process` で、コマンドラインが、自分の起動したものと一致することを確認する。Git Bash の `$!` の PID は、Windows の PID と一致しない。
- `/health` などで確認する前に、自分のプロセスが生きていること、起動のログに `EADDRINUSE` がないことを確認する（ユーザーのサーバーの応答を、自分の結果と取り違えない）。
- E2E・負荷テストは、`dev-ports.ts` の `8787` → `18787`、`5173` → `15173` に、一時的に変えて実行する（`sed` など）。終わったら、**`git checkout dev-ports.ts`（と、負荷テストの結果のログ `test-result/stresstest.result.log`）だけ**を戻す。`test-result/` ごと戻さない（編集した `test.spec.md` も消える）。
- E2E の全件は、約 40 分かかる。まず、影響する UC のファイルと、`pnpm test:stress` を実行し、全件は CI（`ci:full`）で確認する。
- 単体・結合テストは、DynamoDB Local が要る（`DYNAMODB_LOCAL_DIR`。手順は [commands.md](../00_project/commands.md)）。`pnpm test:unit --maxWorkers=3`。
- 長い処理（テスト・CI の待機）は、バックグラウンドで実行し、完了の通知を待つ。

## 3. PR の作り方（定型）

- マージ先は `develop`。本文は `.github/pull_request_template.md` に沿う。作成: `gh pr create --base develop --head <ブランチ> --title <タイトル> --body-file <本文のファイル> --label task [--label ci:full] --assignee T-Ishikawa-R`。
- ラベル: コード・テスト・設定を変える PR は `task` + `ci:full`、**docs のみの PR は `task` だけ**。
- `develop` 宛ての PR では、`ci:full` がないと、`e2e`・`stress` は実行されない（skipping）。docs のみの PR では、これが正しい。
- **CI の表示**: 「e2e-shard (${{ matrix.shard }}/4)」が fail（0 秒）と表示されるのは、重複して起動された run（取り消されたもの）の表示で、失敗ではない。判断は、`build`・`lint`・`typecheck`・`unit-test`（`ci:full` の PR は、`stress`・`e2e-shard (1/4)〜(4/4)`・`e2e`）の結果で行う。
- PR 作成後に、Issue のチェックリストを更新し、Status を In review にする（AGENTS.md 13 章）。
- 1 つの Issue を、複数の PR に分けるときは、PR を積まない。各 PR を `develop` 向けにして、前の PR のマージを待つ。

## 4. コードを変えた PR で、更新するドキュメント

テストを追加・変更した PR では、更新対応表（[documentation-guidelines.md](../00_project/documentation-guidelines.md)）に加えて、次を更新する。

| 更新するもの | 内容 |
| ------------ | ---- |
| `test-result/test.spec.md` | 1.2 節の件数の表と内訳、14〜章の索引、追加・変更したテストの章（追加したテストの ID は、仮の ID）、実測 |
| `docs/00_project/commands.md`・`docs/10_design/architecture/as-built.md` | `pnpm test:unit` の件数・E2E の件数・カバレッジの数値 |
| `docs/00_project/document-index.md` | ドキュメントを追加・移動・削除したとき |

件数は、`npx vitest list`（単体・結合）と `npx playwright test --list`（E2E）の結果と、`pnpm test:unit` の実測で確認する。

## 5. 公開リポジトリで、書かないもの

このリポジトリは公開（PUBLIC）。次のものを、リポジトリ・Issue・PR に書かない。ユーザーがチャットで示した値も、書かない。

- 接続先のホスト名・ドメイン名・ホストゾーン名・ネームサーバー
- AWS のアカウント ID・ARN・リソースの ID
- 認証情報・秘密鍵（AGENTS.md 10 章）

新しい種類の機微情報（個人名・メールアドレス・URL など）を見つけたら、内容を転記せず、ファイルと行だけをユーザーに伝え、push の前に確認する。`nslookup` の結果や SOA の名前から、DNS の提供元・委任の有無を断定しない（確認は、証明書のスタックが進むか、サイトが動くかで行う）。

予算・AWS の権限・組織名などの記述は、公開してよいと、ユーザーが確認している（2026-10-13）。同種の記述は、再確認なしに取り込んでよい（PR 本文に、その旨を書く）。

## 6. 作業ツリーの共有

別のセッションが、同じ作業ツリー（`smart-farm-monitoring`）で、別のブランチ・未コミットの変更を持っていることがある。

- ブランチを切り替える・pull する前に、`git branch --show-current` と `git status --short` を確認する。自分が作った覚えのない変更・ブランチは、触らない。必要なら、`ListAgents` で他のセッションを確認する。
- 別ブランチで作業するときは、`git worktree add ../smart-farm-monitoring-wt<番号> -b <ブランチ> origin/develop` で、別のディレクトリを使う（docs のみなら、依存のインストールは不要）。
- 使い終えた worktree・ローカルブランチは、ユーザーに確認してから、削除する。

## 7. 実機確認（AWS・実際の接続先）の Issue

AI エージェントは、AWS・実機・実際の接続先を操作しない（AGENTS.md 13 章）。

- 実機確認が要る作業は、別の Issue に分け、完了条件に、実機で確認する項目を書く。
- 手順は、`docs/40_operations/` に書く（例: [federation-platform-setup.md](./federation-platform-setup.md)）。実行は、ユーザー。
- ユーザーが結果を報告したら、Issue にコメントで記録する（接続先・認証情報は書かない）。確認が済むまで、その Issue は閉じない。
