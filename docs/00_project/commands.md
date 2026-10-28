# よく使うコマンド

目的: 開発で繰り返し使うコマンドをまとめる。コマンドを追加・変更したら、実際に動くことを確認してから更新する。以下は、すべて実行して動作を確認したもの（2026-10-10、Node.js v25.9.0 / pnpm 12.8.2 / Windows）。構成の詳細は [dev_spec.md](../10_design/functions/dev_spec.md)。

## 前提

- Node.js 24 以上（`engines: >=24`）、pnpm（`packageManager: pnpm@12.8.2`）。pnpm は `npm install -g pnpm` で導入できる
- pnpm のスクリプトの中から、さらに `pnpm` を呼び出す書き方は、この環境では解決に失敗したため、使わない（スクリプトは、`vitest`・`playwright`・`vite` などを直接呼ぶ）
- Windows では、カレントディレクトリのドライブ文字の大文字・小文字が、モジュールの読み込みとカバレッジの計測に影響する。Git Bash から `node node_modules/vitest/vitest.mjs` を直接呼ぶ（`c:` の小文字になる）と、同じファイルが二重に読み込まれ、カバレッジが 0% になることがある。テストは、`pnpm`（`pnpm test:unit`・`pnpm exec vitest ...`）経由で実行する
- Windows の Git Bash では、`node -e "..."` の文字列の中のバックスラッシュ（正規表現の `\p`・`\x00` など）が落ちて、意図と違う動きになる。スクリプトは、ファイル（`.mjs`）に書いて `node ファイル.mjs` で実行する。また、git の `リビジョン:パス`（例: `HEAD:src/a.ts`）は、パスが変換されるため、`MSYS_NO_PATHCONV=1` を付けて実行する
- 単体・結合のテスト（`pnpm test:unit`）は、DynamoDB アダプタの契約テストのため、**DynamoDB Local（AWS の公式の配布物。Java で動く）が必要**。次のどちらかを、環境変数で指定する（どちらもなければ、DynamoDB のテストが、設定を促すエラーで失敗する。スキップはしない）。手順は、「DynamoDB Local」の節
- E2E は、ポート 5173（Vite）・8787（バックエンド）を使う。空いていること（別の E2E・開発サーバーが動いていないこと）を確認してから実行する。全 E2E の所要時間は、約 45 分

```bash
# セットアップ（依存パッケージのインストール）
pnpm install

# Playwright のブラウザ（chromium）のインストール（E2E テストの前に1回）
pnpm exec playwright install chromium

# 開発サーバ起動
pnpm dev:backend     # バックエンド（Node サーバー。http://127.0.0.1:8787）。.env があれば読み込む
pnpm dev:frontend    # フロントエンド（Vite。http://127.0.0.1:5173。/api/v1 をバックエンドへ中継）

# ビルド
pnpm build           # フロントエンドを dist/frontend へ出力

# テスト（全体）: 単体・結合（カバレッジつき）→ E2E。出力は ./test-result/
pnpm test

# テスト（単一ファイル）
pnpm exec vitest run tests/unit/shared/shared.test.ts
pnpm exec playwright test tests/e2e/UC-06-record-recovery.ts            # E2E（ユースケースごと）
pnpm exec playwright test tests/e2e/UC-12-manage-equipment.ts -g "運用の一連"   # E2E（テスト名で絞り込み）
pnpm exec playwright test tests/e2e/scenario-outage-recovery.ts           # E2E（複数のユースケース・利用者をまたぐシナリオ）

# テスト（単体・結合のみ / E2E のみ）
pnpm test:unit
pnpm test:e2e

# データファイル（PERSISTENCE=file）のバックアップ・復元（手順は docs/40_operations/backup-restore.md）
pnpm data:backup backup [--keep N]
pnpm data:backup list
pnpm data:backup restore store-<日時>.json

# 最初のユーザー（管理者）の作成（Cognito。手元で 1 回だけ。環境変数と手順は「最初のユーザー（Cognito）」の節）
pnpm initial-user

# Lint / 型検査 / フォーマット
pnpm lint            # ESLint（eslint .）→ oxlint（jsx-a11y。.oxlintrc.json）
pnpm typecheck
pnpm format          # 整形して書き込む
pnpm format:check    # 整形の確認のみ
```

## DynamoDB Local（DynamoDB アダプタのテスト・ローカルの開発）

DynamoDB アダプタ（`src/backend/infrastructure/dynamodb/`。[ADR-0007](../10_design/adr/0007-dynamodb-table-design.md)）の契約テストは、DynamoDB Local で実行する。Java 17 以上が必要（確認: `java -version`）。

1. **DynamoDB Local の入手（1 回）**: `https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.zip` をダウンロードし、同じ場所の `.sha256` の値と、ファイルの SHA-256 が一致することを確認して、リポジトリの外のディレクトリに展開する（`DynamoDBLocal.jar` と `DynamoDBLocal_lib/` ができる）。バージョンを固定した URL はなく、`latest` は更新されるため、CI は、ダイジェストで固定したコンテナのイメージを使う（`.github/workflows/ci.yml`）。**DynamoDB Local は、オープンソースではなく、AWS の独自のライセンス**（社内の業務の目的での利用は可。再配布・組み込みは不可。AWS のアカウントが有効であること）。リポジトリには含めない（詳細は `.license-check/license-report.md`）
2. **テストの実行**（どちらか）:
   - **自動で起動する**: 環境変数 `DYNAMODB_LOCAL_DIR` に、1. のディレクトリを指定する。テストの開始時に、空きポートで起動し、終了時に止める（vitest の globalSetup。`tests/support/dynamodb-local-global-setup.ts`）。例: `DYNAMODB_LOCAL_DIR=<ディレクトリ> pnpm test:unit`
   - **起動済みのものを使う**: `java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -sharedDb -port 18000` で起動し、`DYNAMODB_ENDPOINT=http://127.0.0.1:18000 pnpm test:unit`。CI は、同じダイジェストのコンテナのイメージを、取得して起動する（`.github/workflows/ci.yml` の「DynamoDB Local を起動する」。取得先は、ECR Public → mirror.gcr.io → Docker Hub の順）
3. テストは、テストごとに、名前が重複しないテーブルを作り、終了時に消す。認証情報は、ダミーの値（DynamoDB Local は、検証しない。**英数字だけ**にする。ハイフンを含むと拒否される）

アプリ全体を、DynamoDB Local で動かす（ローカルの確認用）:

```bash
# DynamoDB Local を起動したうえで（上の手順。ポートは、ほかの開発サーバーと重ならないものにする）
PERSISTENCE=dynamodb DYNAMODB_ENDPOINT=http://127.0.0.1:18000   DYNAMODB_OBSERVATIONS_TABLE=dev-observations DYNAMODB_MAIN_TABLE=dev-main   SEED_MODE=DEMO pnpm dev:backend
```

- `DYNAMODB_ENDPOINT` を指定すると、起動時にテーブルを作る（すでにあれば、そのまま使う）。AWS では、指定しない（テーブルは、IaC で作る。Lambda の実行ロールの認証情報を使う）
- `DEV_API_ENABLED`（リセットで全データを消す開発用 API）は、`PERSISTENCE=dynamodb` では使えない。`APP_MODE=production` は、`AUTH_PROVIDER=cognito` と `PERSISTENCE=dynamodb`（と、それぞれの設定）が必須で、Lambda の設定は、`SEED_MODE` も使えない（[ADR-0009](../10_design/adr/0009-lambda-production-assembly.md)）
- 2026-10-15 に、この構成（デモデータの投入・評価・通知・ログイン・観測値の一覧）が動くことを確認した（DynamoDB Local 3.3.1）

## 評価環境（IaC。`infra/`）

**状態**: 確認済み（2026-10-15。Issue #71・#87）。大学の AWS アカウント（東京リージョン）で、この節の手順（bootstrap・OIDC のロールの作成・GitHub の設定・GitHub Actions からのデプロイ・動作確認・削除と再作成）を実行し、すべて成功した。自動のトリガ（`develop` へのマージなど）は、まだない（手動実行のみ。方針は Issue #78 で決め、追加する）。

顧客評価環境（サーバーレス構成。[ADR-0006](../10_design/adr/0006-iac-cdk-and-same-origin-delivery.md)）を、AWS CDK で作る。リージョンは東京（ap-northeast-1）。画面（S3 + CloudFront）と、最小の API（`/health` だけに答える Lambda。関数の URL）が、CloudFront の同じオリジンで配信される。

データ（DynamoDB のテーブル。観測値の `Observations` と、そのほかの `Main`。**Cognito のユーザープールとアプリクライアント**。Issue #74）は、評価環境とは**別のスタック（`SfmData`）**で作る（Issue #73・#74。`deploy` に含まれる）。テーブル名・ユーザープールの ID は、CloudFormation が生成し、スタックの出力（`ObservationsTableName`・`MainTableName`・`UserPoolId`・`UserPoolClientId`）で参照する（確認: `aws cloudformation describe-stacks --stack-name SfmData --query "Stacks[0].Outputs"`）。**このスタックは、2026-10-16 に、ユーザーが AWS に適用し、動作を確認した**（下の「最初のユーザー（Cognito）」と「AWS に、手元のバックエンドを向けて確認する」）。データを消す手順（`destroy:data`）は、まだ実行していない。API の Lambda は、このスタックの出力（ID・テーブル名）を、環境変数に取り込む（Issue #75。ADR-0009）ため、**`SfmData` を更新（出力の追加）してから、評価環境をデプロイする**。

| 目的 | コマンド（リポジトリのルートで実行） | AWS への接続 |
|------|--------------------------------------|--------------|
| 画面のビルド（デプロイの前に必要） | `pnpm build` | なし |
| テンプレートの生成（検証） | `pnpm --filter @smart-farm/infra run synth` | なし（独自ドメインを指定しないとき） |
| 差分の確認 | `pnpm --filter @smart-farm/infra run diff` | あり |
| デプロイ（作成・更新） | `pnpm --filter @smart-farm/infra run deploy` | あり |
| 削除（評価環境のみ。データは残す） | `pnpm --filter @smart-farm/infra run destroy` | あり |
| 削除（データのスタック。データを失う） | `pnpm --filter @smart-farm/infra run destroy:data` | あり |
| 初回の bootstrap（東京） | `pnpm --filter @smart-farm/infra run bootstrap` | あり |
| 初回の bootstrap（us-east-1。独自ドメインのときだけ） | `pnpm --filter @smart-farm/infra run bootstrap:certificate` | あり |
| GitHub Actions 用のロールの作成・削除 | `pnpm --filter @smart-farm/infra run deploy:oidc` ・ `destroy:oidc` | あり |

- **AWS に接続するコマンドは、ユーザーが実行する**（AGENTS.md 12 章。AI エージェントは、AWS への適用をしない）。実行の前に、**対象の AWS アカウントのプロファイルを指定**する（別のアカウントに作らないため。ほかの用途のプロファイルでは、実行しない）。PowerShell: `$env:AWS_PROFILE = '<プロファイル名>'`、Git Bash: `export AWS_PROFILE=<プロファイル名>`。確認: `aws sts get-caller-identity`（出力のアカウント ID は、チャット・Issue・PR に貼らない）
- アカウント ID・ドメイン名・ホストゾーン名は、リポジトリに書かない。アカウントは、認証から自動で決まる。独自のサブドメインは、環境変数 `SFM_DOMAIN_NAME`（例: `evaluation.<ドメイン>`）・`SFM_HOSTED_ZONE_NAME`（例: `<ドメイン>`）の**両方**で指定する（未指定なら、cloudfront.net の URL）
- テスト（CDK の assertions）は、`pnpm test:unit` に含まれる（`infra/test/`）。`cdk synth` の結果（`infra/cdk.out/`）と、検索結果のキャッシュ（`infra/cdk.context.json`）は、Git 管理外

### 初回の設定（1 回だけ。ユーザーが手元から行う）

1. **認証**: 上のとおり、`AWS_PROFILE` を指定し、`aws sts get-caller-identity` で、大学のアカウントであることを確認する
2. **bootstrap**: `pnpm --filter @smart-farm/infra run bootstrap`。アカウントに、`CDKToolkit` のスタック（デプロイ用のロール・S3 バケットなど）を作る。既定の実行ポリシーは `AdministratorAccess` のため、IAM の権限で拒否されたら、`cdk bootstrap` の `--cloudformation-execution-policies` で、権限を絞ったポリシーを指定する（絞り込みは、未検討）。独自ドメインを使うときは、`bootstrap:certificate` も実行する（証明書は us-east-1）
3. **GitHub Actions 用のロール**: `pnpm --filter @smart-farm/infra run deploy:oidc`。GitHub の OIDC プロバイダーと、環境ごとのロール（開発サイト: `sfm-github-actions-deploy`、本番サイト: `sfm-github-actions-deploy-production`。Issue #117）を作る。出力の `DeployRoleArn`（開発）・`ProductionDeployRoleArn`（本番）を控える。ロールを引き受けられる条件（信頼ポリシーの `sub`）は、このリポジトリの GitHub のトークンの形式（不変の ID の形式。`infra/lib/config.ts` の `GITHUB_SUBJECT_PREFIX`）で書かれている。**すでに作成済みのときは、同じコマンドを実行すると、信頼ポリシーが更新される**（スタックの更新）。アカウントに、GitHub の OIDC プロバイダーが、すでにある場合は、環境変数 `SFM_GITHUB_OIDC_PROVIDER_ARN` に、その ARN を指定して実行する（1 つのアカウントに 1 つしか作れない）
4. **GitHub の設定**（リポジトリの Settings → Environments）: Environment `development`（開発サイト。旧 `evaluation`）を作り、デプロイできるブランチ（`develop`・`feature/*`・`release/*`・`hotfix/*`。PR の前の動作確認のため。Issue #131）と、必要なら承認者を設定する。Environment のシークレット `AWS_DEPLOY_ROLE_ARN` に、手順 3 の `DeployRoleArn` を設定する（ARN にアカウント ID が含まれるため、シークレットにする）。独自ドメインを使うときは、Environment の変数 `SFM_DOMAIN_NAME`・`SFM_HOSTED_ZONE_NAME` を設定する
5. **デプロイ**: GitHub の Actions → 「Deploy development」→ Run workflow（`develop` への push で、自動で始まる。Issue #89。手動実行も使える）。ログに出力される `SiteUrl` が、評価環境の URL
6. **確認**（ジョブは、7）: `<SiteUrl>/health` が、`{"status":"ok","time":"…"}` を返す。ブラウザで `<SiteUrl>` を開くと、ログイン画面が表示される。API は、バックエンド本体の Lambda（Issue #75。ADR-0009）のため、「最初のユーザー（Cognito）」の手順で作ったユーザーで、ログインできる。ログインの確認のあと、CloudWatch Logs の API の Lambda のロググループで、ログインのログ（`auth.login.succeeded`）の `clientKey` が、**自分の IP になっている**ことを確認する（CloudFront の Function が入れるヘッダー `x-sfm-viewer-ip` の確認。違えば、CloudFront のエッジの IP になっている。ADR-0010。Issue #100。**2026-10-20 に、確認済み**。自分の IP と一致した）
7. **ジョブ（EventBridge。Issue #76。ADR-0011）の確認**（**確認済み**。2026-10-20。結果は、ADR-0011 の「検証」）: スタックの出力 `JobFunctionName` の関数のロググループ（`aws lambda get-function-configuration --function-name <JobFunctionName> --query LoggingConfig.LogGroup`）で、`ジョブを終了しました`（`jobId`・`outcome`・`durationMs`）が、周期どおり（JB-01・JB-04 は 1 分、JB-02・JB-03 は 5 分）に出ること、`ジョブの実行に失敗しました` がないこと、IAM の不足（`AccessDeniedException`）がないことを確認する。**検索の文字列は、英数字だけにする**（Windows の PowerShell は、AWS CLI に渡す日本語を文字化けさせることがある。例: `--filter-pattern 'EXECUTED'`・`'level error'`）。`filter-log-events` に `--query "length(events)"` を付けると、改ページごとの件数が並ぶ（合計は足す）。取り込み元がまだない間は、JB-01 は、何も取り込まない（Issue #77 で、デモデータと S3 のファイルのモックを追加する）
8. **合成データの生成（デモ。Issue #77。ADR-0012）の確認**（**確認済み**。2026-10-20。結果は、ADR-0012 の「検証」）: スタックの出力 `DemoFeedFunctionName` の関数のロググループで、`合成データのファイルを置きました`（`files`: 8）が 15 分ごとに出ること、失敗（`level error`）がないこと。`aws s3 ls s3://<FileServerBucketName>/ --recursive` で、`robot/robot-<時刻>.json`・`environment-sensor/sensor-<時刻>.csv` が増えること（直近の区間の分。3 日で自動で消える）。`pnpm demo-data seed` でデモの設備を入れた状態で、取り込み（JB-01）が、置いたファイルを読み、画面のダッシュボードの「最終のデータ取得」が新しくなること。**検索の文字列は、英数字だけにする**（`EXECUTED`・`level error` など）

### 開発サイトと本番サイトの切り替え・Environment の改名の移行（Issue #117。ADR-0013）

- **サイトの環境は、環境変数 `SFM_ENVIRONMENT`（`development`・`production`）で指定する**。未設定は、**開発サイト**。`production` を指定すると、`diff`・`deploy`・`destroy`・`destroy:data` が、本番サイトのスタック（`SfmProductionData`・`SfmProductionEvaluation`・独自ドメインのとき `SfmProductionEvaluationCertificate`）だけを対象にする（開発サイトのスタックは、対象外）。本番の操作のあとは、必ず `Remove-Item Env:SFM_ENVIRONMENT` で消す。本番サイトの手順は、operations.md 9 章
- **開発サイトの GitHub の Environment を、`evaluation` から `development` に改名する**（Issue #117）。**次の順で、ユーザーが行う**:
  1. GitHub: Environment `development` を作る（デプロイできるブランチ: `develop`・`feature/*`・`release/*`・`hotfix/*`。シークレット `AWS_DEPLOY_ROLE_ARN` は、これまでと同じ値（開発サイトの `DeployRoleArn`）。独自ドメインの変数があれば、`evaluation` から写す）
  2. `pnpm --filter @smart-farm/infra run deploy:oidc`（開発サイトのロールの信頼条件を、`environment:development` に更新し、本番サイトのロールを作る。**開発サイトのロールは、置き換わらない**）。このコマンドの前に、`develop` に、ワークフローの改名（`deploy-development.yml`）が入っていること
  3. 「Deploy development」を実行して、開発サイトのデプロイが成功することを確認する。開発サイトの全リソースの `Environment` タグの値が、`development` に変わる（リソースの置き換えは、ない。`diff` で、タグの変更だけであることを確認できる）
  4. 古い Environment `evaluation` を削除する
- **状態: 実施済み**（2026-10-22。ユーザーが実施）。差分は想定どおり（置き換えなし）。「Deploy development」が成功し、`/health`・ログインを確認した。Environment `production`（ブランチ `main` のみ・承認者 T-Ishikawa-R・本番のロールのシークレット）も、作成済み（operations.md 9.9）
- **開発サイトに、PR の前に、ブランチを選んでデプロイする**（Issue #131）: Actions の「Deploy development」→ Run workflow → 「Use workflow from」で、ブランチ（`feature/*`・`release/*`・`hotfix/*`・`develop`）を選ぶ。コマンドなら `gh workflow run deploy-development.yml --ref <ブランチ>`。`main` は、選べない（Environment の制限）。確認のあとは、`develop` をデプロイして戻す

### トラブルシューティング（GitHub Actions の「AWS の認証（OIDC）」の失敗）

`Could not assume role with OIDC` / `Not authorized to perform sts:AssumeRoleWithWebIdentity` で失敗するときは、AWS のロールの信頼ポリシーの条件（`aud`・`sub`）が、GitHub のトークンと合っていない。失敗したジョブには、「OIDC トークンのクレームの表示」のステップが出て、トークンの `aud`・`sub` などを表示する（トークン自体は表示しない）。次を、見比べる。

| 項目 | 期待する値 |
|------|------------|
| `aud` | `sts.amazonaws.com` |
| `sub` | `<GITHUB_SUBJECT_PREFIX>:environment:development`（本番サイトは `:environment:production`）（例: `repo:NS-APU@<組織の ID>/smart-farm-monitoring@<リポジトリの ID>:environment:development`） |
| `environment` | `development`（開発サイト）・`production`（本番サイト） |

- **`sub` が、リポジトリの名前だけの形式（`repo:NS-APU/smart-farm-monitoring:…`）か、ID を含む形式かは、リポジトリの設定（`use_immutable_subject`）で決まる**。このリポジトリは、ID を含む形式（GitHub の新しい既定）。確認: `gh api repos/NS-APU/smart-farm-monitoring/actions/oidc/customization/sub`（`sub_claim_prefix` が、接頭辞）。接頭辞が変わったときは、`infra/lib/config.ts` の `GITHUB_SUBJECT_PREFIX` を直し、`deploy:oidc` を再実行する（Issue #87）
- `sub` が、期待と同じなのに失敗する: ロールの ARN（シークレット `AWS_DEPLOY_ROLE_ARN`）が、別のロール・古いロールのものになっていないか、AWS の CloudTrail（イベント履歴）で `AssumeRoleWithWebIdentity` の失敗の詳細を確認する
- `sub` が、`environment:development`（本番サイトは `environment:production`）で終わらない: ワークフローが、対応する Environment（`development`・`production`）で動いていない（ジョブの `environment:` と、デプロイできるブランチの設定を確認する）

手元からデプロイする場合（検証用）: `AWS_PROFILE` を指定して、`pnpm build` → `pnpm --filter @smart-farm/infra run deploy`。Windows・Linux のどちらでも動く（Lambda のコードは、esbuild の JS API でまとめる）。

### 削除と再作成

- 削除: `pnpm --filter @smart-farm/infra run destroy`。評価環境のスタック（`SfmEvaluation*`。本番サイトは `SfmProductionEvaluation*`。S3 のバケット・CloudFront・Lambda・ログ。独自ドメインのとき、証明書・DNS のレコードも）を、中身ごと削除する。**データのスタック（`SfmData`。本番サイトは `SfmProductionData`。DynamoDB のテーブル）、bootstrap、OIDC のロールは、残る**（評価環境を、削除・再作成しても、データを失わない）
- 再作成: 同じ手順（`deploy`、または GitHub Actions の「Deploy development」。本番サイトは「Deploy production」）。削除前と同じ構成が、コードから作られる
- **データ（DynamoDB のテーブル）の削除**（Issue #73。**AWS で確認済み**。2026-10-21。ユーザーを含む全データの削除 → 再作成 → 最初のユーザー → デモデータの投入が、成功した。operations.md 7.5）: `SfmData` のスタックは、誤って消さないよう、スタックの削除の保護と、テーブルの削除の保護を有効にし、スタックを削除してもテーブルを残す設定（RETAIN）にしている。データまで消すときだけ、次の順に行う。(0) **先に、評価環境（`SfmEvaluation`）を削除する**（`pnpm build` のあと、`pnpm --filter @smart-farm/infra run destroy`。約 10 分。`SfmEvaluation` は、`SfmData` の出力（テーブル名・ユーザープールの ID）を、スタック間の参照で使うため、CloudFormation は、参照されている出力を持つ `SfmData` の削除を、拒否する。今回の確認は、この順序で、成功した）。(1) テーブル名を控える（`SfmData` の出力 `ObservationsTableName`・`MainTableName`）。(2) `aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name SfmData`。(3) `pnpm --filter @smart-farm/infra run destroy:data`。(4) テーブルごとに、`aws dynamodb update-table --table-name <名前> --no-deletion-protection-enabled` のあと、`aws dynamodb delete-table --table-name <名前>`。(5) Cognito のユーザープール: AWS のコンソール（Cognito）で、削除の保護を無効にして、削除する（CLI の `update-user-pool` は、指定しない設定を既定値に戻すため、使わない）。**データ（ユーザーを含む）は、元に戻せない**（PITR を有効にしたテーブルを削除すると、削除の直前の「システムバックアップ」が 35 日、残る。AWS のドキュメントによる。実機では未確認。[backup-restore.md](../40_operations/backup-restore.md)。ただし、その時点より前には戻せず、Cognito のユーザーは含まれない）。実行の前に、必要なら、オンデマンドのバックアップを取る。(6) **再作成**: GitHub Actions の「Deploy evaluation」（`develop`）で、`SfmData`（新しいテーブル・ユーザープール）→ `SfmEvaluation` が作られる。**`SiteUrl`（CloudFront のドメイン）も、新しくなる**（独自ドメインを使うときは、変わらない）。続けて、最初のユーザー（`pnpm initial-user`）と、デモデータ（`pnpm demo-data seed`）。評価環境は、削除から再作成の完了まで、使えない
- OIDC のロールまで削除する: `pnpm --filter @smart-farm/infra run destroy:oidc`（GitHub Actions からデプロイできなくなる）。bootstrap（`CDKToolkit` のスタック）の削除は、通常は不要

### 最初のユーザー（Cognito。Issue #74。ADR-0008）

Cognito を使う構成（`AUTH_PROVIDER=cognito`）では、Lambda は、環境変数の初期ユーザー（`INITIAL_USER_*`）を読まない。`SfmData` を適用したあと、**ユーザーが、AWS のプロファイルを指定して、手元で、1 回だけ**、最初のユーザー（管理者）を作る。Cognito のユーザー（パスワードつき）と、DynamoDB のユーザーの記録（名前・ロール）を、同時に作る。ユーザーが 1 人でもいれば、何もしない（何度実行しても、既存のユーザーを上書きしない）。

```powershell
# PowerShell の例（値は、SfmData の出力。<…> を、置き換える）
$env:AWS_PROFILE = '<プロファイル名>'
$env:AUTH_PROVIDER = 'cognito'
$env:PERSISTENCE = 'dynamodb'
$env:COGNITO_USER_POOL_ID = '<UserPoolId>'
$env:COGNITO_CLIENT_ID = '<UserPoolClientId>'
$env:DYNAMODB_OBSERVATIONS_TABLE = '<ObservationsTableName>'
$env:DYNAMODB_MAIN_TABLE = '<MainTableName>'
$env:INITIAL_USER_ID = '<ユーザーID>'
$env:INITIAL_USER_NAME = '<ユーザー名>'
$env:INITIAL_USER_PASSWORD = '<パスワード（8 文字以上。英大文字・英小文字・数字を含む）>'
pnpm initial-user
Remove-Item Env:INITIAL_USER_ID, Env:INITIAL_USER_NAME, Env:INITIAL_USER_PASSWORD, Env:INITIAL_USER_ROLE -ErrorAction SilentlyContinue   # すべて消す（パスワードを残さない。ほかが残ると、同じターミナルで起動するバックエンドが、設定エラーになる）
```

- パスワードは、保存・出力されない。AWS のエラーは、**名前だけ**が出力される（メッセージに、アカウント ID・ARN が含まれることがあり、チャット・Issue・PR に貼らないため）。エラーの原因は、AWS のコンソール（CloudTrail）で、確認する
- ロール（`INITIAL_USER_ROLE`）の既定は、ユーザー管理の権限を持つ最初のロール。リージョン（`AWS_REGION`）の既定は ap-northeast-1。`.env` は、読み込まない（ローカル開発用の設定が、混ざらないように）
- 使う AWS のプロファイルに必要な権限: Cognito のユーザープールへの `AdminCreateUser`・`AdminSetUserPassword`・`AdminDeleteUser`（途中の失敗の後始末）・`AdminUserGlobalSignOut`、DynamoDB の `Main` テーブルへの読み書き
- **状態: AWS で確認済み**（2026-10-16。最初のユーザーを作成できた。結果は、ADR-0008 の「検証」）。Lambda から Cognito・DynamoDB を使うこと（Issue #75。ADR-0009）も、**AWS で確認済み**（2026-10-20。ログイン・認証つきの呼び出し・画面）
- 本番サイト（Issue #117）の最初のユーザーは、`SfmProductionData` の出力を使う。手順は、operations.md 9.5

### デモデータの投入とリセット（評価環境。Issue #77。ADR-0012）

評価環境（AWS）の画面に、デモの設備・合成データ・評価を用意する（本番の組み立ては、`SEED_MODE`・開発用 API を使えないため、**ユーザーが、AWS のプロファイルを指定して、手元で実行する**。AI エージェントは、実行しない）。**`reset` は、データを消す（元に戻せない）**。

```powershell
# PowerShell の例。値は、スタックの出力（<…> を、置き換える）
$env:AWS_PROFILE = '<プロファイル名>'
$env:PERSISTENCE = 'dynamodb'
$data = aws cloudformation describe-stacks --stack-name SfmData --region ap-northeast-1 --query "Stacks[0].Outputs" | ConvertFrom-Json
$evaluation = aws cloudformation describe-stacks --stack-name SfmEvaluation --region ap-northeast-1 --query "Stacks[0].Outputs" | ConvertFrom-Json
$env:DYNAMODB_OBSERVATIONS_TABLE = ($data | Where-Object { $_.OutputKey -eq 'ObservationsTableName' }).OutputValue
$env:DYNAMODB_MAIN_TABLE = ($data | Where-Object { $_.OutputKey -eq 'MainTableName' }).OutputValue
$env:FILE_SERVER_S3_BUCKET = ($evaluation | Where-Object { $_.OutputKey -eq 'FileServerBucketName' }).OutputValue

pnpm demo-data seed          # 投入する（設備がすでにあれば、何もしない）。合成データは直近 3 日分
pnpm demo-data seed --days 30   # 合成データを 30 日分にする（1 か月分の推移の実測用。1〜31。既定は 3）
pnpm demo-data reset         # 何も消さず、消す対象の件数を示す
pnpm demo-data reset --yes   # 消す（ユーザー・ログイン失敗の記録・ジョブのロックは、残す。S3 のファイルも消す）

# 終わったら、必ず消す（同じターミナルで、手元のバックエンドを起動したとき、AWS に向いてしまうため）
Remove-Item Env:PERSISTENCE, Env:DYNAMODB_OBSERVATIONS_TABLE, Env:DYNAMODB_MAIN_TABLE, Env:FILE_SERVER_S3_BUCKET -ErrorAction SilentlyContinue
```

- 必要な環境変数は、`PERSISTENCE=dynamodb`・`DYNAMODB_OBSERVATIONS_TABLE`・`DYNAMODB_MAIN_TABLE`。`FILE_SERVER_S3_BUCKET` は、`reset` で S3 のファイルも消すときに指定する（指定しなければ、DynamoDB だけ）。Cognito の設定は、要らない。リージョン（`AWS_REGION`）の既定は ap-northeast-1。`.env` は、読み込まない
- `seed` は、設備がすでにあれば、何もしない。投入し直すときは、`reset --yes` のあとに、`seed`
- `seed --days N`（1〜31。既定 3。範囲外・数値でない値は、何も投入せずエラー）は、合成データの日数を指定する（Issue #79）。1 か月分のデータが要る実測（推移の表示。NFR-3.5）のときに使う。30 日分は、観測値で約 3 万件を、DynamoDB に書く。測ったあとは、`reset --yes` → `seed`（既定の 3 日分）で、元に戻せる
- `reset` が消すもの: DynamoDB の観測値のテーブルの全項目と、Main テーブルの、ユーザー（`USER`）・ログイン失敗の記録（`LOGINFAIL`）・ジョブのロック（`JOBLOCK`）以外の全項目、S3 のファイル。テーブルの定義は、変えない。消したあと、ステータスコードの初期データは、入れ直す
- AWS のエラーは、**名前だけ**が出力される（メッセージに、アカウント ID・ARN が含まれることがあり、チャット・Issue・PR に貼らないため）
- 使う AWS のプロファイルに必要な権限: DynamoDB の 2 テーブルの読み書き・Scan・削除、（S3 のファイルも消すとき）バケットの一覧と、オブジェクトの削除
- **状態: 確認済み**（2026-10-20。`seed`・`reset`（`--yes` なし・あり）・ユーザーが残ること・投入し直し。結果は、ADR-0012 の「検証」）。S3 のファイルがある状態での `reset --yes` も、確認済み（生成の Lambda のあと。2026-10-20）。operations.md 7.5
- **開発サイト専用**（Issue #117）。**本番サイトでは、実行できない**（環境変数 `SFM_ENVIRONMENT=production` のとき、`seed`・`reset` とも、何もせずに終了する安全装置。本番サイトは、合成データを入れず、`reset` は、実データを消すため）

### AWS に、手元のバックエンドを向けて確認する（Cognito・DynamoDB。Issue #74）

Lambda を AWS につなぐ前（Issue #75 の前）の確認の方法として、**手元のバックエンドを、実際の Cognito と DynamoDB に向けて起動し、API を直接呼ぶ**ことで、認証とデータの接続を確認できる（2026-10-16 に、この方法で確認した。結果は、ADR-0008 の「検証」）。AWS に接続するため、**ユーザーが実行する**（AI エージェントは、実行しない）。

1. **`SfmData` を適用する**: `pnpm build` のあと、`pnpm --filter @smart-farm/infra exec cdk deploy SfmData --require-approval never`（先に `cdk diff SfmData` で、変更を確認する）。`AWS_PROFILE` を指定する
2. **出力を、環境変数に入れる**（バックエンドを起動するターミナルで）: `aws cloudformation describe-stacks --stack-name SfmData --query "Stacks[0].Outputs"` の `UserPoolId`・`UserPoolClientId`・`ObservationsTableName`・`MainTableName` を、`COGNITO_USER_POOL_ID`・`COGNITO_CLIENT_ID`・`DYNAMODB_OBSERVATIONS_TABLE`・`DYNAMODB_MAIN_TABLE` に。`AWS_REGION=ap-northeast-1`、`AUTH_PROVIDER=cognito`、`PERSISTENCE=dynamodb`
3. **最初のユーザーを作る**（上の「最初のユーザー（Cognito）」）。**終わったら、`INITIAL_USER_*` を、すべて消す**
4. **バックエンドを起動する**: `PORT` を、ほかの開発サーバーと重ならない値（例: 18787）にして、`node --disable-warning=ExperimentalWarning src/backend/runtime/main.ts`。**`pnpm dev:backend` は使わない**（`.env` を読み込み、`INITIAL_USER_*` などが混ざる）。**コードを更新したら、再起動する**（起動済みのプロセスには、反映されない。`Too big: …<=256 characters` のように、修正前のメッセージが出たら、再起動し忘れ）。起動時に、ステータスコードの初期データが、DynamoDB に書き込まれる（想定どおり）
5. **別のターミナルで、API を呼ぶ**。PowerShell の例（`Call` は、エラーを表示せず、文字列を返すだけなので、結果は、変数を表示して見る）:
   ```powershell
   $base = 'http://127.0.0.1:18787/api/v1'
   function Call($method, $path, $body = $null, $token = $null) {
     $p = @{ Method = $method; Uri = "$base$path"; ContentType = 'application/json' }
     if ($token) { $p.Headers = @{ Authorization = "Bearer $token" } }
     if ($null -ne $body) { $p.Body = ($body | ConvertTo-Json) }
     try { Invoke-RestMethod @p } catch { "HTTP $($_.Exception.Response.StatusCode.value__): $($_.ErrorDetails.Message)" }
   }
   ```
   確認する項目: ログイン（`POST /auth/login`）、誤ったパスワード・存在しないユーザー（同じ 401）、`GET /users`、更新（`POST /auth/refresh`）、ユーザーの作成（`POST /users`）、パスワードの再設定（`PUT /users/{id}`。古いトークンが、すぐ 401）、削除（`DELETE /users/{id}`）、ログアウト（`POST /auth/logout`。同じユーザーの別のトークンも 401）、応答時間
6. **接続元の制限（失敗 5 回 → 429）は、最後に確認する**。この制限は、手元のマシン全体にかかり、Cognito 自身のロックも重なるため、**約 15 分は、ログインできなくなる**
7. **後始末**: 確認用のバックエンドを止める（自分で起動したものだけ）。確認用のユーザーは、検証用のパスワードのため、評価に使う前に、削除するか、パスワードを変える。`SfmData` は、削除しない（削除の保護がある）

## 実行結果（2026-10-21。Sprint 2 のサーバーレス化の実装後。`develop` のコミット 21098db）

`develop` の 21098db（Issue #81 のブランチは、ドキュメントのみの差）を、手元（Windows）で実行した値。E2E・負荷テストは、GitHub Actions（`ubuntu-24.04`。PR #124 の `ci:full`）の値（手元では、開発サーバーのポート（5173・8787）と競合するため、実行していない）。

| コマンド | 結果 |
|----------|------|
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm build` | すべて成功（警告なし）。format:check 約 9 秒・lint 約 58 秒・typecheck 約 30 秒・build 約 1 秒 |
| `pnpm test:unit`（単体・結合。IaC のテストを含む。DynamoDB Local が要る） | 85 ファイル・1901 件（成功 1899・スキップ 2。スキップは、Windows では実行しないファイル権限のテスト。CI（Linux）では 2 件も実行され、1901 件すべて成功）。約 123 秒（122.6 秒）。カバレッジ: 行 99.46%・分岐 95.69%・関数 99.83%・文 99.47%（基準は、すべて 95% 以上） |
| `pnpm test:e2e`（E2E） | 764 件（UC-01〜UC-24 の 754 件と、`scenario-*.ts` の 10 件）。CI（`ubuntu-24.04`）で、すべて成功（22.7 分。PR #124）。手元（Windows）では、今回は実行していない（直近の実測は、2026-10-14 の約 44 分で、すべて成功）。スクリーンショットの撮影のたびに、画面の機械検査（はみ出し・重なり・表の列の潰れ・ページ下の余計な空白）を実行 |
| `pnpm test:stress`（負荷テスト） | 4 件（単独利用・同時接続・取り込みの大量実行・モバイル幅の表示）。CI で、すべて成功（1.7 分。PR #124。許容時間を 1.5 倍（`STRESS_LIMIT_FACTOR=1.5`）にして実行）。手元の直近の実測は、2026-10-14 の 443 操作・すべて許容時間内（NG 0）・約 2 分（126 秒）。結果は `test-result/stresstest.result.log` |

`pnpm test`（単体・結合 → E2E の通し）は、今回は実行していない（上は、別々に実行した値）。サーバーレス環境（AWS）の実測（`pnpm test:smoke`）は、上の「サーバーレス環境のスモークテスト・性能の実測」と test.spec.md 13.3。

## ローカルでの動かし方

- `.env.example` を `.env` にコピーして使う（値はダミー。`.env` は Git 管理外）。`SEED_MODE=DEMO` で、デモの設備・合成データ・評価が入る。ログインは、`.env` の `INITIAL_USER_ID`・`INITIAL_USER_PASSWORD`
- バックエンドとフロントエンドを、それぞれ別のターミナルで起動し、`http://127.0.0.1:5173` を開く
- 初期ユーザーでのログイン手順は、次節
- ファイルサーバーのモックに、合成データのファイル（`tests/fixtures/file-server/` を参考）を、`.local-data/file-server/robot/` や `.local-data/file-server/environment-sensor/` に置くと、取り込みの対象になる
- 開発用 API（時計・モックの停止・ジョブの起動・リセット）は、既定で無効。`.env` に `DEV_API_ENABLED=true` を指定したときだけ有効（E2E の設定は、指定済み）。dev_spec.md 3.8

### 初期ユーザーでのログイン手順（ローカル）

1. `.env.example` を `.env` にコピーする（`.env` は Git 管理外。ダミー値のままでも動く）。`.env` に、`INITIAL_USER_ID`・`INITIAL_USER_NAME`・`INITIAL_USER_PASSWORD` の3つがそろっていること（`.env.example` のダミー値は、ユーザーID `local-user`、パスワード `Dummy-Passw0rd-local`）。パスワードは、8文字以上で英大文字・英小文字・数字を含むこと（満たさないと、バックエンドが起動しない）
2. `pnpm dev:backend` と `pnpm dev:frontend` を、別のターミナルで起動する（バックエンドは、起動時に、ユーザーが1人もいなければ、初期ユーザーを作る。ログに「最初のユーザーを作成しました」と出る）
3. ブラウザで `http://127.0.0.1:5173` を開く（未ログインなら、ログイン画面へ移る）。ユーザーIDとパスワードを入力して「ログイン」を押すと、ダッシュボードへ移る。利用を終えたら、ヘッダーの「ログアウト」を押す
4. 失敗が同じ接続元から15分で5回続くと、しばらくログインできない（15分後に解ける。バックエンドを再起動しても解ける。接続元は、`TRUSTED_PROXY_HOPS`（既定 0）に従う。dev_spec.md 4章 No.3・33）

注意:

- 初期ユーザーは、ユーザーが1人もいないときだけ作られる。`PERSISTENCE=file`（`.env.example` の既定）では、`.local-data/store.json` にユーザーが保存されるため、2回目以降の起動で `.env` のユーザーIDやパスワードを変えても、反映されない（変えるときは、ログイン後に、ユーザー管理（SC-14）で、パスワードを再設定する。または、`.local-data/store.json` を削除して、作り直す）
- `INITIAL_USER_*` を指定しないと、ユーザーが作られず、ログインできない
- 初期ユーザーのロールは、既定の1ロール `worker`（全権限）。`ROLE_DEFINITIONS_JSON`・`INITIAL_USER_ROLE` で変えられる（dev_spec.md 3.3）
- パスワードは、ハッシュ化（scrypt）して保存し、ログに出さない（security.md）。実際の運用では、`.env.example` のダミー値を使わず、別の値にする

## テストの出力

| 出力 | 場所 |
|------|------|
| カバレッジ（HTML・lcov・サマリ） | `./test-result/coverage/`（`index.html`） |
| E2E の動画・スクリーンショット・トレース | `./test-result/e2e/` |
| E2E の HTML レポート | `./test-result/playwright-report/` |

`./test-result/` は Git 管理外（負荷テストのログ・レポートと、テスト仕様書 `test.spec.md` を除く）。

## 負荷テスト

```bash
pnpm test:stress     # 大量データの状態で、全ユースケースの操作の応答時間を計測する（単独利用・同時接続・取り込みの大量実行）と、375px・768px 幅の表示の確認。約2分
```

- バックエンド（起動時に、約63万件の観測値などの合成データを投入）と、フロントエンド（本番ビルドを `vite preview` で配信）を起動して実行する。ポートは E2E と同じ（5173・8787）のため、`pnpm test:e2e` と同時に実行しない
- 許容時間は `tests/stress/support/limits.ts`（NFR-3.x）。超えた操作があると、テストは失敗する
- 許容時間の倍率: 環境変数 `STRESS_LIMIT_FACTOR`（1 以上 3 以下。既定 1 = NFR の値のまま。範囲外・数値でない値はエラー）。実行環境の速さが揺れるとき（CI）のために設けた。例: `STRESS_LIMIT_FACTOR=1.5 pnpm test:stress`（操作は 3 秒 → 4.5 秒）。倍率は、結果ログに記録される。**手元の実行・NFR の確認は、既定の 1 で行う**
- 出力: `./test-result/stresstest.result.log`（操作ごとの応答時間・次の操作が可能になるまでの時間・判定、集計。Git 管理）、`./test-result/stress/`（スクリーンショット・HTML レポート。Git 管理外）。報告は `./test-result/stresstest.report.md`
- 構成の詳細は dev_spec.md 6.5

## サーバーレス環境のスモークテスト・性能の実測（評価環境。Issue #79）

評価環境（AWS）に対して、Playwright で、ログイン → ダッシュボード → 手動入力 → 通知 → ログアウトの流れを確かめ（スモークテスト）、主要な操作の時間を、許容時間（NFR。負荷テストと同じ）と比べる。**手動で実行する**（CI には載せない）。環境に、手動入力の保存・削除の書き込みをするため、**ユーザーが実行する**（AI エージェントは、評価環境に対して実行しない。AGENTS.md 12 章）。

```powershell
# PowerShell の例。値は、評価環境の URL（`SfmEvaluation` のスタックの出力 `SiteUrl`）と、評価環境のユーザー（初期ユーザー）
$env:SMOKE_BASE_URL = '<SiteUrl>'
$env:SMOKE_USER_ID = '<ユーザーID>'
$env:SMOKE_PASSWORD = (Read-Host 'パスワード' -MaskInput)   # 履歴に残さない

pnpm test:smoke                 # スモークテスト + 初期表示・推移・自動更新の実測 + 定期の取り込みの実行時間
$env:SMOKE_COLD_START = '1'; pnpm test:smoke smoke-03   # コールドスタートの実測（60 分以上、アクセスがない状態で）

# 終わったら、必ず消す
Remove-Item Env:SMOKE_BASE_URL, Env:SMOKE_USER_ID, Env:SMOKE_PASSWORD, Env:SMOKE_COLD_START -ErrorAction SilentlyContinue
```

- 環境変数: `SMOKE_BASE_URL`（`https://` で始まる URL。パス・末尾のスラッシュは付けない）・`SMOKE_USER_ID`・`SMOKE_PASSWORD`（すべて必須。足りなければ、実行の最初にエラー。エラーに、パスワードは出ない）。値は、コード・ログ・結果に残らない。動画・トレースも取らない（パスワードが残るため）
- テスト（`tests/smoke/`）: `smoke-01-flow.ts`（流れの確認。環境の**センサー（`SENSOR-01`）に、正常の範囲の値（温度 23℃・湿度 60%）の手動入力を 1 件保存し、終わりに削除する**。論理削除で、変更履歴には残る。途中で失敗して残ったときは、入力済みデータで「スモークテスト」を検索して削除する）、`smoke-02-performance.ts`（初期表示 5 回・自動更新 3 回・推移 3 回・取り込みの実行時間）、`smoke-03-cold-start.ts`（`SMOKE_COLD_START=1` のときだけ動く）。デモデータ（`ROBOT-01`・`SENSOR-01`）がある環境が前提
- **推移の実測（NFR-3.5）には、1 か月分のデータが要る**。測る前に、`pnpm demo-data reset --yes` → `pnpm demo-data seed --days 30`（上の「デモデータの投入とリセット」）で、30 日分にする。測ったあとは、`reset --yes` → `seed` で、既定（3 日分）に戻す。評価する人が使っている間は、行わない
- コールドスタートの実測は、API の Lambda が停止した状態が要る。**60 分以上、環境にアクセスしない**状態にしてから、`smoke-03` だけを実行する（ほかのテストを先に実行すると、温まる）。Lambda の停止の時期は、AWS が決めるため、確実ではない。Lambda 側の起動の時間（Init Duration）は、CloudWatch Logs で見る（operations.md 7.7）。**判定は、1 回目（コールドスタート）が 6 秒以内、2 回目（ウォーム）が 3 秒以内**（NFR-3.4。Issue #168）
- 出力: `./test-result/smoketest.result.log`（操作ごとの応答時間・次の操作が可能になるまでの時間・判定、集計、取り込みの実行時間。環境の URL・ユーザーは、載せない）、`./test-result/smoke/`（HTML レポート。Git 管理外）。時間は、**端末のブラウザから見た時間**（端末と環境の間の通信を含む）
- 許容時間は `tests/stress/support/limits.ts`（負荷テストと同じ。NFR-3.x）。超えた操作があると、テストは失敗する。倍率の環境変数 `STRESS_LIMIT_FACTOR` も、同じように使える（NFR の確認は、既定の 1）
- 構成の詳細は dev_spec.md 6.6
- **状態: 実行済み**（2026-10-21。AWS の評価環境。スモークテスト・初期表示・自動更新・推移・取り込みの実行時間。結果は test.spec.md 13.3・`test-result/smoketest.result.log`）。コールドスタート（`smoke-03`）も、実行済み（2026-10-21。コールドは、次の操作可能まで 3.21 秒で、通常の 3 秒を約 0.2 秒超過。コールドスタートの許容（6 秒以内）の範囲内。2026-10-28 に、NFR-3.4 に明記し、対策はしないと決めた。test.spec.md 13.3・Issue #168）

## CI（GitHub Actions）

開発サイト・本番サイトのデプロイは、`.github/workflows/deploy-development.yml`・`deploy-production.yml`（手動実行のみ。OIDC で AWS に入る。本番サイトは、`main` だけ・承認が必要。手順は「評価環境（IaC）」と operations.md 9 章）。以下は、PR の CI（`ci.yml`）。

`.github/workflows/ci.yml`。PR ごとに、次のコマンドを実行する（手元で同じコマンドを実行して、事前に確認できる）。マージ先ごとの必須のチェックは [git-workflow.md](../40_operations/git-workflow.md)「PRの作り方」を参照する。

| ジョブ | 実行するコマンド | 実行する PR |
|--------|------------------|-------------|
| `lint` | `pnpm lint`・`pnpm format:check` | `develop`・`main` 宛て |
| `typecheck` | `pnpm typecheck` | 同上 |
| `unit-test` | `pnpm test:unit` | 同上 |
| `build` | `pnpm build` | 同上 |
| `e2e` | `pnpm test:e2e` | `main` 宛て、またはラベル `ci:full` |
| `stress` | `pnpm test:stress` | 同上 |

- 実行環境は、ubuntu-24.04（GitHub Actions のランナー。`ubuntu-latest` は、Ubuntu 26 へ移行するため、固定している）・Node.js 24・`packageManager` に指定した pnpm。E2E・負荷テストは、Playwright の公式のコンテナ（`mcr.microsoft.com/playwright:v<版>-noble`。ブラウザとシステムのライブラリを含む。ダイジェストで固定）で実行する。Playwright の版（`package.json`・`pnpm-lock.yaml`）を上げるときは、`.github/workflows/ci.yml` のコンテナの版とダイジェストも、合わせて更新する（合っていないと、`e2e-shard` ジョブの「Playwright の版を確かめる」が失敗して知らせる）
- 手元（Windows）では実行しないファイル権限のテスト（2 件）は、CI（Linux）で実行される
- CI の `stress` ジョブは、`STRESS_LIMIT_FACTOR=1.5`（許容時間を 1.5 倍）で実行する。GitHub のランナーは、CPU の速さが実行のたびに違い、同時 10 人の保存（UC-06）が、許容 3 秒付近（約 2〜3.5 秒）で、超えたり超えなかったりしたため（PR #58）。NFR の値そのものは、変えていない
- 画面のレイアウトの検査（E2E・負荷テスト）は、フォントに依存するため、`e2e-shard`・`stress` のジョブで、日本語のフォント（Noto Sans CJK JP の Regular・Bold）を入れる。GitHub 上の公式のファイル（notofonts/noto-cjk のタグ `Sans2.004`）を、ハッシュで検証して取得する（`.github/actions/install-japanese-fonts`。Ubuntu のパッケージ `fonts-noto-cjk` 1:20230817+repack1-3 と、バイト単位で同じ）。`apt` は、Ubuntu のミラーが遅いと、取得だけで 20 分近くかかったため、使わない（Issue #185）
- 失敗したときの E2E のスクリーンショット・トレース・エラーの文脈（シャードごと。`e2e-failure-<番号>`）と、負荷テストの結果ログは、Actions の成果物（Artifacts）から取得できる。CI では、E2E の動画を撮らない（手元は、常に撮る）

## 環境変数

必要な環境変数は、リポジトリ直下の `.env.example` に変数名とダミー値を記載する。実際の値は `.env` に記載し、Git管理には含めない（詳細は [security.md](../20_development/security.md)を参照）。各変数の意味は dev_spec.md 3.3。

## 外部サービス

開発・テストに、外部サービスは不要（ファイルサーバー・農業情報基盤・Web Push は、ローカルのモック。dev_spec.md 3.5）。本番の接続先は未確定（Q-002、Q-005）。
