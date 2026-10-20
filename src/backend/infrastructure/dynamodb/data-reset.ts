/**
 * データのリセット（DynamoDB。Issue #77。ADR-0012）。評価環境のデモデータを、消して、投入し直すための操作。
 * 観測値のテーブルの全項目と、Main テーブルのうち、**残すパーティション以外**の全項目を、消す。
 * 残すもの: ユーザー（`USER`。ユーザーの記録。Cognito のユーザーは、別）・ログインの試行回数の記録（`LOGINFAIL`。
 * リセットで、制限を解かない）・ジョブのロック（`JOBLOCK`。実行中のジョブを、妨げない）。
 * テーブルの定義（キー・インデックス・TTL・バックアップの設定）は、変えない（項目だけを消す）。
 * 手元のコマンド（`pnpm demo-data reset`）からだけ使う。API・Lambda からは、呼べない。
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { batchWriteItems, type Database, type Item } from './operations.ts';

/** リセットで、残すパーティション（Main テーブル）。 */
export const KEPT_PARTITIONS = ['USER', 'LOGINFAIL', 'JOBLOCK'] as const;

export interface ResetResult {
  readonly observations: number;
  readonly main: number;
}

/** テーブルの全項目のキー（pk・sk）を、続きを取りながら、残すもの以外について、消す。消した件数を返す。 */
async function deleteAll(
  db: Database,
  table: string,
  kept: readonly string[],
  onlyCount: boolean,
): Promise<number> {
  let deleted = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await db.client.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: 'pk, sk',
        ConsistentRead: true,
        ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
      }),
    );
    const keys = (page.Items ?? [])
      .filter((item) => !kept.includes(String(item.pk)))
      .map((item): Item => ({ pk: String(item.pk), sk: String(item.sk) }));
    if (!onlyCount) {
      await batchWriteItems(
        db,
        table,
        keys.map((key) => ({ delete: key })),
      );
    }
    deleted += keys.length;
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);
  return deleted;
}

/**
 * デモデータを消す。`dryRun` なら、消さずに、消す対象の件数だけを数える。
 * Scan を使う（全項目を読む）。評価環境の規模（デモデータ）を前提にした、運用者の手元の操作。
 */
export async function resetData(
  db: Database,
  options: { readonly dryRun?: boolean } = {},
): Promise<ResetResult> {
  const dryRun = options.dryRun ?? false;
  return {
    observations: await deleteAll(db, db.tables.observations, [], dryRun),
    main: await deleteAll(db, db.tables.main, KEPT_PARTITIONS, dryRun),
  };
}
