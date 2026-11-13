# 農業情報基盤との連携の準備・確認の手順（Issue #177。ADR-0024）

農業情報基盤（FIWARE。NGSI-LD の Orion-LD と QuantumLeap）へ、本システムの連携を始めるための、基盤側の準備と、確認の手順。**実行は、ユーザー**（基盤の管理者）が行う。AI エージェントは、実際の農業情報基盤に接続しない。

- 接続先のホスト名・認証情報を、リポジトリ・Issue・PR に書かない（リポジトリは公開）。以下の `<接続先>` は、基盤の NGSI-LD のエンドポイント（例: `https://<ホスト>/api/orion/ngsi-ld/v1`）に置き換える。
- 基盤は、ふだん停止している。**EC2 を起動してから**行う。
- 確認の結果によって、データモデル（時刻の属性など）を見直す。見直しが要る場合は、Issue #177 に記録する。

## 1. 本システムの設定（画面）

1. AWS の評価環境にデプロイする（`FEDERATION_MODE=ngsi-ld`。IaC の変更。デプロイは、ユーザーが実行する）。
2. 本システムにログインし、メニュー「取り込み」（SC-11）の「連携先の設定」で、次を設定する。
   - 接続先の URL: `<接続先>`（書き込み専用。保存後は、画面に表示しない）
   - テナント名: 既定 `smart_farm_monitoring`
   - context の URL: 既定は、`develop` の raw の URL（リリース〔v0.5.0。#343〕のあとに、タグの URL に切り替える）。基盤（Orion-LD）から、インターネット経由で取得できる URL にする
3. 「接続を確認」を押す。成功すれば、基盤に接続でき、読み取りの要求が通っている（書き込みは、していない）。
4. 「連携を有効にする」にして保存する。**既存の設備の名前・ID が、連携キューに積まれ**、連携ジョブ（5 分ごと）が基盤へ送る。

接続先が未設定のあいだ、連携は「保留」のまま溜まる（破棄の期限は、既定 30 日）。

## 2. 基盤側の確認（4 点）

テナント名は、画面の設定と同じにする。`Link` ヘッダーの context は、画面の context URL と同じにする。

### 2.1 `entityOperations/upsert?options=update` が使えること

```bash
curl -i -X POST '<接続先>/entityOperations/upsert?options=update' \
  -H 'Content-Type: application/json' \
  -H 'NGSILD-Tenant: smart_farm_monitoring' \
  -H 'Link: <<context の URL>>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"' \
  --data-raw '[{"id":"urn:ngsi-ld:Greenhouse:CHECK-01","type":"Greenhouse","name":{"type":"Property","value":"確認用"}}]'
```

- 期待: `201` または `204`。
- 同じエンティティに、別の属性だけを送り（`options=update`）、最初の属性が残ることを、`GET <接続先>/entities/urn:ngsi-ld:Greenhouse:CHECK-01`（同じヘッダー）で確かめる。

### 2.2 QuantumLeap が、`observedAt` を時刻にすること

1. Orion-LD から QuantumLeap への購読を、型ごと（`IndoorEnvironmentObserved`・`EquipmentObserved`・`ViewpointEvaluation`）に、テナントを指定して作る（購読の作り方は、基盤の運用の手順に従う）。
2. 次のように、`observedAt` の違う値を、2 回送る。

```bash
curl -i -X POST '<接続先>/entityOperations/upsert?options=update' \
  -H 'Content-Type: application/json' -H 'NGSILD-Tenant: smart_farm_monitoring' \
  -H 'Link: <<context の URL>>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"' \
  --data-raw '[{"id":"urn:ngsi-ld:EquipmentObserved:CHECK-01","type":"EquipmentObserved","harvestCount":{"type":"Property","value":1,"observedAt":"2026-11-13T00:00:00Z"}}]'
```

2 回目は、`value` を 2、`observedAt` を `2026-11-13T00:05:00Z` にする。

- 期待: QuantumLeap に、2 行（時刻が `00:00` と `00:05`）が入る。時刻が、送った時刻ではなく、`observedAt` であること。

### 2.3 再送で、時系列に重複が残らないこと

2.2 の 2 回目と**同じ内容**（同じエンティティ・属性・`observedAt`）を、もう一度送る。

- 期待: QuantumLeap の行が、増えない（同じ時刻の行が 1 行のまま）。

### 2.4 テナントが、初回の書き込みで作られること

まだ使っていないテナント名（例: `check_tenant_01`）で、2.1 の要求を送る。

- 期待: 事前にテナントを作らなくても、`201` または `204` になる。

## 3. 結果の記録

- 4 点の結果（成功・失敗）と、基盤の版（Orion-LD・QuantumLeap）を、Issue #177 に記録する（ホスト名・認証情報は書かない）。
- 失敗した点は、データモデル・要求の形の見直しにつなげる（ADR-0024）。
- 確認用のエンティティ（`CHECK-01` など）は、基盤の運用の手順で、削除する。

## 4. 長い停止のあとの、送信の時間

基盤を長く停止したあと（30 日分など）に起動すると、溜まった項目を、5 分ごとに最大 100 項目ずつ送る。**1 回の送信（30 秒の上限）の時間**を確かめる: 基盤の応答が遅いと（1 回 0.4 秒以上など）、1 回の送信に要求が数十回かかり、30 秒を超えて「保留」のままになりうる。連携の結果（SC-11）で、「保留」が続くときは、Issue #177 に記録する（バッチの件数・時間の上限の見直し）。
