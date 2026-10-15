/**
 * Main テーブル（そのほかの集約。単一テーブル設計）の操作。集約の値は、`data` の属性に、そのまま持つ。
 * 読み込み時に、集約のスキーマで検証する（壊れたデータを内部に渡さない）。
 */

import type { z } from 'zod';
import {
  batchGetItems,
  deleteItem,
  getItem,
  putItem,
  queryAll,
  type Database,
  type Item,
  type TransactItem,
} from './operations.ts';

/** 集約 1 種類の、Main テーブルでの読み書き。pk・sk は、集約ごとに、呼び出し側が決める。 */
export interface MainAggregate<Value> {
  get: (pk: string, sk: string) => Promise<Value | undefined>;
  /** パーティションの全件（ソートキーの昇順）。 */
  list: (pk: string) => Promise<Value[]>;
  put: (pk: string, sk: string, value: Value, extra?: Item) => Promise<void>;
  putOperation: (pk: string, sk: string, value: Value, extra?: Item) => TransactItem;
  remove: (pk: string, sk: string) => Promise<void>;
  /** 読み取ったアイテムの `data` を、検証して返す。 */
  parse: (item: Item) => Value;
}

export function mainAggregate<Value>(db: Database, schema: z.ZodType<Value>): MainAggregate<Value> {
  const table = db.tables.main;
  const parse = (item: Item): Value => schema.parse(item.data);
  const itemOf = (pk: string, sk: string, value: Value, extra: Item = {}): Item => ({
    pk,
    sk,
    ...extra,
    data: value,
  });
  return {
    async get(pk, sk) {
      const item = await getItem(db, table, { pk, sk });
      return item === undefined ? undefined : parse(item);
    },
    async list(pk) {
      return (await queryAll(db, table, pk)).map(parse);
    },
    put: (pk, sk, value, extra) => putItem(db, table, itemOf(pk, sk, value, extra)),
    putOperation: (pk, sk, value, extra) => ({
      Put: { TableName: table, Item: itemOf(pk, sk, value, extra) },
    }),
    remove: (pk, sk) => deleteItem(db, table, { pk, sk }),
    parse,
  };
}

/** カウンター（件数）のアイテムのソートキー。トランザクションの中で、増減する。 */
const COUNTER_PARTITION = 'COUNTER';

/** カウンターを増減する、トランザクションの操作（ない場合は、0 から数える）。 */
export function counterAdd(db: Database, name: string, delta: number): TransactItem {
  return {
    Update: {
      TableName: db.tables.main,
      Key: { pk: COUNTER_PARTITION, sk: name },
      UpdateExpression: 'ADD #n :d',
      ExpressionAttributeNames: { '#n': 'n' },
      ExpressionAttributeValues: { ':d': delta },
    },
  };
}

/** カウンターの値（強い整合。ずれて負になっても、0 として返す）。 */
export async function readCounters(
  db: Database,
  names: readonly string[],
): Promise<Map<string, number>> {
  const items = await batchGetItems(
    db,
    db.tables.main,
    names.map((name) => ({ pk: COUNTER_PARTITION, sk: name })),
  );
  const counts = new Map(names.map((name) => [name, 0]));
  for (const item of items) {
    counts.set(String(item.sk), Math.max(0, Number(item.n ?? 0)));
  }
  return counts;
}
