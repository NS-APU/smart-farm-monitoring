# 運用手順（起動・設定・障害対応の骨子）

目的: アプリの起動・設定の確認・日々の運用・障害対応の手順の骨子を示す（NFR-6.1・NFR-6.2）。ローカル実行の手順は、現在の実装に基づく。本番（AWS）のデプロイ・ロールバック・IaC は、AWS 環境の確定（NFR-1.2）と本番アダプタの実装（as-built.md）の後に、追記する（各節の TODO）。バックアップ・復元は [backup-restore.md](./backup-restore.md)。

## 1. 環境ごとの設定（必須の確認）

環境変数の一覧は、`.env.example` と [dev_spec.md](../10_design/functions/dev_spec.md) 3.3 にある。共有・本番の環境では、次を確認してから起動する。

| 変数 | 本番・共有環境での値 | 理由 |
|------|----------------------|------|
| `APP_MODE` | `production`（本番）。Lambda は、**必ず明示する**（未設定は起動エラー） | 既定の `local` は、開発用の設定 |
| `PERSISTENCE` | `dynamodb`（本番。Lambda は、`SfmData` の出力から、環境変数を設定する。Issue #75。`DYNAMODB_OBSERVATIONS_TABLE`・`DYNAMODB_MAIN_TABLE` に、`SfmData` のスタックの出力のテーブル名を指定する。`DYNAMODB_ENDPOINT` は、本番・共有環境では指定しない）。Lambda は **必ず明示する**。Lambda で `file` は使えない（読み取り専用のファイルシステム・複数の実行環境） | メモリのみ・ローカルのファイルは、データが失われる・分裂する |
| `AUTH_PROVIDER` | `cognito`（Amazon Cognito。ADR-0008）。`COGNITO_USER_POOL_ID`・`COGNITO_CLIENT_ID` に、`SfmData` のスタックの出力を指定する。`PERSISTENCE=dynamodb` が必要。`INITIAL_USER_*` とは併用できない。ローカル・テストは、既定の `local` | 本番の Lambda は、パスワードを Cognito に預ける（アプリ内の認証は、セッションをメモリに持つため、Lambda では使えない） |
| `DEV_API_ENABLED` | 指定しない（無効）。`production` では、指定しても無効 | 開発用 API は、全データの消去・時計の操作・ジョブの強制実行を含む |
| `ROLE_DEFINITIONS_JSON`・`INITIAL_USER_ROLE` | 権限を分けたロール定義を指定する。未指定だと、全利用者が全権限を持つ1ロールで動作し、起動時に警告が出る | 最小権限（security.md）。ロールの分け方は発注者の判断待ち（Q-017） |
| `TRUSTED_PROXY_HOPS` | 評価環境（CloudFront → 関数の URL）は、`2`（末尾から 2 番目が、利用者の IP。IaC で設定する。**AWS で、ログの `clientKey` が利用者の IP になることを確認する**。ADR-0009）。既定の 0 は、`X-Forwarded-For` を信頼しない | ログインの試行回数の制限の接続元。偽装の防止（V-007） |
| `SEED_MODE` | `NONE` | デモデータを混ぜない |
| `INITIAL_USER_*` | ローカルのみ（`AUTH_PROVIDER=cognito` では、使えない。最初のユーザーは、手元で `pnpm initial-user` を 1 回だけ実行して作る。commands.md）。初回のみ。初回のログイン後に、パスワードを変更する（ユーザー管理）。秘密情報として扱い、リポジトリ・ログに残さない | security.md |

起動時のログに、警告（「開発用 API が有効です」「既定のロール…で動作しています」）が出ていないことを確認する。

## 2. 起動・停止（ローカル実行）

- 起動: `pnpm dev:backend`（バックエンド）、`pnpm dev:frontend`（画面）。手順は [commands.md](../00_project/commands.md)
- 停止: `SIGINT`・`SIGTERM`（Ctrl+C）で、未保存のデータを書き出してから終了する。書き出しに失敗した場合は、ログに記録し、終了コード 1 で終了する
- 起動に失敗した場合: ログのエラーを確認する。データファイルが読めない場合は、[backup-restore.md](./backup-restore.md) の「データファイルが読み込めないとき」

## 3. ログの見方

構造化ログ（JSON。1行1イベント）を標準出力へ出す。主な項目: `time`・`level`・`message`・`requestId`・`userId`・`equipmentId`。パスワード・トークンなどの秘密情報は、値がマスクされる。

| 事象 | ログのメッセージ・`event` | 対応 |
|------|----------------------------|------|
| ログインの成功・失敗・制限・ログアウト | `auth.login.succeeded`・`auth.login.failed`・`auth.login.locked`・`auth.logout`・`auth.refresh.failed` | 失敗が続く接続元・ユーザーIDを確認する（不正なログインの試行） |
| 想定外のエラー（バグ・データの不整合） | `想定外のエラーが発生しました`（`errorName`・`errorMessage`・`errorCause`・`errorStack`・`path`） | 原因の調査。利用者への応答には、内部情報を含めない |
| 取り込みの失敗 | `ファイルの取り込みに失敗しました`・`ファイルを読めませんでした`・`ファイルの一覧の取得に失敗しました`（`sourceId`・`fileId`） | ファイルサーバーの接続・ファイルの形式を確認する。画面の取り込みログ（取り込み設定）にも記録される |
| ジョブの失敗・タイムアウト | `ジョブの実行に失敗しました`（`jobId`・`errorName`） | `OperationTimeoutError` は、外部通信が応答しなかった（既定: 通信30秒・ジョブ10分） |
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
| 費用の確認 | 月次 | TODO: AWS の費用の監視（NFR-1.5）。構成の確定後に定める |

## 6. 配信（画面）の前提（本番のデプロイ時に反映する）

画面は、ブラウザの History API でルーティングする SPA。静的配信（Amplify・S3 + CloudFront）で、次を満たす設定が必要になる（TODO: IaC・デプロイの手順に含める。V-146）。

- 深い URL（例: `/viewpoints/harvest-accuracy`）の再読み込みを、`index.html` へ書き換える（404 にしない）
- `index.html` のキャッシュは短く、`assets/`（ハッシュつきのファイル名）は長く
- サービスワーカー（`/sw.js`）・マニフェストは、サイトのルート（`/`）で配信する（サブパスでの配信は、ルーティング・Web Push が動かない）
- API（`/api/v1/*`）は、同じオリジンから配信する（CloudFront で、Lambda へ振り分ける）か、API のオリジンを許可する CORS・API の接続先の設定を追加する（TODO: 配信構成の確定。V-136）
- セキュリティヘッダー（HSTS・CSP・`frame-ancestors`・`Referrer-Policy`）を、配信側にも設定する。API の応答には、バックエンドが付けている（V-015）

## 7. デプロイ・ロールバック・IaC（TODO）

AWS 環境・IaC（NFR-6.6）の確定後に、次を記載する。

- デプロイの手順（フロントエンドのビルド `pnpm build`、バックエンドのバンドル、関数・DynamoDB・EventBridge の構成）
- ロールバックの手順（前の版への切り戻し）と、判断の基準
- 障害時の連絡先・エスカレーション（運用体制 NFR-6.8）
