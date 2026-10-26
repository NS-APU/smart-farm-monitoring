# 運用手順（起動・設定・障害対応の骨子）

目的: アプリの起動・設定の確認・日々の運用・障害対応の手順の骨子を示す（NFR-6.1・NFR-6.2）。ローカル実行の手順は、現在の実装に基づく。評価環境（AWS）のデプロイ・ロールバック・初期化・障害時の確認は、7 章（Issue #80。実機の確認の状況は、7 章の表）。バックアップ・復元は [backup-restore.md](./backup-restore.md)。

## 1. 環境ごとの設定（必須の確認）

環境変数の一覧は、`.env.example` と [dev_spec.md](../10_design/functions/dev_spec.md) 3.3 にある。共有・本番の環境では、次を確認してから起動する。

| 変数 | 本番・共有環境での値 | 理由 |
|------|----------------------|------|
| `APP_MODE` | `production`（本番）。Lambda は、**必ず明示する**（未設定は起動エラー） | 既定の `local` は、開発用の設定 |
| `PERSISTENCE` | `dynamodb`（本番。Lambda は、`SfmData` の出力から、環境変数を設定する。Issue #75。`DYNAMODB_OBSERVATIONS_TABLE`・`DYNAMODB_MAIN_TABLE` に、`SfmData` のスタックの出力のテーブル名を指定する。`DYNAMODB_ENDPOINT` は、本番・共有環境では指定しない）。Lambda は **必ず明示する**。Lambda で `file` は使えない（読み取り専用のファイルシステム・複数の実行環境） | メモリのみ・ローカルのファイルは、データが失われる・分裂する |
| `AUTH_PROVIDER` | `cognito`（Amazon Cognito。ADR-0008）。`COGNITO_USER_POOL_ID`・`COGNITO_CLIENT_ID` に、`SfmData` のスタックの出力を指定する。`PERSISTENCE=dynamodb` が必要。`INITIAL_USER_*` とは併用できない。ローカル・テストは、既定の `local` | 本番の Lambda は、パスワードを Cognito に預ける（アプリ内の認証は、セッションをメモリに持つため、Lambda では使えない） |
| `FILE_SERVER_S3_BUCKET` | 評価環境の Lambda は、IaC が、ファイルサーバーのモックのバケットを指定する（Issue #77）。取り込み元ごとに `<バケット>/<取り込み元の識別子>/` にファイルを置く。**置くのは、合成データだけ**（実データ・個人情報は置かない） | Lambda には、ローカルのディレクトリがない。未指定の `FILE_SERVER_DIR` は、ローカル用 |
| `DEV_API_ENABLED` | 指定しない（無効）。`production` では、指定しても無効 | 開発用 API は、全データの消去・時計の操作・ジョブの強制実行を含む |
| `ROLE_DEFINITIONS_JSON`・`INITIAL_USER_ROLE` | 権限を分けたロール定義を指定する。未指定だと、全利用者が全権限を持つ1ロールで動作し、起動時に警告が出る | 最小権限（security.md）。ロールは、管理者・一般の 2 種類（決定。ADR-0013。実装は #115） |
| `TRUSTED_PROXY_HOPS` | 評価環境（CloudFront → 関数の URL）は、**設定しない（0）**。関数の URL が `X-Forwarded-For` を切り詰めるため、段数では識別できず、`1` 以上にすると偽装できる（ADR-0010）。既定の 0 は、`X-Forwarded-For` を信頼しない | ログインの試行回数の制限の接続元。偽装の防止（V-007） |
| `CLIENT_IP_HEADER` | 評価環境は、`x-sfm-viewer-ip`（IaC で設定する。CloudFront の Function が、利用者の IP を入れる）。**AWS で、ログの `clientKey` が利用者の IP になることを確認する**（ADR-0010） | ログインの試行回数の制限の接続元（V-007）。CloudFront を経由しない呼び出しでは、クライアントが値を付けられる |
| `SEED_MODE` | `NONE` | デモデータを混ぜない |
| `EVALUATION_ON_WRITE` | 評価環境の API の Lambda は、`deferred`（IaC が指定する）。ローカル・E2E は、既定の `sync` | `deferred` は、手動入力の保存・削除の応答の前に、評価を再計算せず、定期の評価（JB-02。5 分ごと）が更新する。反映は最大 5 分遅れる。データが増えると、評価の再計算（直近 90 日の読み出し）が重くなり、保存・削除が遅くなるため（Issue #79・#123。ADR-0014） |
| `INITIAL_USER_*` | ローカルのみ（`AUTH_PROVIDER=cognito` では、使えない。最初のユーザーは、手元で `pnpm initial-user` を 1 回だけ実行して作る。commands.md）。初回のみ。初回のログイン後に、パスワードを変更する（ユーザー管理）。秘密情報として扱い、リポジトリ・ログに残さない | security.md |

起動時のログに、警告（「開発用 API が有効です」「既定のロール…で動作しています」）が出ていないことを確認する。

## 2. 起動・停止（ローカル実行）

- 起動: `pnpm dev:backend`（バックエンド）、`pnpm dev:frontend`（画面）。手順は [commands.md](../00_project/commands.md)
- 停止: `SIGINT`・`SIGTERM`（Ctrl+C）で、未保存のデータを書き出してから終了する。書き出しに失敗した場合は、ログに記録し、終了コード 1 で終了する
- 起動に失敗した場合: ログのエラーを確認する。データファイルが読めない場合は、[backup-restore.md](./backup-restore.md) の「データファイルが読み込めないとき」

## 3. ログの見方

構造化ログ（JSON。1行1イベント）を標準出力へ出す（AWS では、CloudWatch Logs に入る。見方は 7.6）。主な項目: `time`・`level`・`message`・`requestId`・`userId`・`equipmentId`。パスワード・トークンなどの秘密情報は、値がマスクされる。

| 事象 | ログのメッセージ・`event` | 対応 |
|------|----------------------------|------|
| ログインの成功・失敗・制限・ログアウト | `auth.login.succeeded`・`auth.login.failed`・`auth.login.locked`・`auth.logout`・`auth.refresh.failed` | 失敗が続く接続元・ユーザーIDを確認する（不正なログインの試行） |
| 想定外のエラー（バグ・データの不整合） | `想定外のエラーが発生しました`（`errorName`・`errorMessage`・`errorCause`・`errorStack`・`path`） | 原因の調査。利用者への応答には、内部情報を含めない |
| 取り込みの失敗 | `ファイルの取り込みに失敗しました`・`ファイルを読めませんでした`・`ファイルの一覧の取得に失敗しました`（`sourceId`・`fileId`） | ファイルサーバーの接続・ファイルの形式を確認する。画面の取り込みログ（取り込み設定）にも記録される |
| ジョブの失敗・タイムアウト | `ジョブの実行に失敗しました`（`jobId`・`errorName`） | `OperationTimeoutError` は、外部通信が応答しなかった（既定: 通信30秒・ジョブ10分） |
| 合成データの生成（デモ。Issue #77）の実行・失敗 | `合成データのファイルを置きました`（`files`: 8）・`合成データのファイルを置けませんでした`（エラー） | 生成の Lambda のロググループ（関数名は、スタックの出力 `DemoFeedFunctionName`）。失敗が続くと、デモのデータが古くなる。原因（`errorName`）が `AccessDenied` なら、バケットの権限・バケット名を確認する。ADR-0012 |
| ジョブの Lambda（EventBridge）の実行・重複 | `ジョブを終了しました`（`jobId`・`outcome`: `EXECUTED` または `SKIPPED`・`durationMs`）・`前回の実行が続いているため、ジョブを実行しません`・`ジョブのロックを解放できませんでした`（警告） | `SKIPPED` が続くときは、前回の実行が、間隔より長くかかっている（実行時間を確認する）。失敗は `ジョブの実行に失敗しました`。ジョブのログは、ジョブの Lambda のロググループ（関数名は、スタックの出力 `JobFunctionName`）。ADR-0011 |
| 設備の評価の失敗 | `設備の評価に失敗しました`（`equipmentId`） | その設備の保存データ・判断基準を確認する。ほかの設備の評価は続く |
| データファイルの書き込みの失敗 | `データファイルの書き込みに失敗しました。再び書き込みます` | ディスクの空き容量・権限を確認する（メモリ上の変更は保持され、再試行される） |

## 4. 異常の通知への対応（HITL）

- 観点のステータスが「注意」「異常」に変わると、通知が作られる（ダッシュボードのヘッダー・通知の画面。Web Push は、購読した端末）
- **データ取得の停止**: 新しいデータが、取得間隔×3（既定）を超えて届かない場合、「データ取得停止」の通知が作られる（暫定仕様。`INGESTION_STOP_NOTIFICATION_ENABLED` で無効にできる）。ロボット・センサーの電源・通信・ファイルの出力を確認する
- **データ取得失敗**: ファイルサーバーに接続できない場合の通知。接続先・認証情報の設定（取り込み設定）と、ファイルサーバーを確認する
- 画面の判断基準を変更すると、全員の評価・通知に反映される。変更履歴（変更履歴の画面）で、いつ・誰が変更したかを確認できる

## 5. 定期作業（目安）

| 作業 | 頻度 | 内容 |
|------|------|------|
| バックアップ | 日次 | [backup-restore.md](./backup-restore.md) |
| 復元の試験 | 月次 | 同上 |
| ログ・通知の確認 | 随時 | 上記 3・4 |
| 依存パッケージの更新・脆弱性の確認 | 随時 | Dependabot alerts（自動の検知・通知）。`pnpm audit` は、補助（決定。[ADR-0021](../10_design/adr/0021-nonfunctional-ops-doc-rules.md)） |

## 6. 配信（画面）の前提（評価環境の IaC の実装状況）

画面は、ブラウザの History API でルーティングする SPA。静的配信（S3 + CloudFront。ADR-0006）で、次を満たす設定が必要になる。評価環境の IaC（`infra/lib/evaluation-stack.ts`）での実装状況を、各項目に示す。

- 深い URL（例: `/viewpoints/harvest-accuracy`）の再読み込みを、`index.html` へ書き換える（404 にしない）: **実装済み**（CloudFront Function（viewer-request）で書き換える。API の 403・404 は書き換えない。ADR-0006）
- `index.html` のキャッシュは短く、`assets/`（ハッシュつきのファイル名）は長く: **一部**。CloudFront は、静的配信に `CACHING_OPTIMIZED` を使い、デプロイのたびに、`/*` を無効化する（`BucketDeployment`。`index.html` は、デプロイの直後に、新しい版になる）。S3 のオブジェクトの `Cache-Control` は、設定していない（ブラウザ側のキャッシュの指定。Issue #127）
- サービスワーカー（`/sw.js`）・マニフェストは、サイトのルート（`/`）で配信する（サブパスでの配信は、ルーティング・Web Push が動かない）: **実装済み**（S3 のルートに置き、同じオリジンで配信する）
- API（`/api/v1/*`）は、同じオリジンから配信する: **実装済み**（CloudFront が、`/api/*` と `/health` を、API の Lambda の関数の URL へ振り分ける。CORS は不要。ADR-0006）
- セキュリティヘッダー（HSTS・CSP・`frame-ancestors`・`Referrer-Policy`）を、配信側にも設定する。API の応答には、バックエンドが付けている（V-015）: **一部**。CloudFront の応答ヘッダーポリシーは、AWS のマネージドポリシー `SECURITY_HEADERS` を使っている。画面（静的ファイル）の CSP・`frame-ancestors` は、設定していない（Issue #127）

## 7. 評価環境（AWS）のデプロイ・ロールバック・初期化・障害時の確認

現在の評価環境は、**開発サイト**（8 章）。本番サイトは、実証実験の前に用意した（9 章。2026-10-22 に作成）。

顧客評価環境（サーバーレス構成。ADR-0006）の最小の運用手順（Issue #80）。環境の作り方（初回の設定・bootstrap・OIDC のロール）は [commands.md](../00_project/commands.md) の「評価環境（IaC）」。

**確認状況**: 手順は、コード（`infra/`・`.github/workflows/`）と AWS の公式ドキュメントから書いた。**実機（AWS）での確認の状況は、下の表**（2026-10-20 に、ユーザーが、手元から実行して確認した）。AWS に接続する操作は、ユーザーが実行する（AGENTS.md 12 章）。

| 手順 | 実機の確認 |
|------|------------|
| 7.2 デプロイ | 手元からのデプロイ（`diff` → `deploy`）と、GitHub Actions 経由（「Deploy development」（旧「Deploy evaluation」）。API の Lambda・Cognito・DynamoDB の構成）の両方を、**確認済み**（手元: 2026-10-20、GitHub Actions: PR #104 のマージ後。ユーザーが実行） |
| 7.3 ロールバック | **確認済み**（2026-10-20）。手元で、前の版（`origin/develop`）を別の場所（git worktree）に置いてデプロイし、`/health` を確認し、現在の版に戻した。失敗時の自動ロールバック、`git revert` の PR 経由は、未実施 |
| 7.4 初期ユーザーの作成 | 確認済み（2026-10-16。Issue #74） |
| 7.5 データの初期化 | **確認済み**（2026-10-20・21）。`pnpm demo-data seed / reset`（`--yes` なしの確認・`--yes` の削除・ユーザーが残ること・投入し直し）は、AWS で確認済み（ADR-0012 の「検証」）。`reset --yes` は、S3 のファイルがある状態でも、確認済み。**ユーザーを含む全データの削除 → 再デプロイ → 最初のユーザーの作成 → 再投入**（7.5 の前半）も、**確認済み**（2026-10-21。ADR-0012 の「検証」）。 |
| 7.6 障害時の確認（ログの見方） | **確認済み**（2026-10-20）。ロググループの特定、`aws logs tail`、Logs Insights のクエリ |
| [backup-restore.md](./backup-restore.md) の復元（PITR。復元 A）・同名での置き換えの機構（復元 B。一時テーブルで試験）・設定値（ログ 30 日・PITR 35 日） | **確認済み**（2026-10-20）。本番のテーブルを置き換える操作そのものは、実施していない |

### 7.1 構成（スタック）

| スタック | 中身 | 備考 |
|----------|------|------|
| `SfmData` | DynamoDB のテーブル 2 つ・Cognito のユーザープール | 状態を持つ。削除の保護あり。評価環境の更新・削除では、消えない |
| `SfmEvaluation` | 画面（S3 + CloudFront）・API（Lambda の関数の URL）・ログ | 状態を持たない。何度でも作り直せる。出力: `SiteUrl`・`DistributionId`・`ApiFunctionName`・`JobFunctionName`・`DemoFeedFunctionName`・`FileServerBucketName` |
| `SfmGithubOidc` | GitHub Actions 用のロール | 初回に 1 回だけ作る |

`deploy` は、`SfmData` → `SfmEvaluation` の順に更新する（Lambda が、`SfmData` の出力を使うため）。

### 7.2 デプロイ

1. 変更が、PR の CI（`ci.yml`）を通り、レビューを受けて、`develop` にマージされていることを確認する
2. データの構造に関わる変更（`SfmData`・テーブルのキー・インデックス）を含む場合は、先に、DynamoDB のオンデマンドバックアップを取る（[backup-restore.md](./backup-restore.md)）
3. GitHub の Actions → 「Deploy development」→ Run workflow（ブランチ: `develop`。PR の前の動作確認では、`feature/*` などを選べる。8.3）。画面のビルド（`pnpm build`）のあと、`cdk deploy --all` が動く。実行中のデプロイは、止めない（CloudFormation の更新が、途中で止まるため）
4. 確認: ワークフローのログの `SiteUrl` を開く。`<SiteUrl>/health` が `{"status":"ok",…}` を返す。ログインできる。API のログに、起動時の警告（1 章）が出ていない（7.6）

手元から行う場合（検証用）と、差分の確認は、[commands.md](../00_project/commands.md) の「評価環境（IaC）」。

### 7.3 ロールバック

| 状況 | 対応 |
|------|------|
| **デプロイが失敗した**（ワークフローが失敗） | CloudFormation が、直前の状態へ自動で戻す。AWS のコンソール（CloudFormation）で、スタックの状態が `UPDATE_ROLLBACK_COMPLETE` であることを確認する。`UPDATE_ROLLBACK_FAILED` の場合は、失敗したリソースの原因を直し、`aws cloudformation continue-update-rollback --stack-name <スタック名>` を実行する。原因を直してから、7.2 を再実行する |
| **デプロイは成功したが、不具合がある** | 不具合の原因のコミットを、`git revert` で取り消す PR を作り、`develop` にマージして、7.2 を実行する（前の版が、コードから、再び作られる）。急ぐ場合は、手元で、前の正常なコミットをチェックアウトし、`pnpm build` → `pnpm --filter @smart-farm/infra run deploy`（`AWS_PROFILE` を指定）で戻し、あとで、Git にも反映する（revert の PR） |

- **戻すと判断する基準**: `/health` が応答しない、ログインできない、想定外のエラー（3 章）が続く、のいずれか。軽微な不具合は、戻さず、修正して前に進める
- **ロールバックで戻らないもの**: `SfmData` のデータ（観測値・設定・ユーザー）。Cognito のユーザーの追加・パスワードの変更。データを前の時点に戻すときは、[backup-restore.md](./backup-restore.md)
- **Issue #80 より前の版へ戻す場合の注意**: 画面の配置の補助の Lambda の旧いロググループ（`/aws/lambda/` で始まり `CustomCDKBucketDeployment` を含む名前）が残っていると、旧い版の IaC が、同じ名前のグループを作ろうとして失敗する見込み（失敗すれば、CloudFormation が、自動で元に戻す）。先に、そのグループを削除する（デプロイのときのログだけが入っている。[backup-restore.md](./backup-restore.md)）。今後の版どうしの切り戻しでは、起きない
- 画面だけの不具合でも、ロールバックは、スタック全体の更新になる（画面・API は、同時に更新される）

### 7.4 初期ユーザーの作成

評価環境（`AUTH_PROVIDER=cognito`）の最初のユーザー（管理者）は、**ユーザーが、手元で、1 回だけ**作る。手順は、[commands.md](../00_project/commands.md) の「最初のユーザー（Cognito）」。要点:

- `SfmData` の出力（`UserPoolId`・`UserPoolClientId`・`ObservationsTableName`・`MainTableName`）を、環境変数に入れ、`pnpm initial-user` を実行する
- ユーザーが 1 人でもいれば、何もしない（既存のユーザーを上書きしない）
- 実行したら、`INITIAL_USER_*`（特にパスワード）を、すべて消す。初回のログイン後に、パスワードを変更する
- 2 人目以降は、画面の「ユーザー管理」で作る。**管理者は、2 名以上にする**（管理者が 1 人だけで、パスワードを忘れると、アプリからは復旧できず、AWS の管理者の操作が要る。決定。[ADR-0020](../10_design/adr/0020-authentication-rules.md)）。忘れたときは、管理者が再設定する

### 7.5 データの初期化

- **評価環境のデータを、すべて消して、空から作り直す**（ユーザーを含む。**元に戻せない**。**評価環境は、削除から再作成の完了まで、使えない**）。**確認済み**（2026-10-21。Issue #77）。実行の前に、必要なら、オンデマンドバックアップを取る（[backup-restore.md](./backup-restore.md)）。手順の詳細は、[commands.md](../00_project/commands.md) の「削除と再作成」の「データ（DynamoDB のテーブル）の削除」:
  1. 削除前の値（テーブル名・ユーザープールの ID・`SiteUrl`）を控える
  2. **評価環境（`SfmEvaluation`）を、先に削除する**（`pnpm build` → `pnpm --filter @smart-farm/infra run destroy`。約 10 分。`SfmData` の出力を参照しているため、先に削除しないと、`SfmData` を削除できない）
  3. データのスタック（`SfmData`）を削除する（スタックの削除の保護を無効にして `destroy:data`）。テーブル・ユーザープールは、残る（RETAIN）
  4. テーブルを削除する（削除の保護を無効にして `delete-table`）
  5. Cognito のユーザープールを削除する（コンソールで、削除の保護を無効にして削除）
  6. 再作成する（GitHub Actions の「Deploy development」。**`SiteUrl` は、新しくなる**）。新しいテーブル名・ユーザープールの ID・`SiteUrl` を、控える
  7. 最初のユーザーを作る（7.4）
  8. デモデータを投入する（`pnpm demo-data seed`）。生成の Lambda（15 分ごと）・取り込みは、そのまま動く
- **デモデータの投入・リセット**（ユーザーを残して、データだけを作り直す）: 手元で、`pnpm demo-data` を実行する（[commands.md](../00_project/commands.md) の「デモデータの投入とリセット」。ADR-0012）。本番の組み立て（`APP_MODE=production`）は、`SEED_MODE`・開発用 API を使えないため、別の入口とした。
  - `pnpm demo-data seed`: デモの設備・直近 3 日分の合成データ・評価を投入する。設備がすでにあれば、何もしない
  - `pnpm demo-data reset`: **何も消さず**、消す対象の件数を示す。`pnpm demo-data reset --yes` で、ユーザー・ログインの試行回数の記録・ジョブのロック以外の全データと、S3 のファイルを消す（**元に戻せない**。必要なら、先に、オンデマンドバックアップを取る。[backup-restore.md](./backup-restore.md)）
  - 消したあとは、`seed` で投入し直す。評価の直前に、`reset --yes` → `seed` で、最新の状態にできる
  - 投入したデータの鮮度は、**合成データを定期的に生成する Lambda**（擬似のロボット・環境センサー。15 分ごとに、S3 に新しいファイルを置き、取り込み（JB-01）が読む）が保つ。`reset` のあとも、この Lambda は動き続ける（消した S3 のファイルは、次の実行で、直近 4 区間の分が、再び置かれる）。**`reset` と `seed` は、続けて実行する**（設備がない間に取り込みが走ると、その区間のファイルは、設備が見つからないとして棄却され、取り込み済みの扱いになる）
  - 生成を止めたいとき（デモを使わない期間）: EventBridge のルール（ロジカル ID が `ScheduleDemoFeed` で始まるもの）を、AWS のコンソールで無効にする（CloudFormation は、手で変えた状態を、自動では戻さない。再び動かすときは、同じ場所で有効にする）

### 7.6 障害時の確認（ログの見方）

1. **画面が開くか**: `SiteUrl`。開かない場合は、CloudFront（`DistributionId`）の状態と、`SfmEvaluation` のスタックの状態（CloudFormation）を確認する
2. **API が動くか**: `<SiteUrl>/health`。応答しない・5xx の場合は、次の API のログを見る
3. **API のログ**（CloudWatch Logs。保持期間 30 日）:
   - ロググループの名前: `aws lambda get-function-configuration --function-name <ApiFunctionName> --query LoggingConfig.LogGroup --output text`（`ApiFunctionName` は、`SfmEvaluation` の出力）。コンソールでは、Lambda → API の関数 → モニタリング → CloudWatch のログを表示
   - CloudWatch の Logs Insights で、そのロググループを選び、期間を指定して、次のようなクエリで探す（ログは、1 行 1 イベントの JSON で、項目は、そのまま使える。形式は 3 章）

   ```
   # 想定外のエラー・警告（新しい順）
   fields @timestamp, level, message, path, errorName, errorMessage, requestId
   | filter level = "error" or level = "warn"
   | sort @timestamp desc
   | limit 50

   # ログインの失敗・制限（接続元ごとの件数）
   fields @timestamp, event, userId, clientKey
   | filter event = "auth.login.failed" or event = "auth.login.locked"
   | stats count() by clientKey, event
   ```
4. 症状ごとの見方:

| 症状 | 確認すること |
|------|--------------|
| ログインできない | `auth.login.failed`・`auth.login.locked`（3 章）。Cognito のユーザーが存在するか（AWS のコンソール） |
| API が遅い・タイムアウトする | Lambda のタイムアウトは 29 秒（CloudFront の上限 30 秒の内側）。ログの `OperationTimeoutError`。DynamoDB の調整（スロットリング）のエラー |
| 長時間アクセスがないあと、最初のログイン・画面の表示が遅い（約 3 秒） | Lambda のコールドスタート（既知の制約。2 回目以降は約 1.4 秒。Issue #79）。毎回遅い場合は、Logs Insights（7.7）で、Init Duration と実行時間を確認する |
| デプロイの直後から、おかしい | 7.3 のロールバック |

- 障害時の連絡先・エスカレーション（運用体制）: 利用者 → システムの管理者（受注者）→ 運用・保守の担当（受注者）。**連絡先は、リポジトリの外で管理する**（公開のため。決定。[ADR-0021](../10_design/adr/0021-nonfunctional-ops-doc-rules.md)）

### 7.7 性能の確認（Lambda の起動時間・実行時間。Issue #79）

画面の操作の時間は、`pnpm test:smoke`（commands.md）で測る。**Lambda 側**の、実行時間と、起動の時間（コールドスタートの Init Duration）は、CloudWatch Logs の Logs Insights で、API・ジョブの Lambda のロググループ（7.6 の 3。ジョブは `JobFunctionName`）に、次のクエリを実行して見る（Lambda が出す `REPORT` 行を使う）。

```
# 実行時間と起動の時間（期間を指定する。1 時間ごと）
filter @type = "REPORT"
| stats count() as invocations, count(@initDuration) as coldStarts,
        avg(@initDuration) as avgInitMs, max(@initDuration) as maxInitMs,
        avg(@duration) as avgDurationMs, pct(@duration, 95) as p95DurationMs, max(@duration) as maxDurationMs,
        max(@maxMemoryUsed / 1000 / 1000) as maxMemoryUsedMB
  by bin(1h)

# コールドスタートだけ（起動の時間の長い順）
filter @type = "REPORT" and ispresent(@initDuration)
| fields @timestamp, @initDuration, @duration, @maxMemoryUsed / 1000 / 1000 as memoryUsedMB
| sort @initDuration desc
| limit 20
```

- 見方: `maxDurationMs` は、Lambda のタイムアウト（API は 29 秒、ジョブは 300 秒。7.6）に対する余裕を見る。`maxMemoryUsedMB` は、設定したメモリ（1024 MB）に対する余裕を見る。`@initDuration` は、コールドスタートのときだけ出る
- 画面の初期表示の許容時間（NFR-3.4）は 3 秒。コールドスタートの起動の時間が長く、超える場合は、メモリの設定・処理の分割・キャッシュなどで対応する（対応は別の Issue にする）。**実測（2026-10-21。Issue #79）**: 長時間アクセスがないあとの最初のログインは、約 3.2 秒（NFR-3.4 を約 0.2 秒超過）。起動（Init Duration）は約 0.4〜0.5 秒。既知の制約として許容している（改善の案は、test.spec.md 13.3）

## 8. 開発サイトと本番サイト（評価環境の運用方針）

決定の記録は、[ADR-0013](../10_design/adr/0013-environments-and-access-control.md)（Issue #78）。**ロールの分割・設備の割り当ては、まだ実装されていない**（Issue #115・#116）。本番サイトは、AWS に作成した（Issue #117。9 章。2026-10-22）。

### 8.1 サイト

| | 開発サイト | 本番サイト |
|---|-----------|------------|
| 目的 | 開発の間の、出来栄えの評価 | 現場での実証実験 |
| デプロイ元のブランチ | `develop`（基本）。動作確認で、ほかのブランチを使うことがある（8.3） | `main` |
| データ | **基本は合成データ**。実際のロボット・センサーとの結合確認では、実データを取り込むことがある（個人情報は不可。条件は、ADR-0013・[ADR-0021](../10_design/adr/0021-nonfunctional-ops-doc-rules.md) に記録した。接続のアダプタは Issue #119） | **実データ可（個人情報は不可）**。扱う条件は、確定済み（ADR-0013 6 章。Issue #117） |
| 状態 | 現在の評価環境（`SfmData`・`SfmEvaluation`。7 章） | **AWS に作成した**（9 章。Issue #117。2026-10-22。`main` から、承認つき） |

- 2 つのサイトは、データ・ユーザー・URL を共有しない（別のスタック・別のテーブル・別のユーザープール・別の S3）
- **評価する人・アクセス元**: 登録されたユーザー（10 人程度）。インターネットから。**接続元 IP による制限は、設けない**（WAF も設けない）

### 8.2 アクセス制御

- **ログインは、必須**。多要素認証は、設けない。初期ユーザーは、システムの構築時に、**管理者のロールで**作る（7.4）。2 人目以降は、管理者が、画面で作る
- **ロールは、管理者・一般の 2 種類**: 管理者は、すべての操作ができる。一般は、**管理者が割り当てた設備の閲覧・手動入力・自身のユーザー情報の編集**に限る。操作ごとの可否は、ADR-0013 の表。**実装前（現在）は、全員が全権限を持つ 1 ロール**

### 8.3 更新の方針

- **開発サイト**: `develop` の更新で、**自動デプロイ**する（Issue #89。`develop` への push で、Actions の「Deploy development」が始まる。7.2）。手動実行も残す。**PR の前の動作確認のために、`develop` 以外のブランチも、デプロイできる**（Issue #131）: Environment `development` が許可するブランチは、`develop`・`feature/*`・`release/*`・`hotfix/*`。Actions の「Use workflow from」で、確認したいブランチを選ぶ（`gh workflow run deploy-development.yml --ref <ブランチ>` でも可）。**開発サイトは 1 つ**で、デプロイしたブランチの内容に置き換わる（IaC・DynamoDB・Cognito の変更も、そのまま入る）。確認のあとは、`develop` をデプロイして、戻す。**別のブランチを確認している間は、`develop` にマージしない**（マージすると、自動デプロイで、確認中の内容が `develop` の内容に置き換わる。再デプロイで戻せる。仕組みでは防がない。ユーザーの判断。Issue #89）。選んだブランチに、`deploy-development.yml` が要る（`develop` を取り込む）。**確認の間に `develop` が更新されると、自動デプロイで上書きされる**（上書きを避ける手段は、Issue #89 で決める）
- **本番サイト**: `main` の更新で、自動デプロイする（Issue #89・#117）。デプロイできるブランチは `main` だけで、**承認者による承認を必須にする**（承認者は T-Ishikawa-R のみ・自己承認を許可。`main` への push で、「Deploy production」が始まり、承認を待つ。手動実行も使える。9 章）
- 評価する人への告知は、しない

### 8.4 評価の進め方

- フィードバックは、会議・メール等で聞き取り、**開発者が Issue にする**（個人・組織が特定されない形で書く。リポジトリは公開）。Sprint 3 以降の優先度づけにつなげる
- 期間: 開発サイトは、開発が一段落するまで。本番サイトは、実証実験の計画に従う（未定）
- 顧客向けの案内（URL・ログインの方法など）は、作らない（本スプリントでは必須でないため）

## 9. 本番サイトの運用手順（Issue #117。ADR-0013）

本番サイトは、現場での実証実験に使う環境（実データ可。個人情報は不可）。開発サイト（7 章・8 章）とは、**データ・ユーザー・URL を共有しない**。**2026-10-22 に、AWS に作成した**（`main` から、承認つき。9.2・9.9）。AWS に接続する操作は、**ユーザーが実行する**（AGENTS.md 12 章）。

### 9.1 構成と、開発サイトとの違い

| 項目 | 開発サイト | 本番サイト |
|------|-----------|------------|
| AWS のアカウント・リージョン | 同じアカウント・東京 | 同じ（ユーザーの判断） |
| スタック | `SfmData`・`SfmEvaluation`（独自ドメインのときは `SfmEvaluationCertificate`） | `SfmProductionData`・`SfmProductionEvaluation`（同 `SfmProductionEvaluationCertificate`） |
| 環境変数 `SFM_ENVIRONMENT` | 未設定、または `development` | `production` |
| GitHub の Environment | `development`（デプロイできるブランチ: `develop`） | `production`（`main` のみ。**承認者の承認が必須**） |
| デプロイのロール（OIDC） | `sfm-github-actions-deploy` | `sfm-github-actions-deploy-production` |
| ワークフロー | 「Deploy development」 | 「Deploy production」（`main` 以外では動かない） |
| データ | 基本は合成データ | 実データ可（個人情報は不可。9.8） |
| 合成データの生成（デモ）の Lambda | あり | **なし** |
| ファイルサーバーのモックの S3 | あり（デモが置く） | あり（**空のまま**。実ファイルサーバーのアダプタは、Issue #119。Lambda の取り込みの失敗を避けるため） |
| `pnpm demo-data` | 使える | **使えない**（`SFM_ENVIRONMENT=production` のとき実行しない安全装置） |
| データの保護（削除の保護・RETAIN・PITR 35 日・ログ 30 日） | あり | 同じ |

### 9.2 初回の作成（1 回だけ。ユーザーが行う）

前提: 開発サイトの初回の設定（bootstrap・OIDC のプロバイダー。commands.md「評価環境（IaC）」）と、Environment の改名の移行（commands.md）が済んでいる。本番サイトの IaC の変更が、`main` に入っている（Sprint 2 のリリース（#84）の後）。

1. **OIDC のスタックを更新**（本番用のロールを作る。**2026-10-22 に実施済み**）: `pnpm --filter @smart-farm/infra run deploy:oidc`。出力 `ProductionDeployRoleArn` を控える
2. **GitHub の Environment `production` を作る**（Settings → Environments。**2026-10-22 に作成済み**。設定を確認した）:
   - Deployment branches and tags: **Selected branches** → `main` だけ
   - Required reviewers: **T-Ishikawa-R**（Prevent self-review は、オフ）
   - Environment のシークレット `AWS_DEPLOY_ROLE_ARN`: 手順 1 の `ProductionDeployRoleArn`
   - 独自のサブドメインを使うときは、Environment の変数 `SFM_DOMAIN_NAME`・`SFM_HOSTED_ZONE_NAME`（2 つとも。開発サイトとは別のサブドメイン）
3. **差分の確認**（推奨）: 次のとおり。作られるのは、本番の 2 つのスタック（`SfmProductionData`・`SfmProductionEvaluation`）だけで、開発サイトのスタックは、出ない
   ```powershell
   $env:AWS_PROFILE = '<プロファイル名>'
   $env:SFM_ENVIRONMENT = 'production'
   pnpm build
   pnpm --filter @smart-farm/infra run diff
   Remove-Item Env:SFM_ENVIRONMENT   # 必ず消す（以降のコマンドが、本番を向かないように）
   ```
4. **デプロイ**: GitHub の Actions → 「Deploy production」→ Run workflow（Branch: `main`）→ 承認者が、Review deployments で承認する。ログの `SiteUrl` が、本番サイトの URL
5. **確認**: `<SiteUrl>/health` が、`{"status":"ok",…}` を返す。最初のユーザー（9.5）でログインできる。取り込み（JB-01）が、失敗しない（空のバケットなので、ファイル 0 件で終わる。取り込みの失敗の通知が出ない）。合成データの生成の Lambda が、ない

### 9.3 デプロイ（更新）

1. 変更が、PR の CI を通り、`develop` → `release/*` → `main` にマージされていることを確認する
2. 「Deploy production」→ Run workflow（Branch: `main`）→ 承認者が承認する。実行中のデプロイは、止めない（CloudFormation の更新が、途中で止まるため）
3. 確認は、7.2 の 4 と同じ（本番の `SiteUrl`）

`main` への push（リリース・hotfix のマージ）でも、「Deploy production」が始まり、承認を待つ（Issue #89）。**承認は、必須**。承認の前に、`main` の CI（PR の E2E・負荷テストを含む）が成功していることを確認する。承認待ちは、30 日で期限切れになる（承認しなければ、デプロイされない。手動実行で、やり直せる）。

### 9.4 ロールバック

7.3 と同じ考え方。不具合の原因のコミットを `git revert` で取り消す PR を作り、`develop` → `release/*` → `main` にマージして、9.3 を実行する。**`SfmProductionData` のデータは、ロールバックで戻らない**（9.6）。手元からのデプロイ（`SFM_ENVIRONMENT=production`）は、承認の経路を通らないため、緊急のときだけ、ユーザーの判断で行う。

### 9.5 最初のユーザー

`SfmProductionData` の出力を使う（開発サイトの手順は、commands.md「最初のユーザー」）。ユーザー ID・名前は、匿名の識別子にする（9.8）。

```powershell
# PowerShell の例。<…> を、置き換える
$env:AWS_PROFILE = '<プロファイル名>'
$data = aws cloudformation describe-stacks --stack-name SfmProductionData --region ap-northeast-1 --query "Stacks[0].Outputs" | ConvertFrom-Json
$env:AUTH_PROVIDER = 'cognito'
$env:PERSISTENCE = 'dynamodb'
$env:COGNITO_USER_POOL_ID = ($data | Where-Object { $_.OutputKey -eq 'UserPoolId' }).OutputValue
$env:COGNITO_CLIENT_ID = ($data | Where-Object { $_.OutputKey -eq 'UserPoolClientId' }).OutputValue
$env:DYNAMODB_OBSERVATIONS_TABLE = ($data | Where-Object { $_.OutputKey -eq 'ObservationsTableName' }).OutputValue
$env:DYNAMODB_MAIN_TABLE = ($data | Where-Object { $_.OutputKey -eq 'MainTableName' }).OutputValue
$env:INITIAL_USER_ID = '<ユーザーID>'
$env:INITIAL_USER_NAME = '<ユーザー名>'
$env:INITIAL_USER_PASSWORD = (Read-Host 'パスワード（8 文字以上。英大文字・英小文字・数字を含む）' -MaskInput)
pnpm initial-user
# すべて消す（パスワードを残さない。ほかのコマンドが、本番を向かないように）
Remove-Item Env:AUTH_PROVIDER, Env:PERSISTENCE, Env:COGNITO_USER_POOL_ID, Env:COGNITO_CLIENT_ID, Env:DYNAMODB_OBSERVATIONS_TABLE, Env:DYNAMODB_MAIN_TABLE, Env:INITIAL_USER_ID, Env:INITIAL_USER_NAME, Env:INITIAL_USER_PASSWORD, Env:INITIAL_USER_ROLE -ErrorAction SilentlyContinue
```

- 最初のユーザーのロールは、ロール定義の最初の、ユーザー管理の権限を持つロール（現在は 1 ロール。ロールの分割（Issue #115）の後は、管理者）。2 人目以降は、管理者が、画面（ユーザー管理）で作る

### 9.6 バックアップ・復元

ポイントインタイムリカバリ（35 日）と、オンデマンドのバックアップの手順は、[backup-restore.md](./backup-restore.md) と同じ。テーブル名は、`SfmProductionData` の出力（`ObservationsTableName`・`MainTableName`）に読み替える。**実証実験の開始前と、大きな変更の前に、オンデマンドのバックアップを取る**。

### 9.7 データの削除（実証実験の終了後など）

**元に戻せない**。削除の前に、保管の要否を決め、必要ならオンデマンドのバックアップを取る（9.6）。

1. 評価環境のスタックを削除する: `$env:SFM_ENVIRONMENT = 'production'` のうえで、`pnpm --filter @smart-farm/infra run destroy`（`SfmProductionEvaluation*`。画面・API・ジョブ・S3 のモック・ログ。独自ドメインのとき、証明書・DNS のレコードも）。データは、残る
2. データのスタックを削除する: スタックの削除の保護・テーブルの削除の保護を外し、`pnpm --filter @smart-farm/infra run destroy:data`（`SfmProductionData`）。手順の詳細は、commands.md「削除と再作成」の「データ（DynamoDB のテーブル）の削除」と同じ（スタック名を読み替える）。Cognito のユーザーも消える
3. 終わったら、`Remove-Item Env:SFM_ENVIRONMENT` で、環境変数を消す

**実行の前に**: `$env:SFM_ENVIRONMENT = 'production'` を設定し、`echo $env:SFM_ENVIRONMENT` で確かめ、`pnpm --filter @smart-farm/infra run diff` の `Stack` の行が、**本番の 2 スタック（`SfmProductionData`・`SfmProductionEvaluation`）だけ**であることを確認する（`SfmData`・`SfmEvaluation` が出たら、中止する。開発サイトを消してしまう）。データのスタックの削除のあとは、テーブル（RETAIN）と Cognito のユーザープールを、別に削除する（commands.md「削除と再作成」）。**2026-10-22 に、この手順で確認済み**（9.9）

**`pnpm demo-data reset` は、本番サイトでは使えない**（安全装置）。一部のデータだけを消すときは、画面の削除（手動入力・設備など）を使う。

### 9.8 実データの扱いの条件（確定。2026-10-22）

ADR-0013 の 6 の表のとおり（ユーザーが確定した。2026-10-22。Issue #117）。**実データを入れる前に、Issue #115・#102・#127・#128 を完了させる**（取り込み元の実ファイルサーバーのアダプタ #119 も要る）。保管の期間（1 年分）は、保存期間の確認後に見直す。要点: 個人情報は入れない／ユーザー名・ID は匿名の識別子／ログに実データ・個人情報・認証情報を出さない／最初は管理者だけ／バックアップは PITR 35 日 + 開始前のオンデマンド。

### 9.9 AWS での確認状況

| 手順 | 状況 |
|------|------|
| 9.2 初回の作成・9.3 デプロイ | **確認済み**（2026-10-22。ユーザーが実行）。差分（9.2 の 3）は、本番の 2 つのスタック（`SfmProductionData`・`SfmProductionEvaluation`）だけ。「Deploy production」が承認待ちになり、承認でデプロイが進み、成功した。`<SiteUrl>/health` が `{"status":"ok",…}` を返し、ログインとダッシュボードの表示ができた（設備が未登録のため「設備が登録されていません」と出る。デモデータは入れない）。**取り込み（JB-01）**: 作成の直後（1 時間たたない間）のジョブのログで、「ジョブを終了しました」（`outcome: EXECUTED`・`jobId`・`durationMs`）が 32 件あり、`level error`・`AccessDeniedException` は 0 件。画面（取り込みログ）に失敗の行がなく、通知一覧に「データ取得失敗」の通知がない（取り込み元がないため、何も取り込まずに終わるのが正しい動き）。**合成データの Lambda がない**: スタックの出力に `DemoFeedFunctionName` がなく、リソースに「Demo」を含むものがなく（`[]`）、EventBridge のルールはジョブの 4 本だけ、ファイルサーバーのモックの S3 は空。IaC のテスト（CDK の assertions。スタックの名前・デモの Lambda がないこと・ロールの信頼条件）と、開発サイトのスタックが、タグの値以外は変わらないことの確認（合成結果の比較）は、済み |
| 開発サイトの Environment の改名（`evaluation` → `development`）・OIDC のスタックの更新（開発のロールの信頼条件の更新・本番のロールの作成）（9.2 の前提） | **確認済み**（2026-10-22）。差分は、想定どおり（開発のロールの `sub`・`Description`・タグの変更、本番のロールと出力の追加。置き換えなし）。開発サイトの全リソースのタグの値（`Environment`）だけが変わる差分で、**「Deploy development」が成功し、`/health` とログインを確認した**。古い Environment `evaluation` を削除した |
| GitHub の Environment `development`・`production` の設定 | **確認済み**（2026-10-22。`gh api` で確認）。`development`: デプロイできるブランチ `develop`・`feature/*`・`release/*`・`hotfix/*`・シークレット `AWS_DEPLOY_ROLE_ARN`。`production`: ブランチ `main` のみ・承認者 T-Ishikawa-R・シークレット `AWS_DEPLOY_ROLE_ARN`（本番のロール）。本番のデプロイは、未実施 |
| 9.5 最初のユーザー | **確認済み**（2026-10-22。ユーザーが実行）。最初のユーザーを作成し、ログインできた |
| 9.7 データの削除と、再作成 | **確認済み**（2026-10-22。ユーザーが実行。データが空の状態）。評価環境のスタック（`SfmProductionEvaluation`）の削除 → 保護の解除 → データのスタック（`SfmProductionData`）の削除 → DynamoDB のテーブル 2 つの削除 → Cognito のユーザープールの削除（コンソール）が成功した。削除の確認（スタックがない・本番のテーブルがない）と、**開発サイトが無事なこと**（スタックの状態・`/health`）も確認した。続けて「Deploy production」で再作成し、`/health`・最初のユーザーの作成・ログイン・ダッシュボードの表示・ジョブのログにエラーがないことを確認した（IaC で同じ環境を再作成できる。`SiteUrl` は新しくなる）。**削除のコマンドは、`SFM_ENVIRONMENT=production` を指定しないと、開発サイトを消す**。実行の前に、`diff` の `Stack` の行が、本番の 2 スタックだけであることを確認する（`pnpm --filter @smart-farm/infra run diff`） |
| `main` への push による本番サイトの自動デプロイ（承認待ち → 承認 → 成功） | **確認済み**（2026-10-26。Issue #167。v0.3.0 のリリース〔PR #251〕。承認は、ユーザーが実行）。`release/0.3.0` → `main` のマージ（Merge commit）の直後に、「Deploy production」が、`push` で、**自動で始まり**、**承認待ち**（Environment `production` の Review deployments）になった。承認の前に、`main` の CI（PR の E2E・負荷テストを含む）が成功していた。承認で、デプロイが進み、**成功した**。`<SiteUrl>/health` が `{"status":"ok",…}` を返した。同じ `main` への push のあとの、タグ `v0.3.0` の push・GitHub Release の作成・`main` → `develop` の反映 PR の作成は、承認待ちのデプロイと干渉しなかった（待機のまま） |
| `main` 以外からの本番デプロイの拒否 | **確認済み**（2026-10-22）。「Deploy production」を、`develop` から手動実行（Use workflow from: `develop`）したところ、ジョブがスキップされ、承認の依頼も出なかった（ワークフローの条件 `github.ref`） |
| 9.4 ロールバック・9.6 バックアップ | 未実施（開発サイトの同等の手順は、確認済み: 7.3・backup-restore.md・commands.md） |
