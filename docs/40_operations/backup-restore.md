# バックアップ・復元の手順

目的: 収集したデータ・評価結果・設定のバックアップと、復元の手順を示す（NFR-4.2・NFR-4.3）。ローカル実行（ファイル永続化）の手順は実装済み。本番（DynamoDB。評価環境）の手順は、下に記載する。

## 対象と方針

| 構成 | 保存先 | バックアップ | 状態 |
|------|--------|--------------|------|
| ローカル実行（`PERSISTENCE=file`） | `DATA_FILE`（既定 `.local-data/store.json`）の JSON ファイル | `pnpm data:backup`（下記） | 実装済み |
| 本番（DynamoDB。ADR-0002） | DynamoDB のテーブル | DynamoDB のバックアップ（ポイントインタイムリカバリ（PITR）・オンデマンド） | 設定は IaC に実装済み。手順は、下の「本番（DynamoDB。評価環境）」（実機の確認は、2026-10-20 に実施。詳細は下） |

- 頻度・保持期間: NFR-4.2 の暫定は「日次」「プロジェクト終了後1年以上の保持」。世代数・保持期間は発注者の確認が必要（TODO: NFR-3.6・NFR-4.2）
- データファイルは、パスワードのハッシュを含む。バックアップも、所有者のみが読み書きできる権限（0600）で作る（Windows では OS の制約で無効）。保管先のディスク・バックアップの暗号化・アクセス制限は、運用で決める（TODO: 運用体制 NFR-6.8）
- メモリのみ（`PERSISTENCE=memory`）の実行は、再起動でデータが消える。実運用には使わない

## ローカル実行のバックアップ

```bash
pnpm data:backup backup              # バックアップを作る（.local-data/backups/store-<日時>.json）
pnpm data:backup backup --keep 7     # 作ったあと、最新の7世代だけを残す（古い世代を削除する）
pnpm data:backup list                # バックアップの一覧（新しい順）
```

- 環境変数 `DATA_FILE`（バックアップ元）・`BACKUP_DIR`（保存先。既定 `.local-data/backups`）で、場所を変えられる
- バックアップの前に、ファイルの内容（JSON として読めること、版がこのアプリより新しくないこと）を確認する。壊れたファイルは、バックアップしない
- `--keep` を指定しない限り、古い世代は削除しない
- 定期実行（日次）は、OS のスケジューラ（cron・タスクスケジューラ）で、`pnpm data:backup backup --keep N` を実行する

## ローカル実行の復元

1. サーバー（`pnpm dev:backend` など）を **止める**（動作中のサーバーは、メモリ上のデータを、あとから書き戻すため）
2. `pnpm data:backup list` で、復元するバックアップを選ぶ
3. `pnpm data:backup restore store-<日時>.json` を実行する。現在のファイルは、`<DATA_FILE>.before-restore-<日時>` として退避され、バックアップの内容に置き換わる
4. サーバーを起動し、画面（ダッシュボード・取り込み設定・ユーザー管理）で、期待どおりのデータであることを確認する
5. 復元の結果が誤りだった場合は、退避したファイルを、`DATA_FILE` へ戻す（サーバーを止めてから）

## データファイルが読み込めないとき（起動の失敗）

アプリの更新（保存形式の変更）・ファイルの破損で、起動時に「データファイルを読み込めません」と表示される場合:

- 元のファイルは、自動では、消さず・置き換えない。調査のため、同じ場所に控え（`<DATA_FILE>.corrupt-<日時>`）が作られる
- 直前のバックアップ（上記）から復元する。バックアップがない場合は、控えの内容を確認する（JSON として読める部分の手動の修復は、保存形式（`src/backend/infrastructure/local/local-store.ts`）に従う）
- 版が新しい（「このアプリが扱える版より新しい」）場合は、アプリの版が古い。新しいアプリで起動する

## 復元の試験

バックアップは、復元できて初めて、有効になる。次を定期的に（例: 月1回）確認する（TODO: 実施の担当・記録の方法を、運用体制の確定後に定める）。

- 別の場所（別の `DATA_FILE`）へ復元し、アプリが起動して、期待する件数・設定が読めること

## 本番（DynamoDB。評価環境）のバックアップ・復元

Issue #80。**手順は、コードと AWS の公式ドキュメントから書いた。実機（AWS）での確認（2026-10-20。ユーザーが実行）: 設定値（PITR 35 日・ログ 30 日）、オンデマンドバックアップ、削除したテーブルのシステムバックアップ、復元 A、復元 B の機構（一時テーブルでの、バックアップ経由の同名の復元と、設定の付け直し）は、確認済み。本番のテーブルを置き換える操作（復元 B の本番での実行）は、未実施**。AWS に接続する操作は、ユーザーが実行する（AGENTS.md 12 章）。テーブル名は、`SfmData` の出力（`ObservationsTableName`・`MainTableName`）。ロールバック・初期化は [operations.md](./operations.md) 7 章。

### 設定（IaC。`infra/lib/data-stack.ts`）

| 項目 | 内容 |
|------|------|
| ポイントインタイムリカバリ（PITR） | 2 つのテーブルとも有効。**直近 35 日**の、任意の時点に戻せる（連続バックアップ。日次の要件 NFR-4.2 を満たす）。35 日より古い分は、自動で失効する（追加の削除作業は、不要）。IaC が、期間（35 日）を明示する。実機では、`describe-continuous-backups` の `RecoveryPeriodInDays` で確認する |
| オンデマンドバックアップ | 自動では取らない。**期限を設定できず、自動では削除されない**（保持している間、保存の費用がかかる）。**デプロイ前・大きな変更の前に取り、不要になったら、手動で削除する**。AWS Backup（期限・世代の自動管理）は、追加のサービスになるため、使わない |
| 削除したテーブル | PITR が有効なテーブルを削除すると、削除の直前の状態の「システムバックアップ」（`<テーブル名>$DeletedTableBackup`）が、自動で作られ、35 日、残る（**確認済み**。2026-10-20。空のテーブルで、PITR を有効にして削除すると、`BackupType` が `SYSTEM` のバックアップが作られた。**PITR が無効のテーブルの削除では、作られない**。復元 B の一時テーブルは、PITR が引き継がれないため、設定し直す前に削除すると、作られない）。**一覧には、`--backup-type ALL`（または `SYSTEM`）が要る**（`list-backups` の既定は、自分で取った分だけ）: `aws dynamodb list-backups --table-name <テーブル名> --backup-type ALL` |
| ログ | API のログは、30 日で自動削除（`infra/lib/evaluation-stack.ts`。operations.md 7.6）。画面の配置（`BucketDeployment`）の補助の Lambda のログも、30 日で自動削除（Issue #80 で、CDK の既定の 731 日から、絞った）。**この変更より前のデプロイで作られた旧いロググループ**（名前は `/aws/lambda/` で始まり、`CustomCDKBucketDeployment` を含む。保持 731 日・スタックを消しても残る）は、**残る**。デプロイのときにしか書かれず、少量のため、放置してよいが、気になる場合は、保持期間を絞るか、削除する |

- **Cognito のユーザー（パスワード）は、DynamoDB のバックアップに含まれない**。DynamoDB には、ユーザーの名前・ロールの記録だけがある。データを前の時点に戻すと、そのあとに作成・削除したユーザーは、Cognito と DynamoDB で食い違う（画面のユーザー管理で、合わせる）
- 保持期間の 35 日は、「プロジェクト終了後 1 年以上」（NFR-4.2。暫定）より短い。長期の保持が必要な場合は、オンデマンドバックアップを、手動で残すか、保持の方法を決める（TODO: 発注者との合意。NFR-4.2）

### オンデマンドバックアップ

```bash
aws dynamodb create-backup --table-name <テーブル名> --backup-name <テーブル名>-<日付>   # 取得（2 つのテーブルとも）
aws dynamodb list-backups --table-name <テーブル名>                                       # 一覧（BackupStatus が AVAILABLE になれば完了）。自分で取った分だけが出る
aws dynamodb delete-backup --backup-arn <ARN>                                            # 不要になったら削除
```

### 復元 A: 内容の確認・一部のデータの取り出し（本番は、そのまま）

PITR の復元は、**必ず、新しいテーブルを作る**（元のテーブルは、そのまま使える）。API は、新しいテーブルを使わないため、影響しない。

1. 戻せる範囲を確認する: `aws dynamodb describe-continuous-backups --table-name <テーブル名>`（`EarliestRestorableDateTime`〜`LatestRestorableDateTime`）
2. 復元する: `aws dynamodb restore-table-to-point-in-time --source-table-name <テーブル名> --target-table-name <テーブル名>-restore --use-latest-restorable-time`（時点を指定するときは、`--no-use-latest-restorable-time --restore-date-time <時刻>`）
3. `aws dynamodb describe-table --table-name <テーブル名>-restore` で、`TableStatus` が `ACTIVE` になるまで待つ（所要時間は、データの量・インデックスの数による。保証はない）。評価環境の規模での所要時間は、**未測定**（2026-10-20 の確認では、計測していない）
4. 内容を確認する（AWS のコンソールの「項目の探索」など）。必要なデータは、ここから取り出す
5. 確認が済んだら、復元したテーブルを削除する: `aws dynamodb delete-table --table-name <テーブル名>-restore`

### 復元 B: 本番のテーブルを、前の時点の内容に置き換える（API が、一時的に止まる）

API の Lambda は、`SfmData` の出力のテーブル名（ARN）を使う。**同じ名前のテーブルを作り直す**ことで、Lambda・IaC を変えずに、置き換える。評価環境の事故のときだけ行う。

1. 利用者に、停止を知らせる（API が、手順 4〜6 の間、エラーになる）
2. 復元 A の手順 1〜3 で、一時のテーブル（`<テーブル名>-restore`）に、戻したい時点を復元し、内容を確認する
3. 一時のテーブルのオンデマンドバックアップを取る（`create-backup --table-name <テーブル名>-restore`）。`AVAILABLE` まで待つ（PITR の復元は、元の名前を使えないため、バックアップを経由する）
4. 本番のテーブルを、削除する: `aws dynamodb update-table --table-name <テーブル名> --no-deletion-protection-enabled` のあと、`aws dynamodb delete-table --table-name <テーブル名>`（削除の保護と、システムバックアップは、上の設定の表）
5. 同じ名前で、バックアップから復元する: `aws dynamodb restore-table-from-backup --target-table-name <テーブル名> --backup-arn <手順 3 のバックアップの ARN>`。`ACTIVE` まで待つ
6. **復元では引き継がれない設定を、設定し直す**（AWS のドキュメントによる）:
   - PITR: `aws dynamodb update-continuous-backups --table-name <テーブル名> --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true,RecoveryPeriodInDays=35`
   - TTL（`Main` テーブルだけ）: `aws dynamodb update-time-to-live --table-name <テーブル名> --time-to-live-specification Enabled=true,AttributeName=ttl`
   - 削除の保護: `aws dynamodb update-table --table-name <テーブル名> --deletion-protection-enabled`
   - タグ: `Project`・`Environment`・`ManagedBy`（`infra/lib/apps.ts`）を、`aws dynamodb tag-resource` で付ける
7. 確認する: `<SiteUrl>/health`、ログイン、ダッシュボードの表示。`cdk diff SfmData`（`pnpm --filter @smart-farm/infra run diff`）で、IaC との差が、想定外に出ていないこと
8. 一時のテーブル・一時のバックアップを削除する（`delete-table`・`delete-backup`）

- 2 つのテーブル（`Observations`・`Main`）は、**同じ時点**に戻す（観測値と、設定・評価・通知の整合のため）
- **Cognito のユーザーは、戻らない**（上の注意）
