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
| `ROLE_DEFINITIONS_JSON`・`INITIAL_USER_ROLE` | 権限を分けたロール定義を指定する。未指定だと、既定の 2 ロール（管理者 `admin`＝全権限、一般 `general`＝手動入力のみ）で動作する | 最小権限（security.md）。ロールは、管理者・一般の 2 種類（ADR-0013。実装済み〔#115〕） |
| `TRUSTED_PROXY_HOPS` | 評価環境（CloudFront → 関数の URL）は、**設定しない（0）**。関数の URL が `X-Forwarded-For` を切り詰めるため、段数では識別できず、`1` 以上にすると偽装できる（ADR-0010）。既定の 0 は、`X-Forwarded-For` を信頼しない | ログインの試行回数の制限の接続元。偽装の防止（V-007） |
| `LOGIN_FAILURE_LIMIT`・`LOGIN_FAILURE_WINDOW_MINUTES` | 既定は、失敗 5 回 / 15 分（IaC が、API の Lambda に、この値を設定する）。**共有の IP などで、誤ってロックされる事例が出たら、回数を増やす・時間を短くする**。変えるときは、GitHub の Environment（development・production）の変数 `SFM_LOGIN_FAILURE_LIMIT`（1〜100）・`SFM_LOGIN_FAILURE_WINDOW_MINUTES`（1〜1440 分）を設定して、デプロイし直す（ワークフローが、そのまま CDK に渡す。未設定なら 5 回 / 15 分。コードの変更は、要らない。手元からのデプロイは、同名の環境変数を指定する）。ローカルは、`LOGIN_FAILURE_LIMIT`・`LOGIN_FAILURE_WINDOW_MINUTES` を指定する | ログインの試行回数の制限（接続元ごと。FR-9.2。D-44）。アカウント単位のロックは、Cognito が持つ（値は、設定できない）。回数を大きくするほど、総当たりに弱くなる |
| `CLIENT_IP_HEADER` | 評価環境は、`x-sfm-viewer-ip`（IaC で設定する。CloudFront の Function が、利用者の IP を入れる）。**AWS で、ログの `clientKey` が利用者の IP になることを確認する**（ADR-0010） | ログインの試行回数の制限の接続元（V-007）。CloudFront を経由しない呼び出しでは、クライアントが値を付けられる |
| `SEED_MODE` | `NONE` | デモデータを混ぜない |
| `EVALUATION_ON_WRITE` | 評価環境の API の Lambda は、`deferred`（IaC が指定する）。ローカル・E2E は、既定の `sync` | `deferred` は、手動入力の保存・削除の応答の前に、評価を再計算せず、定期の評価（JB-02。5 分ごと）が更新する。反映は最大 5 分遅れる。データが増えると、評価の再計算（直近 90 日の読み出し）が重くなり、保存・削除が遅くなるため（Issue #79・#123。ADR-0014） |
| `INITIAL_USER_*` | ローカルのみ（`AUTH_PROVIDER=cognito` では、使えない。最初のユーザーは、手元で `pnpm initial-user` を 1 回だけ実行して作る。commands.md）。初回のみ。初回のログイン後に、ヘッダーの「パスワードの変更」から、自分でパスワードを変更する（最初のユーザーは、変更を強制しない。2 人目以降の、管理者が決めたパスワードは、本人が最初のログインで変更する。D-45）。秘密情報として扱い、リポジトリ・ログに残さない | security.md |

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

- 観点のステータスが「注意」「異常」に変わると、通知が作られる（正常が 15 分以上続いたあとの悪化、または、同じ出来事の中で重くなるとき。改善・「不明」は通知しない。ダッシュボードのヘッダー・通知の画面。Web Push は、購読した端末）
- **データ取得の停止**: 新しいデータが、取得間隔×3（既定）を超えて届かない場合、「データ取得停止」の通知が作られる（暫定仕様。`INGESTION_STOP_NOTIFICATION_ENABLED` で無効にできる）。ロボット・センサーの電源・通信・ファイルの出力を確認する
- **データ取得失敗**: ファイルサーバーに接続できない場合と、ファイル単位の失敗（読み取り不可・形式違い・大きすぎる。既定で通知。`INGESTION_FILE_FAILURE_NOTIFICATION_ENABLED`）の通知。同じ取り込み元・状況の通知は、60 分に 1 件。接続先・認証情報の設定（取り込み設定）と、ファイルサーバーを確認する
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
- `index.html` のキャッシュは短く、`assets/`（ハッシュつきのファイル名）は長く: **実装済み**（Issue #323）。画面のファイルを、2 つの `BucketDeployment` に分けて配置し、S3 のオブジェクトの `Cache-Control` を指定する。`assets/` は `public, max-age=31536000, immutable`（長期のキャッシュ）、それ以外（`index.html`・`sw.js`・`manifest.webmanifest`）は `no-cache`（毎回、`ETag` で更新を確認する。変わっていなければ 304）。新しい `index.html` は、新しい `assets/` を配置したあとに、公開する（依存関係）。CloudFront は、静的配信に `CACHING_OPTIMIZED` を使い、デプロイのたびに、`/*` を無効化する。注意: 内容が変わらず、再配置されないファイルは、`Cache-Control` が付き直らない（内容が変わった時点で、付く。`index.html` は、毎回、再配置される）。古い画面を開いたままの利用者へは、画面が、検出して、再読み込みを案内する（7.6）
- サービスワーカー（`/sw.js`）・マニフェストは、サイトのルート（`/`）で配信する（サブパスでの配信は、ルーティング・Web Push が動かない）: **実装済み**（S3 のルートに置き、同じオリジンで配信する）
- API（`/api/v1/*`）は、同じオリジンから配信する: **実装済み**（CloudFront が、`/api/*` と `/health` を、API の Lambda の関数の URL へ振り分ける。CORS は不要。ADR-0006）
- セキュリティヘッダー（HSTS・CSP・`frame-ancestors`・`Referrer-Policy`）を、配信側にも設定する。API の応答には、バックエンドが付けている（V-015）: **実装済み**（Issue #127）。画面（静的ファイル）の応答には、CloudFront の応答ヘッダーポリシー（独自。`StaticHeadersPolicy`）が、AWS のマネージドポリシー `SECURITY_HEADERS` と同じヘッダー（HSTS 1 年・`X-Content-Type-Options`・`Referrer-Policy: strict-origin-when-cross-origin`・`X-XSS-Protection`）に加えて、**CSP**（`infra/lib/content-security-policy.ts`。`default-src 'self'`・`script-src 'self'`・`style-src 'self'`・`style-src-attr 'unsafe-inline'`〔React の `style` 属性だけ。推移の帯の幅〕・`img-src`・`font-src`・`connect-src`・`worker-src`・`manifest-src` は `'self'`・`object-src 'none'`・`base-uri 'self'`・`form-action 'self'`・`frame-ancestors 'none'`）と、`X-Frame-Options: DENY` を付ける（強制。画面を、ほかのサイトに埋め込めない）。API（`/api/*`・`/health`）の動作は、これまでのマネージドポリシーのまま（API の CSP は、バックエンドが付ける）。**画面に、外部の資源（フォント・画像・外部の API）やインラインのスクリプトを加えるときは、CSP も変える**（変えないと、画面が動かない）。確認: 手元で `pnpm test:csp`（本番ビルドの画面に、同じ CSP を付けて、主な画面を一巡し、違反が出ないこと。`pnpm test:e2e` と同時に実行しない）。AWS では、`pnpm test:smoke`（`smoke-04-delivery-headers.ts`。応答ヘッダー・Cache-Control・ログイン〜ダッシュボードの違反なし）と、ブラウザの開発者ツールのコンソールに、CSP の違反が出ないこと。違反が出た場合は、コンソールの違反の内容（ディレクティブ・ブロックされた URL）から、`content-security-policy.ts` を直して、再デプロイする

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
- 実行したら、`INITIAL_USER_*`（特にパスワード）を、すべて消す。初回のログイン後に、ヘッダーの「パスワードの変更」から、パスワードを変更する（最初のユーザーは、変更を強制しない）
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
| 長時間アクセスがないあと、最初のログイン・画面の表示が遅い（約 3 秒） | Lambda のコールドスタート（許容している。NFR-3.4 は、コールドスタートなら 6 秒以内。2 回目以降は約 1.4 秒。Issue #79・#168）。毎回遅い場合は、Logs Insights（7.7）で、Init Duration と実行時間を確認する |
| デプロイの直後から、おかしい | 7.3 のロールバック |
| 特定の画面だけ（例: 設定 > 取り込み・ステータスコード）が、「新しい版に更新されました。画面を再読み込みしてください」（または、「画面を表示できませんでした」）になる。ほかの画面は、開く | **デプロイのあとに、古い画面（古い `index.html`・バンドル）を使い続けている**。ブラウザのコンソールに `Failed to fetch dynamically imported module: …/assets/<画面>-<ハッシュ>.js`（その URL が 403）が出る。デプロイで、古い画面の部品が削除されるため。画面の「再読み込み」で直る（`index.html` を `no-cache` にしたため〔6 章。Issue #323〕、再読み込みで、新しい版になる）。直らなければ、強制再読み込み（`Ctrl + Shift + R`）、サイトの閲覧データの削除、iPhone のホーム画面のアプリは、完全に終了して、開き直す（Issue #323）。画面は、この失敗を検出して、1 回だけ、自動で再読み込みする |

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
- 画面の初期表示の許容時間（NFR-3.4）は、**通常は 3 秒以内。長時間アクセスがなく、サーバー（Lambda）が停止したあとの最初の表示（コールドスタート）は、6 秒以内を許容する**（2026-10-28。Issue #168）。通常の表示が 3 秒を超える場合や、コールドスタートが 6 秒を超える場合は、メモリの設定・処理の分割・キャッシュなどで対応する（対応は別の Issue にする）。**実測（2026-10-21。Issue #79）**: 長時間アクセスがないあとの最初のログインは、約 3.2 秒（通常の 3 秒を約 0.2 秒超過。コールドスタートの許容の 6 秒以内）。起動（Init Duration）は約 0.4〜0.5 秒。**対策は、しない**（Issue #168 で、初期化の前倒し・メモリ増・温め・プロビジョンド同時実行を比べ、効果が約 0.5 秒と見込まれ、費用対効果が薄いため、見送った。見直しの条件は、ADR-0021 の更新メモ。比べた内容は、test.spec.md 13.3）

## 8. 開発サイトと本番サイト（評価環境の運用方針）

決定の記録は、[ADR-0013](../10_design/adr/0013-environments-and-access-control.md)（Issue #78）。**ロールの分割は、実装済み**（Issue #115。8.7）。**設備の割り当ては、実装済み**（Issue #330。設備管理のハウスの行の「閲覧の割り当て」。ハウス側から行う）。通知（#331。8.8）は、実装済み。取り込み/連携のログ（#332）は、まだ。本番サイトは、AWS に作成した（Issue #117。9 章。2026-10-22）。

### 8.1 サイト

| | 開発サイト | 本番サイト |
|---|-----------|------------|
| 目的 | 開発の間の、出来栄えの評価 | 現場での実証実験 |
| デプロイ元のブランチ | `develop`（基本）。動作確認で、ほかのブランチを使うことがある（8.3） | `main` |
| データ | **基本は合成データ**。実際のロボット・センサーとの結合確認では、実データを取り込むことがある（個人情報は不可。条件は、ADR-0013・[ADR-0021](../10_design/adr/0021-nonfunctional-ops-doc-rules.md) に記録した。HTTP の接続のアダプタは、#119 で実装済み。実ファイルサーバーへの接続は #298） | **実データ可（個人情報は不可）**。扱う条件は、確定済み（ADR-0013 6 章。Issue #117） |
| 状態 | 現在の評価環境（`SfmData`・`SfmEvaluation`。7 章） | **AWS に作成した**（9 章。Issue #117。2026-10-22。`main` から、承認つき） |

- 2 つのサイトは、データ・ユーザー・URL を共有しない（別のスタック・別のテーブル・別のユーザープール・別の S3）
- **評価する人・アクセス元**: 登録されたユーザー（10 人程度）。インターネットから。**接続元 IP による制限は、設けない**（WAF も設けない）

### 8.2 アクセス制御

- **ログインは、必須**。多要素認証は、設けない。初期ユーザーは、システムの構築時に、**管理者のロールで**作る（7.4）。2 人目以降は、管理者が、画面で作る
- **ロールは、管理者・一般の 2 種類**: 管理者は、すべての操作ができる。一般は、**管理者が割り当てた設備の閲覧・手動入力・自身のユーザー情報の編集**に限る。操作ごとの可否は、ADR-0013 の表。**ロールの分割・設備の割り当て・通知の絞り込み（#331）は実装済み**（取り込みの状況・ログは、管理者のみ。#332）。実データを扱う間は、一般ユーザーを登録しない。一般ユーザーを登録したら、管理者が、設備管理のハウスの行の「閲覧の割り当て」で、そのハウスを閲覧できる一般ユーザーを選ぶ（割り当てがないと、何も閲覧できない）

### 8.3 更新の方針

- **開発サイト**: `develop` の更新で、**自動デプロイ**する（Issue #89。`develop` への push で、Actions の「Deploy development」が始まる。7.2）。手動実行も残す。**PR の前の動作確認のために、`develop` 以外のブランチも、デプロイできる**（Issue #131）: Environment `development` が許可するブランチは、`develop`・`feature/*`・`release/*`・`hotfix/*`。Actions の「Use workflow from」で、確認したいブランチを選ぶ（`gh workflow run deploy-development.yml --ref <ブランチ>` でも可）。**開発サイトは 1 つ**で、デプロイしたブランチの内容に置き換わる（IaC・DynamoDB・Cognito の変更も、そのまま入る）。確認のあとは、`develop` をデプロイして、戻す。**別のブランチを確認している間は、`develop` にマージしない**（マージすると、自動デプロイで、確認中の内容が `develop` の内容に置き換わる。再デプロイで戻せる。仕組みでは防がない。ユーザーの判断。Issue #89）。選んだブランチに、`deploy-development.yml` が要る（`develop` を取り込む）。**確認の間に `develop` が更新されると、自動デプロイで上書きされる**（上書きを避ける手段は、Issue #89 で決める）
- **本番サイト**: `main` の更新で、自動デプロイする（Issue #89・#117）。デプロイできるブランチは `main` だけで、**承認者による承認を必須にする**（承認者は T-Ishikawa-R のみ・自己承認を許可。`main` への push で、「Deploy production」が始まり、承認を待つ。手動実行も使える。9 章）
- 評価する人への告知は、しない

### 8.4 評価の進め方

- フィードバックは、会議・メール等で聞き取り、**開発者が Issue にする**（個人・組織が特定されない形で書く。リポジトリは公開）。Sprint 3 以降の優先度づけにつなげる
- 期間: 開発サイトは、開発が一段落するまで。本番サイトは、実証実験の計画に従う（未定）
- 顧客向けの案内（URL・ログインの方法など）は、作らない（本スプリントでは必須でないため）

### 8.5 ファイルサーバー（HTTP）の接続確認（公開サーバー。Issue #119。ユーザーが実行）

開発サイトの Lambda から、インターネット上の公開サーバーに接続し、取り込みを確かめる（到達性・TLS・認証情報〔パラメータストア〕の読み出し・取り込みの費用）。宇都宮大学のファイルサーバーへの切り替えは、別の Issue（#298）。**開発サイトのデータを変更する操作を含むため、ユーザーが実行する**（AI エージェントは、評価環境に対して実行しない。AGENTS.md 12 章）。

**前提**: 開発サイトに、`develop`（#119 の変更を含む）がデプロイされている。管理者でログインする。公開サーバーは、このリポジトリの**合成データ**（`tests/fixtures/file-server/robot/robot-sample-001.json`。データ上の識別子 `ROBOT-SAMPLE-01`）を、GitHub の raw で配信するものを使う（認証なし。`Last-Modified` を返さないため、毎回、取得される）。

| 手順 | 操作 | 期待する結果 |
|------|------|--------------|
| 1 | 設備（SC-10）で、データ上の識別子が `ROBOT-SAMPLE-01` のロボットを、修正する（なければ、登録する）。ファイルパスに、`/NS-APU/smart-farm-monitoring/develop/tests/fixtures/file-server/robot/robot-sample-001.json` を入力して保存 | 一覧にファイルパスが表示される |
| 2 | 取り込み設定（SC-11）で、ロボットデータの接続方式を「HTTP・HTTPS（ファイルサーバー）」、プロトコルを HTTPS、ホストを `raw.githubusercontent.com`、ポートを空、認証方式を「なし」にして保存 | 「設定を保存しました」 |
| 3 | 「接続テスト」 | 「接続できました」（Lambda からの到達・TLS が確認できる） |
| 4 | 「即時取得」 | 「取得しました（成功）」。ファイル 1 件、取り込み 14 件。取り込みログに、成功が記録される。もう一度「即時取得」しても、ファイル 0 件（同じ内容は、取り込まない） |

**手順 5（認証情報〔パラメータストア〕の確認。#207）**: 手順 4 までで使った公開サーバー（GitHub の raw）は、認証のヘッダーを付けたリクエストに **404 を返す**（認証を受け付けない）。そのため、認証の確認には使えない。次の、**認証の成否で応答が変わる公開サーバー**を使う（値は、公開されているテスト用のダミー。実際の秘密情報ではない）。**ファイルの取り込み（「即時取得」）は、しない**（応答が、取り込みの形式ではないため）。確認の間は、SC-11 の「自動取り込みを有効にする」のチェックを外す（定期の取り込みが、この相手に接続して、失敗を記録するのを避ける）。

| 手順 | 操作 | 期待する結果 |
|------|------|--------------|
| 5-0 | SC-11 のロボットのカードで、「自動取り込みを有効にする」のチェックを外す | — |
| 5-A-1（Basic 認証。値の内容まで確認できる） | 設備（SC-10）のファイルパスを `/basic-auth` にして保存。SC-11 で、接続方式を HTTP・HTTPS、ホストを `postman-echo.com`、ポートを空、認証方式を「Basic 認証」にして保存し、認証情報に、ユーザー名 `postman`・パスワード `password`（このサービスが公開しているテスト用の値）を登録 | 「認証情報を保存しました」→「設定済み」 |
| 5-A-2 | 「接続テスト」 | **「接続できました」**。このサーバーは、ユーザー名・パスワードが一致するときだけ 200 を返す。パラメータストアの値の読み出し・Basic 認証のヘッダーの組み立て・送信が、通ったことの確認 |
| 5-A-3（任意） | パスワードを `wrong` にして登録し、「接続テスト」 | **「認証に失敗しました」**。5-A-2 の成功が、登録した値を使った結果だと分かる |
| 5-B（Bearer。任意） | ファイルパスを `/bearer`、ホストを `httpbin.org`、認証方式を「Bearer トークン」にして保存し、トークンに `dummy-token` を登録 → 「接続テスト」 | **「接続できました」**（トークンがないと 401）。httpbin.org が混み合って 5xx を返すときは、5-A だけでよい |

- 失敗したときの見方: 「認証情報が設定されていません」は、登録していない（認証方式を変えたあと、設定を保存してから登録する）。「認証情報を読み出せません」は、パラメータストアの読み出しの失敗（IAM〔`ssm:GetParameter`〕・パスのどちらか。10.4）。「認証に失敗しました」は、値の誤り（または、更新の反映待ち。最長 5 分）。「ファイルが見つかりません」は、認証を受け付けないサーバー（GitHub の raw など）を使っている場合に出る（この確認の合格ではない）

**手順 7（後片付け。必須）**: SC-11 で、ロボットデータの接続方式を「モック」に戻し、「自動取り込みを有効にする」にチェックを入れ、取得間隔を元（既定 15 分）に戻して保存する。SC-10 で、手順 1 で設定したファイルパスを空にして保存する（取り込んだ観測値は、不要なら、設備の削除などで消す）。登録した認証情報は、別のダミーの値で上書きして、無効にする（10.2）。開発サイトの合成データの生成（ADR-0012）と、混ざらないようにする。

- 取り込んだ記録の計測日時は、固定（2026-10-09）のため、評価では「古いデータ」になる。接続の確認が目的で、評価の値は見ない。
- **費用の実測（#295。手順 6。任意）**: 手順 4 のあと、取得間隔を最短（5 分）にして一定期間（例: 1 日）動かし、AWS のコスト管理・メトリクスで、DynamoDB・Lambda の使用量を確認し、見積もり（architecture.md 11.6）と比べる。終わったら、手順 7 で戻す。
- 公開サーバー（GitHub の raw）は、認証なしのリクエストに、回数の制限がある。取得間隔を短くしても、1 日 600 回程度（5 分間隔）で収まるが、制限に当たったら、間隔を延ばす。
- 失敗の理由は、画面に、固定の文言（接続できません／認証に失敗しました／ファイルが見つかりません など）で示される。接続先・ファイルパス・認証情報は、画面・ログに出ない。詳細は、API の Lambda のログ（7.6）の `warn` で、取り込み元・試行回数だけを確認できる。

### 8.6 Web Push の実配信の設定と、実機での確認（Issue #241。ユーザーが実行）

開発サイトで、Web Push を、実際の端末へ届ける設定と、確認の手順（ADR-0019 の D-36）。**AWS の操作・GitHub の設定・実機の操作は、ユーザーが行う。** 鍵の値は、チャット・Issue・PR・ログ・コミットに、書かない。

**前提**: 開発サイトに、`develop`（#241 の変更を含む）がデプロイされている。AWS のコマンドを使う PowerShell で、プロファイルとリージョンを設定する（`$env:AWS_PROFILE = '<プロファイル名>'`・`$env:AWS_DEFAULT_REGION = 'ap-northeast-1'`。リージョンを指定しないと、`You must specify a region` で失敗する）。`aws sts get-caller-identity` で、対象が大学のアカウントであることを確認する。端末は、PC・Android の Chrome・Edge、または、iPhone・iPad（iOS・iPadOS 16.4 以降。**ホーム画面に追加したウェブアプリ**として開く。Safari のタブのままでは、Web Push は使えない。ADR-0019 の D-41）。HTTPS で開く（開発サイトは、HTTPS）。

| 手順 | 操作 | 期待する結果 |
|------|------|--------------|
| A（鍵の生成） | 手元の PowerShell で、**まず、リポジトリの外の一時のディレクトリへ移る**（`Set-Location $env:TEMP`。リポジトリの中に作ると、誤ってコミットする恐れがある）。次を実行する（Node.js 24 以上。依存の追加は不要）。**秘密鍵は、画面に出さず、一時のファイル（`vapid-private.txt`）に書く**。公開鍵だけが、画面に出る。`node -e "const c=require('node:crypto');const e=c.createECDH('prime256v1');e.generateKeys();require('node:fs').writeFileSync('vapid-private.txt',e.getPrivateKey('base64url'));console.log(e.getPublicKey('base64url'))"` | 公開鍵（87 文字の base64url）が、1 行、表示される。`vapid-private.txt` ができる（43 文字） |
| B（秘密鍵の登録） | 前提の、プロファイル・リージョンの設定を済ませてから、10.2 の例のとおり、`aws ssm put-parameter --name /sfm/development/web-push/vapid-private-key --type SecureString --tier Standard --overwrite --value file://vapid-private.txt` を実行する。同じディレクトリ（`$env:TEMP`）で実行する。**登録したら、すぐに、`Remove-Item vapid-private.txt` で削除する**（鍵の値を、画面・チャット・Issue・PR に貼らない） | 登録に成功する。`aws ssm get-parameter --name /sfm/development/web-push/vapid-private-key --query "Parameter.LastModifiedDate"`（**`--with-decryption` を付けない**）で、更新日時が返る |
| C（公開鍵・連絡先の設定とデプロイ） | GitHub の Environment「development」の変数に、`SFM_WEB_PUSH_PUBLIC_KEY`（手順 A の公開鍵）と `SFM_WEB_PUSH_SUBJECT`（開発サイトの URL。`https://` で始まる。個人のメールアドレスは使わない）を、**2 つとも**設定する。Actions の「Deploy development」を実行する | デプロイが成功する。API・ジョブの Lambda の環境変数に、`WEB_PUSH_DELIVERY=vapid`・公開鍵・連絡先が入る（2 つのうち片方だけを設定すると、デプロイの synth で、エラーになる）。確認（任意）: ジョブの関数の名前は、ワークフローのログの出力 `JobFunctionName`、または、`aws lambda list-functions --query "Functions[?starts_with(FunctionName,'SfmEvaluation')].FunctionName"` の、`JobFunction` を含むもの。`$job = '実際の関数の名前'` としてから、`aws lambda get-function-configuration --function-name $job --query "Environment.Variables.[WEB_PUSH_DELIVERY,WEB_PUSH_SUBJECT]"` を実行し、`vapid` と連絡先が返る（**名前は、引用符で囲んで入力する。`<` `>` は、入力しない**） |
| D（有効化） | 実機で、開発サイトにログインし、メニュー「通知の設定」を開く。「有効にする」を押し、ブラウザの通知の許可を「許可」する | 状態が「有効」になる（この端末の購読と、暗号鍵が、サーバーに登録される） |
| E（受信） | 通知を起こす。例: 手動入力（SC-06）で、設備「環境センサー1」・種別「環境」・計測日時「現在」・温度 40・湿度 60・照度 30000・CO2 900 を保存する（温度が、異常の値）。手動入力のあとの評価は、定期のジョブ（JB-02）が行うため、**通知まで、最大 5〜6 分**かかる。さらに、配信のジョブ（JB-04）が、1 分ごとに配信する（**合計で、最大 6〜7 分**）。または、取り込み設定（SC-11）で、ファイルサーバーの接続を失敗させ、「即時取得」を押す（こちらは、すぐに通知が作られ、最大 1〜2 分） | 端末に、通知（見出し「異常検知」または「データ取得失敗」と、メッセージ）が、表示される（画面を開いていなくても）。通知を選ぶと、通知の画面（SC-05）が開く |
| F（解除） | 「通知の設定」で、「解除する」を押す。もう一度、通知を起こす | 端末に、通知は届かない（画面内の通知には、残る） |

- **失敗したときの見方**: API の Lambda・ジョブの Lambda のログ（7.6）の `warn`「Web Push の配信に失敗しました」の `reason`（理由）を見る。`秘密鍵が設定されていません`: 手順 B（パスのとおりに登録したか。環境は `development`）。`秘密鍵を読み取れません`: IAM（`ssm:GetParameter`・暗号化の鍵の `kms:Decrypt`。10.3・10.4）。`HTTP 401・403`: 公開鍵と秘密鍵が、対になっていない（手順 A をやり直し、B・C を両方更新する）、連絡先が不正、または、購読が、別の公開鍵で作られている（各端末で、解除 → 有効化をやり直す）。`HTTP 400`: 購読の内容の不正。`HTTP 404・410`: 購読が無効（自動で破棄される。再度「有効にする」）。`HTTP 429・5xx`・`接続できません`: 一時的な失敗（1 分から倍々で、通知を作ってから 1 時間まで、再送される）。
- 手順 D より前に購読した端末は、暗号鍵を持たないため、**本文なし**で届く（既定の文言「新しい通知があります」）。「解除する」→「有効にする」で、本文つきになる。
- 鍵を作り直したとき（漏えいの疑いなど）は、手順 A〜C を、すべてやり直す。**公開鍵が変わると、既存の購読には、届かなくなる**（プッシュサービスが、HTTP 403 を返す）。各端末が、「解除する」→「有効にする」をやり直す。
- 費用: プッシュサービスへの送信は、無料。パラメータストアの標準のパラメータ・AWS 管理の暗号鍵は、無料。Lambda の実行時間の増加は、通知 1 件あたり数百 ms の見込みで、数円未満（**実測はしていない**）。
- **確認の結果は、Issue #241 のコメントに記録する**（端末・OS・ブラウザの種類、期待どおりだったか、表示された文言）。実機で確認できなかった端末は、その旨を記録する（D-41 の確認事項）。

### 8.7 既存ユーザーのロールの移行（Issue #115。ユーザーが実行）

ロールを、「農作業者（`worker`）」の 1 種類から、「管理者（`admin`）・一般（`general`）」の 2 種類に分けたため、**ロール `worker` の既存のユーザーは、新しい版では、権限を持たない**（ログインはできるが、何もできない。ユーザー管理もできず、画面からは直せない）。次の手順で、DynamoDB のユーザーの記録のロールを、`admin` に移す。**新しい版を AWS にデプロイしたあとに、実行する**（デプロイの前に移すと、古い版は `admin` を知らないため、移した直後から、デプロイまでの間、全員が権限を失う。デプロイのあとなら、移した直後〔次のリクエスト〕から効く）。コマンドは、手元のソースの、新しい版（`develop` の最新）で実行する（移す先のロールの検証に、手元のロール定義を使うため）。

- 開発サイト: `develop` へのマージで、新しい版がデプロイされる（8.3）。そのあとに、実行する
- 本番サイト: 新しい版を `main` からデプロイ（9.3）したあとに、実行する（`$stack` を `SfmProductionData` にする）

```powershell
# PowerShell の例。<…> を、置き換える
$env:AWS_PROFILE = '<プロファイル名>'
$env:AWS_DEFAULT_REGION = 'ap-northeast-1'
$stack = 'SfmData'   # 本番サイトは 'SfmProductionData'
$data = aws cloudformation describe-stacks --stack-name $stack --region ap-northeast-1 --query "Stacks[0].Outputs" | ConvertFrom-Json
$env:PERSISTENCE = 'dynamodb'
$env:DYNAMODB_OBSERVATIONS_TABLE = ($data | Where-Object { $_.OutputKey -eq 'ObservationsTableName' }).OutputValue
$env:DYNAMODB_MAIN_TABLE = ($data | Where-Object { $_.OutputKey -eq 'MainTableName' }).OutputValue
# 1. 対象の人数を確認する（書き込まない）
$env:MIGRATE_DRY_RUN = 'true'
pnpm migrate-user-roles
# 2. 移す（ロール worker のユーザーを、admin に）
Remove-Item Env:MIGRATE_DRY_RUN
pnpm migrate-user-roles
# 3. 環境変数を消す（ほかのコマンドが、AWS を向かないように）
Remove-Item Env:PERSISTENCE, Env:DYNAMODB_OBSERVATIONS_TABLE, Env:DYNAMODB_MAIN_TABLE -ErrorAction SilentlyContinue
```

- 出力は、人数だけ（ユーザー ID・名前は出さない）。例: `ロール「worker」のユーザー 2 人を、「admin」に移しました`
- 何度実行しても同じ（移す対象がなければ、何もしない）。途中で失敗しても、再実行できる。移す先・移す元は、`MIGRATE_TO_ROLE`・`MIGRATE_FROM_ROLE` で変えられる（既定は、`admin`・`worker`）
- AWS の認証情報・権限が足りないときは、エラーの名前だけが出る（`AccessDeniedException` など）。DynamoDB の読み書きの権限（開発サイトでは、`pnpm initial-user` と同じプロファイル）が要る
- 移したあとは、管理者でログインし、「設定 > ユーザー」で、一般にしたいユーザーのロールを、一般に変える。確認: 管理者のメニューに「ユーザー」「取り込み」が出ること、一般のユーザーのメニューには出ないこと
- ロールを戻す必要があるときは、新しい版のロール定義に `worker` がないため、このコマンドでは戻せない（画面で、ロールを変える）

### 8.8 既存の通知の移行（Issue #331。ユーザーが実行）

通知を、閲覧できる利用者にだけ表示・配信するため、通知に、閲覧範囲のハウス（`facilityId`）と、ハウスごとのカウンター（通知の総数・利用者ごとの既読数）を持たせた。**それ以前の通知には、どちらもない**ため、新しい版を AWS にデプロイしたあとに、次の手順で補う。移行の前は、ハウスの情報がない通知は、一般ユーザーには見えず、一般ユーザーの未読の件数は、低く出る（安全側。管理者は、変わらない）。

```powershell
# PowerShell の例。<…> を、置き換える
$env:AWS_PROFILE = '<プロファイル名>'
$env:AWS_DEFAULT_REGION = 'ap-northeast-1'
$stack = 'SfmData'   # 本番サイトは 'SfmProductionData'
$data = aws cloudformation describe-stacks --stack-name $stack --region ap-northeast-1 --query "Stacks[0].Outputs" | ConvertFrom-Json
$env:PERSISTENCE = 'dynamodb'
$env:DYNAMODB_OBSERVATIONS_TABLE = ($data | Where-Object { $_.OutputKey -eq 'ObservationsTableName' }).OutputValue
$env:DYNAMODB_MAIN_TABLE = ($data | Where-Object { $_.OutputKey -eq 'MainTableName' }).OutputValue
# 1. 対象の件数を確認する（書き込まない）
$env:MIGRATE_DRY_RUN = 'true'
pnpm migrate-notification-counters
# 2. 移す（通知にハウスを補い、ハウスごとのカウンターを再集計する）
Remove-Item Env:MIGRATE_DRY_RUN
pnpm migrate-notification-counters
# 3. 環境変数を消す（ほかのコマンドが、AWS を向かないように）
Remove-Item Env:PERSISTENCE, Env:DYNAMODB_OBSERVATIONS_TABLE, Env:DYNAMODB_MAIN_TABLE -ErrorAction SilentlyContinue
```

- 出力は、件数だけ（通知の内容は出さない）。例: `通知 120 件を確認し、118 件にハウスを補いました。ハウスごとのカウンターを、再集計しました（ハウス 2 つ・利用者 5 人）`
- 何度実行しても同じ（カウンターは、通知・既読の記録から、絶対値で書く）。途中で失敗しても、再実行できる。実行の間に作られた通知・既読が、反映されないことがある（再実行で直る）
- ハウスに属さない通知（取り込みの失敗・取得停止・連携の期限切れ）と、設備が見つからない通知は、ハウスを補わない（全設備を閲覧できる利用者〔管理者〕だけが、見える）
- コマンドは、手元のソースの、新しい版（`develop` の最新）で実行する。AWS の認証情報・DynamoDB の読み書きの権限が要る（8.7 と同じプロファイル）
- 確認: 一般ユーザーでログインし、通知の一覧・ヘッダーの未読の件数が、割り当てたハウスの通知だけであること

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
| ファイルサーバーのモックの S3 | あり（デモが置く） | あり（**空のまま**。HTTP のアダプタは、#119 で実装済み。実ファイルサーバーに切り替えるまで、空のまま。Lambda の取り込みの失敗を避けるため） |
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

- 最初のユーザーのロールは、ロール定義の最初の、ユーザー管理の権限を持つロール（既定のロールでは、管理者 `admin`）。2 人目以降は、管理者が、画面（ユーザー管理）で作る

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

ADR-0013 の 6 の表のとおり（ユーザーが確定した。2026-10-22。Issue #117）。**実データを入れる前に、Issue #115・#102・#127・#128 を完了させる**（取り込み元の実ファイルサーバーの接続 #298 も要る。HTTP のアダプタ #119 は、実装済み）。保管の期間（1 年分）は、保存期間の確認後に見直す。要点: 個人情報は入れない／ユーザー名・ID は匿名の識別子／ログに実データ・個人情報・認証情報を出さない／最初は管理者だけ／バックアップは PITR 35 日 + 開始前のオンデマンド。

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
| 10 秘密情報（パラメータストア）の IAM の権限（Issue #206） | **開発サイトで確認済み**（2026-11-05。ユーザーが実行。10.3 の IAM のシミュレーター。環境変数・パラメータストアの権限・暗号化の鍵の権限が、すべて期待どおり）。実際の暗号化・復号は、#207・#241 で、秘密情報を使うときに確認する。**本番サイトは、未実施** |
| 9.4 ロールバック・9.6 バックアップ | 未実施（開発サイトの同等の手順は、確認済み: 7.3・backup-restore.md・commands.md） |

## 10. 秘密情報（パラメータストア）の運用手順（Issue #206。ADR-0016 の D-55・ADR-0009）

接続先の認証情報（ファイルサーバー・農業情報基盤）と、Web Push の秘密鍵（VAPID）は、**AWS Systems Manager パラメータストアの SecureString（標準）**に保管する。値は、AWS の管理の鍵で暗号化される。**AWS への接続・値の登録は、ユーザーが行う**（AGENTS.md 12 章。値を、チャット・Issue・PR・リポジトリに書かない）。

### 10.1 構成

| 項目 | 内容 |
|------|------|
| パス | `/sfm/<環境>/<種類>/<名前>`。環境は、`development`（開発サイト）・`production`（本番サイト）。種類の例: `file-server`・`federation`・`web-push` |
| 参照名（アプリ） | `<種類>/<名前>`（例: `file-server/robot`・`web-push/vapid-private-key`）。小文字・数字・`.`・`_`・`-` の 1〜4 階層（1 階層 64 文字まで）。それ以外は、アプリが、拒否する |
| 権限（IaC） | API の Lambda: そのパスの下の `ssm:GetParameter`・`ssm:PutParameter`。ジョブの Lambda: `ssm:GetParameter` だけ。暗号化の鍵（AWS の管理の鍵）は、パラメータストア経由（`kms:ViaService`）の利用に限る。**開発サイトの権限では、本番のパス（`/sfm/production/`）を読めない** |
| 環境変数（Lambda） | `CREDENTIAL_STORE=ssm`・`CREDENTIAL_PATH_PREFIX=/sfm/<環境>/`（秘密ではない。IaC が設定する） |
| キャッシュ | アプリは、読み取りの結果を、5 分、Lambda の実行環境の中で持つ。値を更新したあと、ほかの実行環境が、新しい値を使うまで、最長 5 分。接続先の認証に失敗したときは、アプリが、すぐ取り直す |
| 上限 | 1 つの値は、4 KB まで（標準のパラメータの上限）。空の値は、保存できない |
| 値の形式（ファイルサーバーの認証情報。#172） | 参照名は `file-server/<取り込み元の識別子>`（`robot`・`environment-sensor`）。認証方式ごとに、Basic は JSON `{"username":"…","password":"…"}`（ユーザー名に `:` を含めない）、Bearer はトークンの文字列、API キーは API キーの文字列（送るヘッダー名は、画面で設定）。Bearer・API キーは、前後の空白・改行を取り除く。表示できる ASCII だけ（ヘッダーの注入を避ける）。形式が違うと、接続テスト（SC-11）が「認証情報の形式が正しくありません」になる。登録のあとは、接続テストで確かめる（ADR-0022） |

### 10.2 値の登録・更新

- **ファイルサーバーの認証情報**（`file-server/<取り込み元>`）は、管理者が、SC-11（取り込み設定・状況）の「認証情報」から、書き込み専用で登録する（#207。上書きのみで、保存後は再表示しない。「設定済み／未設定」と更新日時を示す）。次の手動の手順は、画面がない値（Web Push の秘密鍵など）に使う

- 値は、コマンドの履歴に残らない方法で渡す（例: PowerShell で、`Read-Host -AsSecureString` で受け取った値を使う。値を、コマンドの引数に直接書かない）。
- 作成・更新の例（`<値のファイル>` は、値だけを書いた、一時のファイル。登録後に、安全に削除する）:

```powershell
aws ssm put-parameter --name /sfm/development/web-push/vapid-private-key --type SecureString --tier Standard --overwrite --value file://<値のファイル>
```

- 状態の確認（**値は、復号しない**。`--with-decryption` を付けない）:

```powershell
aws ssm get-parameter --name /sfm/development/web-push/vapid-private-key --query "Parameter.LastModifiedDate"
```

- 本番サイトは、パスを `/sfm/production/…` にして、同じ手順で登録する。**開発サイトと本番サイトで、同じ値を使い回さない**（security.md）。
- 削除は、アプリからは、しない（ユーザーが、AWS で行う）。

### 10.3 IaC の適用後の確認（IAM。値を使わずに確認できる）

アプリが、秘密情報を使う処理は、ファイルサーバーの認証情報（#207。SC-11 の登録と接続テスト）が入った。HTTP の取得（#119。認証情報の読み出しを含む）も入った。Web Push の秘密鍵（#241。実配信の設定と実機での確認は 8.6）も入った。実行時の確認の範囲は、これらに限られる。**適用後は、IAM のシミュレーターで、権限を確認する**（ユーザーが実行）。プロファイル（`$env:AWS_PROFILE`）とリージョン（`--region ap-northeast-1`）を指定し、対象が大学のアカウントであることを、`aws sts get-caller-identity` で確認してから行う。

- **リソースは、1 つずつ**シミュレートする。**複数のリソースを渡すと、判定が、操作ごとに 1 つにまとめられ**（1 つでも許可されないと、全体が implicitDeny）、期待どおりの設定でも、すべて implicitDeny に見える。
- API・ジョブの Lambda の実行ロールは、スタックの出力（`ApiFunctionName`・`JobFunctionName`）の関数から、`aws lambda get-function-configuration --query Role` で取る。

```powershell
$env:AWS_PROFILE = '<プロファイル名>'
$region = 'ap-northeast-1'
$account = aws sts get-caller-identity --region $region --query Account --output text
$dev  = "arn:aws:ssm:${region}:${account}:parameter/sfm/development/file-server/robot"
$prod = "arn:aws:ssm:${region}:${account}:parameter/sfm/production/file-server/robot"
foreach ($role in $apiRole, $jobRole) {
  foreach ($target in @(@('development', $dev), @('production', $prod))) {
    "---- $($role.Split('/')[-1]) × $($target[0])"
    aws iam simulate-principal-policy --policy-source-arn $role --action-names ssm:GetParameter ssm:PutParameter ssm:DeleteParameter --resource-arns $target[1] --query "EvaluationResults[].[EvalActionName,EvalDecision]" --output text
  }
}
```

| ロール × パス | GetParameter | PutParameter | DeleteParameter |
|---------------|--------------|--------------|-----------------|
| API × `/sfm/development/…` | allowed | allowed | implicitDeny |
| API × `/sfm/production/…` | implicitDeny | implicitDeny | implicitDeny |
| ジョブ × `/sfm/development/…` | allowed | implicitDeny | implicitDeny |
| ジョブ × `/sfm/production/…` | implicitDeny | implicitDeny | implicitDeny |

暗号化の鍵（`kms:ViaService` の条件）は、鍵の ARN（`arn:aws:kms:<リージョン>:<アカウント ID>:key/<任意の ID>`）に対して、`--context-entries "ContextKeyName=kms:ViaService,ContextKeyValues=ssm.<リージョン>.amazonaws.com,ContextKeyType=string"` を付けて、`kms:Decrypt`・`kms:Encrypt`・`kms:GenerateDataKey` を確認する。

| ロール | 条件あり（パラメータストア経由） | 条件なし（直接の利用） |
|--------|----------------------------------|------------------------|
| API | `Decrypt`・`Encrypt`・`GenerateDataKey` が allowed | `Decrypt` は implicitDeny |
| ジョブ | `Decrypt` が allowed。`Encrypt`・`GenerateDataKey` は implicitDeny | `Decrypt` は implicitDeny |

**シミュレーターの限界**: 見るのは、ロールの IAM のポリシーだけ。AWS の管理の鍵（`alias/aws/ssm`）のキーポリシーは、評価しない。実際に、暗号化・復号できるかは、秘密情報を使う処理（#207・#241）が入ったときに、確かめる（足りなければ、`AccessDeniedException`）。

**確認済み**: 開発サイトで、2026-11-05（ユーザーが実行。Issue #206。PR #290 のブランチの「Deploy development」のあと）。環境変数（`CREDENTIAL_STORE=ssm`・`CREDENTIAL_PATH_PREFIX=/sfm/development/`。API・ジョブの両方）、上の 2 つの表の、すべての判定が、期待どおりだった。アカウント ID は、記録しない（リポジトリ・Issue・PR に書かない）。**本番サイトは、本番のデプロイ（`main` へのマージ）のあとに、パスを `/sfm/production/` にして、同じ確認を行う**（未実施）。

### 10.4 障害時

- 「秘密情報を読み取れませんでした」「秘密情報を保存できませんでした」が出るとき: ログの `errorName`（エラーの種類の名前だけ。値・AWS のエラーの内容は、ログに出さない）を確認する。`AccessDeniedException` なら、10.3 の IAM と、暗号化の鍵の権限を確認する。`ThrottlingException` は、時間をおいて、再び試す。
- 認証に失敗する（接続先の認証情報を、AWS で更新した直後）: アプリは、認証の失敗で、すぐ取り直す。それでも失敗するときは、最長 5 分待つ。
