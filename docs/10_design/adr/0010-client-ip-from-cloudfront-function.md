# ADR-0010 利用者の IP は、CloudFront の Function でヘッダーに入れて、Lambda が読む

- ステータス: 承認（2026-10-20。ユーザーの判断。Issue #100）。[ADR-0009](./0009-lambda-production-assembly.md) の「6. 利用者の接続元の識別」を置換する
- 日付: 2026-10-20
- 関連: [ADR-0006](./0006-iac-cdk-and-same-origin-delivery.md)、[ADR-0008](./0008-cognito-authentication.md)、[ADR-0009](./0009-lambda-production-assembly.md)、[security.md](../../20_development/security.md)

目的: 評価環境（CloudFront → 関数の URL → Lambda）で、ログインの試行回数の制限（接続元ごと。FR-9.2）の「接続元」を、利用者の IP にするための決定を残す。

## 背景

- ADR-0009 は、`X-Forwarded-For` の末尾から 2 番目（`TRUSTED_PROXY_HOPS=2`）を、利用者の IP と想定した（CloudFront が利用者の IP を付け、関数の URL が CloudFront の IP を付ける、という想定）。仮の値で、AWS での確認が必要と明記していた。
- **AWS での確認（2026-10-20）で、想定が誤っていた**: ログインの成功ログの `clientKey` が、利用者の IP と一致せず、2 回のログインで、先頭 3 区画が同じで末尾だけが違う IP（CloudFront のエッジの IP と推定）だった。
- 原因（推定）: 関数の URL は、`X-Forwarded-For` を、**最初の 1 つ（クライアントが付けられる値）に切り詰める**。第三者の報告（[Obtaining caller ip address with Lambda FURLs](https://speedrun.nobackspacecrew.com/blog/2026/03/06/obtaining-caller-ip-address-with-lambda-furls.html)）があり、AWS の公式文書では確認できていない。項目が 2 つ未満になり、段数による識別が使えず、接続元（`sourceIp`。エッジの IP）に切り替わっていた。
- 影響: 偽装された値は使われていない（回避の脆弱性ではない）が、制限が「利用者ごと」にならない（リクエストが別のエッジに分散すると、失敗の回数も、分散して数えられる）。

## 決定

- **API への CloudFront の振る舞い（`/api/*`・`/health`）に、viewer-request の CloudFront Function を付け、`event.viewer.ip` を、ヘッダー `x-sfm-viewer-ip` に上書きで入れる**。利用者が同名のヘッダーを付けても、CloudFront の Function が上書きする（CloudFront は、ヘッダー名を小文字にして渡す）。IPv4・IPv6 とも、IP だけの値が入る。オリジンへの転送は、既存の `AllViewerExceptHostHeader` の設定で、Function が入れたヘッダーも渡る想定（AWS での確認の対象）。
- **Lambda に、設定 `CLIENT_IP_HEADER`（ヘッダー名。小文字）を追加する**。指定したヘッダーの値を、`net.isIP` で IP として検証し、正しいときだけ、接続元に使う。IP でない値は、使わず、従来の識別（`TRUSTED_PROXY_HOPS` → 接続情報 → イベントの `sourceIp` → ユーザー ID 単位）に切り替える。優先順位は、ヘッダー → 段数 → 接続情報 → `sourceIp`。
- **評価環境の `TRUSTED_PROXY_HOPS` は、設定しない（0）**。`1` 以上にしてはならない（関数の URL を通ったあとの `X-Forwarded-For` は、最初の 1 つ＝利用者が付けられる値になり、偽装できる）。
- IaC は、`CLIENT_IP_HEADER` を、Function のヘッダー名と同じ定数から作り、テストで、両者が一致することを確認する。

## 検討した代替案

| 案 | 採らなかった理由 |
|----|------------------|
| `TRUSTED_PROXY_HOPS` の値を 1 に変える | 切り詰められた最初の 1 つ（利用者が付けられる値）を信用することになり、偽装で、制限を回避できる |
| 何も変えず、接続元をエッジの IP のままにする | 制限が、利用者ごとにならない。同じエッジの利用者が、制限を共有する |
| `CloudFront-Viewer-Address` を、オリジンのリクエストポリシーで転送する | 値は、`IP:ポート` で、IPv6 の表記が、公式文書に書かれていない（解析が曖昧）。ポリシーを、`AllViewerAndCloudFrontHeaders` などに替える必要がある |
| 関数の URL の認証を `AWS_IAM` にして、OAC で署名する | 直接の呼び出しを防げるが、POST の本文のハッシュを、クライアントが付ける必要があり、評価環境の構成が複雑になる（ADR-0009 でも見送り） |
| CloudFront がオリジンに秘密のヘッダーを付け、Lambda が検証して、直接の呼び出しを拒否する | 秘密の値を、Lambda が持つ必要があり、SecretPort（パラメータストア）が先に必要になる。別の Issue で検討する |

## 結果・トレードオフ

- **関数の URL を直接呼ぶ攻撃者は、`x-sfm-viewer-ip` に、任意の IP を付けられ、接続元ごとの制限を回避できる**（これまでの、接続元が実際の IP になる状態より、回避が容易になる）。完全に防ぐには、CloudFront と Lambda のあいだの秘密の値（上の最後の案）が必要。ログインの総当たりへの防御は、Cognito のユーザーごとのロックにも依る（ADR-0008）。評価環境の範囲では、許容する。
- **AWS での確認が必要**（Issue #100）: 修正のデプロイ後、ログインの成功ログの `clientKey` が、利用者の IP になること、別のネットワークからのログインが、制限の影響を受けないことを確認する。
- 認証のログには、利用者の IP が出る（[security.md](../../20_development/security.md)）。
