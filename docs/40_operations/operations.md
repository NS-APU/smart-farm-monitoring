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
| `ROLE_DEFINITIONS_JSON`・`INITIAL_USER_ROLE` | 権限を分けたロール定義を指定する。未指定だと、全利用者が全権限を持つ1ロールで動作し、起動時に警告が出る | 最小権限（security.md）。ロールの分け方は発注者の判断待ち（Q-017） |
| `TRUSTED_PROXY_HOPS` | 評価環境（CloudFront → 関数の URL）は、**設定しない（0）**。関数の URL が `X-Forwarded-For` を切り詰めるため、段数では識別できず、`1` 以上にすると偽装できる（ADR-0010）。既定の 0 は、`X-Forwarded-For` を信頼しない | ログインの試行回数の制限の接続元。偽装の防止（V-007） |
| `CLIENT_IP_HEADER` | 評価環境は、`x-sfm-viewer-ip`（IaC で設定する。CloudFront の Function が、利用者の IP を入れる）。**AWS で、ログの `clientKey` が利用者の IP になることを確認する**（ADR-0010） | ログインの試行回数の制限の接続元（V-007）。CloudFront を経由しない呼び出しでは、クライアントが値を付けられる |
| `SEED_MODE` | `NONE` | デモデータを混ぜない |
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
| 依存パッケージの更新・脆弱性の確認 | 月次 | `pnpm audit`（TODO: 自動化。CI の整備後） |

## 6. 配信（画面）の前提（本番のデプロイ時に反映する）

画面は、ブラウザの History API でルーティングする SPA。静的配信（Amplify・S3 + CloudFront）で、次を満たす設定が必要になる（TODO: IaC・デプロイの手順に含める。V-146）。

- 深い URL（例: `/viewpoints/harvest-accuracy`）の再読み込みを、`index.html` へ書き換える（404 にしない）
- `index.html` のキャッシュは短く、`assets/`（ハッシュつきのファイル名）は長く
- サービスワーカー（`/sw.js`）・マニフェストは、サイトのルート（`/`）で配信する（サブパスでの配信は、ルーティング・Web Push が動かない）
- API（`/api/v1/*`）は、同じオリジンから配信する（CloudFront で、Lambda へ振り分ける）か、API のオリジンを許可する CORS・API の接続先の設定を追加する（TODO: 配信構成の確定。V-136）
- セキュリティヘッダー（HSTS・CSP・`frame-ancestors`・`Referrer-Policy`）を、配信側にも設定する。API の応答には、バックエンドが付けている（V-015）

## 7. 評価環境（AWS）のデプロイ・ロールバック・初期化・障害時の確認

顧客評価環境（サーバーレス構成。ADR-0006）の最小の運用手順（Issue #80）。環境の作り方（初回の設定・bootstrap・OIDC のロール）は [commands.md](../00_project/commands.md) の「評価環境（IaC）」。

**確認状況**: 手順は、コード（`infra/`・`.github/workflows/`）と AWS の公式ドキュメントから書いた。**実機（AWS）での確認の状況は、下の表**（2026-10-20 に、ユーザーが、手元から実行して確認した）。AWS に接続する操作は、ユーザーが実行する（AGENTS.md 12 章）。

| 手順 | 実機の確認 |
|------|------------|
| 7.2 デプロイ | 手元からのデプロイ（`diff` → `deploy`）と、GitHub Actions 経由（「Deploy evaluation」。API の Lambda・Cognito・DynamoDB の構成）の両方を、**確認済み**（手元: 2026-10-20、GitHub Actions: PR #104 のマージ後。ユーザーが実行） |
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
3. GitHub の Actions → 「Deploy evaluation」→ Run workflow（ブランチ: `develop`）。画面のビルド（`pnpm build`）のあと、`cdk deploy --all` が動く。実行中のデプロイは、止めない（CloudFormation の更新が、途中で止まるため）
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
- 2 人目以降は、画面の「ユーザー管理」で作る

### 7.5 データの初期化

- **評価環境のデータを、すべて消して、空から作り直す**（ユーザーを含む。**元に戻せない**。**評価環境は、削除から再作成の完了まで、使えない**）。**確認済み**（2026-10-21。Issue #77）。実行の前に、必要なら、オンデマンドバックアップを取る（[backup-restore.md](./backup-restore.md)）。手順の詳細は、[commands.md](../00_project/commands.md) の「削除と再作成」の「データ（DynamoDB のテーブル）の削除」:
  1. 削除前の値（テーブル名・ユーザープールの ID・`SiteUrl`）を控える
  2. **評価環境（`SfmEvaluation`）を、先に削除する**（`pnpm build` → `pnpm --filter @smart-farm/infra run destroy`。約 10 分。`SfmData` の出力を参照しているため、先に削除しないと、`SfmData` を削除できない）
  3. データのスタック（`SfmData`）を削除する（スタックの削除の保護を無効にして `destroy:data`）。テーブル・ユーザープールは、残る（RETAIN）
  4. テーブルを削除する（削除の保護を無効にして `delete-table`）
  5. Cognito のユーザープールを削除する（コンソールで、削除の保護を無効にして削除）
  6. 再作成する（GitHub Actions の「Deploy evaluation」。**`SiteUrl` は、新しくなる**）。新しいテーブル名・ユーザープールの ID・`SiteUrl` を、控える
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
| デプロイの直後から、おかしい | 7.3 のロールバック |

- 障害時の連絡先・エスカレーション（運用体制）: TODO（NFR-6.8。体制が決まったら）
