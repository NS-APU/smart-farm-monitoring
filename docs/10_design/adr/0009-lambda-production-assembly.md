# ADR-0009 API の Lambda で、本番モード（DynamoDB・Cognito）の組み立てを動かす

- ステータス: 承認（2026-10-16。ユーザーの判断。Issue #75）。ただし、「6. 利用者の接続元の識別」は、AWS での確認で想定が誤っていたため、[ADR-0010](./0010-client-ip-from-cloudfront-function.md) で置換した（2026-10-20）
- 日付: 2026-10-16
- 関連: [ADR-0002](./0002-deployment-serverless.md)、[ADR-0006](./0006-iac-cdk-and-same-origin-delivery.md)、[ADR-0007](./0007-dynamodb-table-design.md)、[ADR-0008](./0008-cognito-authentication.md)、[architecture.md](../architecture/architecture.md) 11 章・13 章、[security.md](../../20_development/security.md)

目的: API の Lambda を、仮の実装からバックエンド本体に置き換えるときの、設定・権限・配信経路・秘密情報の扱いの決定を残す。

## 背景

- Issue #73（DynamoDB）・#74（Cognito）で、本番用のアダプタ（Repository・認証）が揃った。一方、API の Lambda は、`/health` だけに答える仮の実装（`infra/lambda/api.ts`）で、バックエンド本体（`src/backend/runtime/lambda.ts`）は、`APP_MODE=production` を「未実装」として拒否していた。
- 顧客に評価いただく環境（Sprint 2）では、画面から、ログイン・設備の確認・評価結果の確認までが、実際の AWS 上で動く必要がある。

## 決定

### 1. 本番モードの必須の構成

- **`APP_MODE=production` は、`AUTH_PROVIDER=cognito` と `PERSISTENCE=dynamodb`（と、それぞれの設定）を必須にする**。満たさなければ、起動時に設定エラー（`ConfigError`）にする。本番で、ユーザー・データを失う・分裂する構成（アプリ内の認証・メモリ・ファイル）を、使えなくするため。
- Lambda の設定（`parseLambdaConfig`）は、これまでの制約（`APP_MODE`・`PERSISTENCE` の明示、ファイルの永続化の拒否、開発用 API の無効化）に加えて、次を行う。
  - **`SEED_MODE` が `NONE` 以外なら、設定エラー**: コールドスタートのたびに、デモデータを投入しない。評価環境のデモデータは、別の入口で投入する（Issue #77）。
  - **スケジューラ（`SCHEDULER_ENABLED`）を、常に無効にする**: Lambda の中で、タイマーを動かさない。取り込み・評価のジョブは、EventBridge から起動する（Issue #76）。
- **モックのまま残すもの**: ファイルサーバー・農業情報基盤との連携・Web Push の配信は、評価環境では、モックで動かす（S3 のファイルのモックは Issue #77）。このため、取り込みの実行・テスト接続の API は、Issue #77 までは、失敗として応答する（Lambda は落ちない）。

### 2. 配信経路

CloudFront → 関数の URL（認証 `NONE`。同じオリジンの `/api/*`・`/health`。ADR-0006）→ Lambda（`src/backend/runtime/lambda.ts`）。画面と API が同じオリジンのため、CORS は不要。

### 3. 環境変数と秘密情報

- Lambda の環境変数は、次の 9 つ。`APP_MODE=production`・`PERSISTENCE=dynamodb`・`AUTH_PROVIDER=cognito`・`COGNITO_USER_POOL_ID`・`COGNITO_CLIENT_ID`・`DYNAMODB_OBSERVATIONS_TABLE`・`DYNAMODB_MAIN_TABLE`・`TRUSTED_PROXY_HOPS`・`LOG_LEVEL`。
- ID・テーブル名は、**秘密情報ではない**。値は、`SfmData` の出力（スタック間の参照）から取り、リポジトリには書かない。
- **現時点で、Lambda が持つ秘密情報は、ない**。AWS（DynamoDB・Cognito）へは、Lambda の IAM ロールで認証する（アクセスキーを持たない）。パスワード・トークン・キーに当たる名前の環境変数は持たない（テストで確認する）。開発用 API・デモデータ・初期ユーザー（`INITIAL_USER_*`）の設定も、持たない。
- **秘密情報を扱う口（`SecretPort`）と、AWS Systems Manager パラメータストア（SecureString）の実装は、今回は行わない**（ユーザーの判断）。必要になるのは、実際の農業情報基盤の認証情報や、Web Push の秘密鍵（VAPID）を、モックから実物に替えるとき。そのときの設計は、次のとおり。
  - アプリケーション層に、`SecretPort`（名前から値を取得する）を置き、インフラ層に、パラメータストアのアダプタを置く。値は、コールドスタートで 1 度だけ取得してキャッシュし、ログ・エラーの本文に出さない。
  - パラメータは、SecureString。Lambda のロールに、**そのパラメータの ARN に限った** `ssm:GetParameter`（と、KMS の復号）を付ける。環境変数には、パラメータの名前だけを置く。
  - 費用が増える場合（Secrets Manager は、秘密 1 件あたり月額がかかる）は、パラメータストア（標準）を第一候補とする。

### 4. IAM（最小権限）

| 対象 | 許可する操作 | リソース |
|------|--------------|----------|
| DynamoDB | `GetItem`・`BatchGetItem`・`Query`・`PutItem`・`UpdateItem`・`DeleteItem`・`BatchWriteItem`・`ConditionCheckItem`（**`Scan` は、許可しない**） | `Observations`・`Main` の 2 テーブルと、それぞれの `/index/*` |
| Cognito | `AdminInitiateAuth`・`AdminCreateUser`・`AdminSetUserPassword`・`AdminDeleteUser`・`AdminUserGlobalSignOut` | ユーザープールの ARN |

`GetUser`・`GlobalSignOut` は、アクセストークンで認可される API のため、IAM の権限は要らない（ADR-0008）。ワイルドカードのリソース（`*`）の権限は、付けない。

### 5. リソースと配布物

- **メモリ 1024 MB・タイムアウト 29 秒**（初期値）。Lambda の CPU は、メモリに比例するため、コールドスタートと、DynamoDB・Cognito の呼び出しの待ちを、短くするために、256 MB より大きくする。タイムアウトは、CloudFront のオリジンの応答の上限（30 秒）の内側。実測による調整は、Issue #79。
- **AWS SDK も、esbuild のまとめ（1 ファイル）に含める**。Lambda の実行環境に含まれる SDK の版は、変わりうるため、テストした版を、そのまま動かす。まとめの大きさは、テストで上限（8 MB）を確認する。
- **CDK の資産のハッシュは、まとめた出力で決める**（`AssetHashType.OUTPUT`）。既定の、ソースのディレクトリ（`src/backend/runtime/`）のハッシュでは、ディレクトリの外のコード（`application`・`infrastructure` など）だけが変わったとき、デプロイしても、Lambda のコードが、更新されない。
- ログの保持期間は、1 か月のまま（費用。NFR-1.5・NFR-6.3）。

### 6. 利用者の接続元の識別（V-007）— **置換済み。[ADR-0010](./0010-client-ip-from-cloudfront-function.md) を参照**（以下は、当時の決定。関数の URL は、`X-Forwarded-For` を切り詰めるため、この方式は機能しなかった）

ログインの試行回数の制限（接続元ごと。ADR-0008）は、接続元を、`X-Forwarded-For` から取る。CloudFront は、利用者の IP を付け、関数の URL は、受け取った接続元（CloudFront の IP）を、末尾に付ける。

- `TRUSTED_PROXY_HOPS=2`（末尾から 2 番目が、利用者の IP）。クライアントが、先頭に偽の値を付けても、末尾から数えるため、利用者の IP の識別を、変えられない（テストで確認する）。
- `0`（信頼しない）にすると、接続元が、CloudFront の IP になり、**すべての利用者が、同じ制限を共有する**。このため、2 とする。
- **仮の値**。AWS で、CloudWatch のログインのログの `clientKey` が、利用者の IP になることを、確認する（Issue #75 の確認）。違えば、この値を直す。
- 認証のログに、IP が出る（個人情報としての扱いは、[security.md](../../20_development/security.md)）。

## 検討した代替案

| 案 | 採らなかった理由 |
|----|------------------|
| 本番でも、メモリ・アプリ内の認証を、許す | Lambda では、実行環境が複数あり、データ・セッションが、分裂・消失する（ADR-0008） |
| `SEED_MODE` を、Lambda の起動時にも、許す | コールドスタートのたびに投入が走り、遅くなる。複数の実行環境が、同時に投入する競合も起きる。デモデータは、別の入口で、1 度だけ投入する |
| 関数の URL の認証を `AWS_IAM` にして、CloudFront の OAC で署名する | 直接の呼び出しを防げるが、リクエストの本文の署名（POST のハッシュ）の扱いが増え、評価環境の構成が複雑になる。直接の呼び出しは、アプリの認証で守る（ADR-0006）。必要になれば、別に検討する |
| AWS SDK を、Lambda の実行環境のものに任せる（`external`） | まとめは小さくなるが、SDK の版が、テストした版と、ずれうる |
| 秘密情報の口（`SecretPort`）を、今、実装する | 現時点で、Lambda が持つ秘密情報がなく、使う場所のない実装になる。設計だけを、上記に残す |

## 結果・トレードオフ

- **関数の URL は、直接も呼べる**（ADR-0006）。保護は、アプリの認証（Cognito）のみ。ただし、接続元ごとの制限（`X-Forwarded-For`）は、直接の呼び出しでは、クライアントが付けた値に影響されうる（直接の呼び出しでは、末尾が、クライアントの IP になり、2 番目が、クライアントの付けた値になる）。ログインの総当たりへの防御は、Cognito の、ユーザーごとのロックに、依る部分がある（ADR-0008）。評価環境の範囲では、許容する。
- **モックの範囲が残る**: ファイルサーバー・農業情報基盤・Web Push は、モック。取り込みの実行は、Issue #77 までは、動かない。ジョブの定期起動は、Issue #76。
- **初回のデプロイは、`SfmData` の更新（出力の追加）が先に必要**（スタック間の参照のため）。`pnpm initial-user` で、最初のユーザーを作ってから、ログインを確認する。
- 評価環境の最初の呼び出し（コールドスタート）は、遅くなる（SDK を含む 1 ファイルの読み込み・DynamoDB・Cognito の接続）。実測と調整は、Issue #79。

## 検証（AWS。2026-10-20。ユーザーが実行）

評価環境（`SfmData` の更新 + `SfmEvaluation` のデプロイ。GitHub Actions）で、次を確認した。

| 項目 | 結果 |
|------|------|
| デプロイ | 成功（`SfmData` の出力の追加と、API の Lambda の置き換え） |
| 最初のユーザー | `pnpm initial-user` で作成できた（手元から。Cognito と DynamoDB） |
| `/health` | `ok` |
| ログイン（API・画面） | 成功。ユーザー情報が返る |
| 認証つきの呼び出し | `GET /users` が、自分 1 人の一覧を返す |
| トークンなし | 401 |
| 画面 | ログイン・ユーザー管理（自分が表示）・ログアウトができる。デモデータがないため、設備は空（想定どおり。Issue #77） |
| 初回のリクエスト（コールドスタート） | 体感で 1 秒以内（実測ではない。計測は Issue #79） |
| IAM（最小権限） | ログイン（AdminInitiateAuth）・GetUser・DynamoDB の読み書き（ユーザー・ログインの試行回数の記録）が成功した。ユーザーの作成・削除・パスワードの再設定・ログアウト（AdminCreateUser など）の権限は、画面での操作を確認していないため、未確認 |
| 接続元の識別 | **想定が誤っていた**（「6」）。[ADR-0010](./0010-client-ip-from-cloudfront-function.md) で置換し、修正後に確認した |

- **未確認**: メモリ 1024 MB・タイムアウト 29 秒が適切か（Issue #79 で実測する）、観測値テーブルを使う操作（一覧・評価。Issue #77・#79）。
