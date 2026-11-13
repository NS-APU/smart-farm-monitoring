# ADR-0006 IaC に AWS CDK を使い、画面と API を CloudFront の同じオリジンで配信する

- ステータス: 承認（2026-10-15。ユーザーの判断。Issue #71）
- 日付: 2026-10-15
- 関連: [ADR-0002](./0002-deployment-serverless.md)、[architecture.md](../architecture/architecture.md) 11章・13章、[security.md](../../20_development/security.md)、Issue #70・#71・#75・#78

## 背景

- ADR-0002 は、サーバーレス構成を基本とし、IaC・CI/CD は「Amplify Gen 2（または CDK）」、画面のホスティングは「Amplify Hosting（または S3 + CloudFront）」と決めた
- Issue #70 で、IAM ユーザーの権限で、案1（サーバーレス）に必要な操作が利用できることを確認した（architecture.md 11.4）。Issue #71 で、最初の IaC のコードを書くため、ツールと構成を決める
- 顧客に評価いただく環境は、いつでも、コードから、再作成できること（インフラ構築の自動化。Sprint 1 のレトロスペクティブの課題）。独自のサブドメイン（Route 53 のドメインを保有）で運用したい

## 決定

**IaC は AWS CDK（TypeScript）とする。画面（S3）と API（Lambda の関数の URL）を、CloudFront の同じオリジンで配信する。**

1. **IaC は、`infra/`（pnpm のワークスペースのパッケージ `@smart-farm/infra`）に、CDK（TypeScript）で書く**。lint・型検査・単体テスト（CDK の assertions）を、既存と同じ規約で行う
2. **画面は、S3（非公開。CloudFront の OAC からだけ読める）+ CloudFront** で配信する。**API は、Lambda の関数の URL** とし、CloudFront の `/api/*` と `/health` を、API へ向ける。画面と API が同じオリジンになるため、CORS が不要で、画面の `/api/v1` の相対パスのまま動く
3. **関数の URL は、認証なし（NONE）にする**。API の認証は、アプリ側（Issue #74 の Cognito）で行う。CloudFront の OAC で関数の URL を保護すると、POST・PUT の本文のハッシュ計算（`x-amz-content-sha256`）が必要になり、画面からの POST と合わない
4. **SPA の深いパス（`/viewpoints/xxx` など）は、CloudFront Function（viewer-request）で `index.html` に書き換える**。CloudFront のエラー応答（403・404 → index.html）は使わない。API の 403・404 まで書き換え、API のエラー形式が壊れるため
5. **デプロイは、GitHub Actions から、OIDC の一時的な認証**で行う（長期のアクセスキーを使わない）。ロールは、CDK のデプロイ用ロール（`cdk bootstrap` が作る `cdk-<識別子>-*`）を引き受けることだけができ、引き受けられるのは、GitHub の Environment `evaluation` のジョブだけ。信頼条件の `sub` は、GitHub の不変の ID の形式（組織・リポジトリの ID を含む。Issue #87 で、旧形式から修正）。最初は、手動実行（workflow_dispatch）のみで、自動のトリガは、Issue #78 の方針が決まった後に追加する
6. **AWS 側の初回の設定は、ユーザーが手元から 1 回行う**（`cdk bootstrap`、OIDC のプロバイダーとロールのスタック）。以降は、GitHub Actions から、評価環境のスタックを更新する
7. **独自のサブドメインは、環境変数（`SFM_DOMAIN_NAME`・`SFM_HOSTED_ZONE_NAME`）で指定する**。指定しなければ、cloudfront.net の URL を使う。ドメイン名・アカウント ID は、リポジトリに書かない。CloudFront 用の証明書（ACM）は、us-east-1 に別のスタックで作り、DNS 検証は、Route 53 に自動でレコードを作る
8. **Lambda のコードは、esbuild の JS API で、1 ファイルにまとめる**（`infra/lib/bundle-lambda.ts`）。CDK の `NodejsFunction` は、pnpm のプロジェクトで `pnpm exec esbuild` をシェル経由で呼び、Windows で失敗するため
9. リージョンは、東京（ap-northeast-1）に固定する（証明書のみ us-east-1）。全リソースに、コスト配分用のタグ（`Project`・`Environment`・`ManagedBy`）を付ける

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|--------|------|------|
| **CDK（採用）** | 全体を 1 つの TypeScript のコードで定義できる。`cdk synth` と assertions で、AWS に接続せずに検証できる。デプロイは、既存の CI（GitHub Actions）の仕組みに乗る。独自ドメイン・ACM・Route 53 も、コードで書ける。Amplify の GitHub 連携（手作業・組織の承認）が不要 | `cdk bootstrap`（アカウントへの共通リソース）が要る。画面の配信（S3 + CloudFront）を、自分で組む必要がある |
| Amplify Gen 2 | ADR-0002 の第一候補。Amplify Hosting の GitHub 連携で、ビルド・デプロイまでを任せられる | GitHub 連携の設定が手作業（組織の承認が要る）。デプロイが Amplify 側のパイプラインで、CI の結果と切り離される。pnpm のモノレポ・Hono の Lambda の組み込みに、調整が要る見込み。ローカルでの検証が難しい |
| Terraform・CloudFormation を直接 | 広く使われている | 新しい言語（HCL）・YAML を増やす。TypeScript の型・テストの仕組みを使えない |

## 結果・トレードオフ

- **`cdk bootstrap` が必要**（アカウントに、`CDKToolkit` のスタック・ロール・S3 バケットなどを作る）。既定の実行ポリシーは `AdministratorAccess` で、IAM ユーザーの権限によっては、権限を絞った実行ポリシーが必要になる（手順は commands.md）。実行ポリシーの絞り込みは、運用の整備（Issue #80）で検討する
- **関数の URL は、CloudFront を経由せず、直接も呼べる**。認証はアプリ側で行い、公開するのは、認証なしでも安全な範囲に限る。レート制限・WAF は、現時点では置かない（費用。NFR-1.6）。必要になれば、別に検討する
- cloudfront.net の既定の証明書は、最低の TLS のバージョンが AWS の既定（TLS 1.0）で固定される。**独自のサブドメイン（独自の証明書）にすると、TLS 1.2 以上にできる**。顧客の評価は、独自のサブドメインで行うことを想定する
- Amplify の自動ブランチデプロイ・プレビュー環境は、使わない。評価環境は、1 つの環境（`evaluation`）で、GitHub Actions から更新する
- 評価環境は、いつでも、削除・再作成できる（バケット・ログは、削除時に、中身ごと削除する）。データを持つ DynamoDB（Issue #73）を追加するときに、削除時の扱い（保持・バックアップ）を、改めて決める
- DynamoDB・Cognito・EventBridge は、このスタックに、Issue #73・#74・#76 で追加する。API の Lambda は、Issue #75 で、バックエンド本体のハンドラに置き換えた（[ADR-0009](./0009-lambda-production-assembly.md)）

## 追記（2026-10-21。Issue #81。決定は、変えない）

- **Issue #117（2026-10-22）**: GitHub の Environment は、`evaluation` から、`development`（開発サイト）・`production`（本番サイト）になった。OIDC のロールは、環境ごとに別（ADR-0013）。この ADR の「Environment `evaluation`」は、開発サイトの Environment（現在は `development`）と読み替える
- 独自のサブドメインを使う想定は、変わらない（ユーザーの判断）。開発サイト・本番サイト（ADR-0013）で使う。実際の証明書の発行・レコードの作成・TLS 1.2 以上の確認は、**開発サイトは、Issue #128 で、実施・確認済み**（下の「追記: 独自のサブドメインでの配信」）。**本番サイトも、Issue #341 で、実施・確認済み**（2026-11-13）。画面の応答のヘッダー（Cache-Control は Issue #323、CSP・`frame-ancestors`・`X-Frame-Options: DENY` は Issue #127）は、実装済み（CloudFront の独自の応答ヘッダーポリシー。API の動作は、マネージドポリシーのまま。operations.md 6 章）

## 追記: 独自のサブドメインでの配信（Issue #128。2026-11-10。ユーザーが承認）

上の「独自のサブドメインを使う想定」の、実施の方法を決めた。

### 決定

- **ホストゾーンは、デプロイ先のアカウントに、サブドメイン用のゾーンを 1 つ作り、親のドメインのホストゾーン（別のアカウントにある）から、NS レコードで委任する**。開発サイト・本番サイトは、**同じゾーンを共有**し、サイトの名前（`dev.<ゾーン>`・`www.<ゾーン>`）だけが違う。ゾーンは、スタックの外に、手動で 1 回作る（スタックを作り直しても、委任の NS レコードが変わらないようにする）
- IaC は、変えない（環境変数 `SFM_DOMAIN_NAME`・`SFM_HOSTED_ZONE_NAME` で、ゾーンを検索し、証明書〔us-east-1。DNS 検証〕・CloudFront の別名・最低の TLS `TLSv1.2_2021`・A と AAAA のレコードを作る。IaC のテストがある）
- ドメイン名・ホストゾーン名・ゾーンの ID・ネームサーバーの名前は、リポジトリ・Issue・PR に書かない（GitHub の Environment の変数にだけ設定する）。手順は、[operations.md](../../40_operations/operations.md) 8.9

### 検討した代替案

| 案 | 採らなかった理由 |
|----|------------------|
| 親のホストゾーンを、別のアカウントに残し、検証用の CNAME・サイトの CNAME を、手で作る | 費用は 0 円だが、IaC を変更する（ゾーンなしで、証明書と別名だけを作れるようにする）必要があり、DNS が IaC の外になる。証明書の更新・サイトの追加のたびに、手作業が残る |
| 親のホストゾーンを、デプロイ先のアカウントに移す | 親のドメインを使う、ほかのシステムに影響する（ユーザーが管理）。移行の作業と、リスクが大きい |

### 結果・トレードオフ

- 費用（概算。実測は未確認）: ホストゾーン 1 つで、月 US$0.50（1 ドル 150 円の仮定で、約 75 円）。ACM の公開証明書・CloudFront の別名・alias のレコードは、無料
- **cloudfront.net の URL は、CloudFront の仕様で止められず、最低の TLS も旧のまま**（TLS 1.0 が固定される）。利用者には、新しい URL を案内する
- サイトの URL が変わるため、**Web Push の購読は、新しい URL でやり直す**（購読は、オリジンごと）。連絡先（`SFM_WEB_PUSH_SUBJECT`）も、新しい URL にする
- 委任が効く前に、デプロイすると、証明書の DNS 検証が、待ち続けて止まる（手順で、委任の確認を、デプロイの前に置いた）
- AWS での確認は、下の「検証（#128）」

### 検証（#128。AWS。ユーザーが実行）

**開発サイトは、確認済み**（2026-11-10。ユーザーが、手順 [operations.md](../../40_operations/operations.md) 8.9 を実行）。**本番サイトも、確認済み**（2026-11-13。Issue #341。同じ手順〔手順 J〕。下の表の下）。

| 項目 | 結果（開発サイト） |
|------|--------------------|
| (1) 委任（NS） | **効いていた**。ただし、手順 C の `nslookup`（NS の問い合わせ）では、委任を確認できなかった（10 分待っても、手順 A の 4 つの名前が出なかった）。そのままデプロイして、証明書の DNS 検証が通り、サイトも動いた（`nslookup` の結果だけで、委任の有無を判断しない。operations.md 8.9 に注記） |
| (2) 証明書の発行・独自のサブドメインの HTTPS | **動いた**（ユーザーが確認。ブラウザで、鍵のマークが出て、ログイン・ダッシュボード・手動入力・通知が動く。`/health` が 200） |
| (3) 最低の TLS | **1.2 以上**（`aws cloudfront get-distribution-config` の `MinimumProtocolVersion` が `TLSv1.2_2021`、`SSLSupportMethod` が `sni-only`） |
| (4) Web Push | 新しい URL で、購読し直せた（ユーザーが確認） |
| `pnpm test:smoke` | 実行していない（任意） |

- **本番サイト**（2026-11-13。Issue #341。ユーザーが実行）: 差分の確認のうえ、デプロイが成功した。(1) 名前解決・`/health`（200）・HTTP から HTTPS へのリダイレクトが OK。(2) 証明書が有効で、ログイン・主な画面が動き、コンソールに CSP の違反が出ない。(3) 最低の TLS は **`TLSv1.2_2021`・`sni-only`**。(4) Web Push は、本番用の鍵で設定し、新しい URL で、通知の設定を有効にできた（受信の確認は、設備の登録の後）。`pnpm test:smoke smoke-04` は、応答ヘッダー・Cache-Control の 2 件が成功し、ログイン → ダッシュボードの 1 件は、設備が未登録の本番では、失敗する（想定どおり。operations.md 8.9）。本番では、`smoke-01`・`smoke-02`（デモデータへの書き込み）は、実行しない
- 途中で、親のドメインの SOA に、`ns1.…` という、Route 53 のものに見えない名前が出たため、「親のドメインの権威 DNS は、Route 53 ではない」と誤って判断した（実際は、委任が効いていた。原因は、確認していない。Route 53 は、ゾーンに、独自名のネームサーバーを設定できるため、その可能性がある）。SOA の名前から、DNS の提供元を、断定しない
