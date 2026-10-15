/**
 * DynamoDB の操作の共通部分（取得・書き込み・Query・まとめての取得／書き込み・トランザクション）。
 * アダプタの各 Repository は、SDK のコマンドを直接作らず、ここの関数を使う。
 */

import { setTimeout as sleep } from 'node:timers/promises';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { AppError } from '@smart-farm/shared/errors';
import type { TableNames } from './table-schema.ts';

/** DynamoDB のアイテム（属性の名前 → 値）。 */
export type Item = Record<string, unknown>;

/** アダプタが使う、DynamoDB のクライアントとテーブル名。 */
export interface Database {
  readonly client: DynamoDBDocumentClient;
  readonly tables: TableNames;
}

export type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** 1 回の BatchWriteItem の件数の上限。 */
const BATCH_WRITE_LIMIT = 25;
/** 1 回の BatchGetItem のキーの数の上限。 */
const BATCH_GET_LIMIT = 100;
/** 処理されなかった分を、再び送る回数の上限（待ち時間は、回ごとに倍にする）。 */
const MAX_UNPROCESSED_ATTEMPTS = 8;
const UNPROCESSED_BASE_DELAY_MS = 25;
/** 並列に出す、リクエストの数の上限。 */
const CONCURRENCY = 8;

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String(error.name)
    : undefined;
}

/** 条件つきの書き込み（ConditionExpression）が、条件を満たさずに失敗したか。 */
export function isConditionalCheckFailed(error: unknown): boolean {
  return errorName(error) === 'ConditionalCheckFailedException';
}

/** トランザクションが、条件を満たさない項目があって取り消されたか。 */
export function isTransactionConditionFailed(error: unknown): boolean {
  if (errorName(error) !== 'TransactionCanceledException') {
    return false;
  }
  const reasons = (error as { CancellationReasons?: readonly { Code?: string }[] })
    .CancellationReasons;
  return reasons?.some((reason) => reason.Code === 'ConditionalCheckFailed') ?? false;
}

export async function getItem(
  db: Database,
  table: string,
  key: Item,
  options: { readonly consistent?: boolean } = {},
): Promise<Item | undefined> {
  const result = await db.client.send(
    new GetCommand({ TableName: table, Key: key, ConsistentRead: options.consistent ?? true }),
  );
  return result.Item;
}

export async function putItem(
  db: Database,
  table: string,
  item: Item,
  condition?: string,
): Promise<void> {
  await db.client.send(
    new PutCommand({
      TableName: table,
      Item: item,
      ...(condition === undefined ? {} : { ConditionExpression: condition }),
    }),
  );
}

export async function deleteItem(db: Database, table: string, key: Item): Promise<void> {
  await db.client.send(new DeleteCommand({ TableName: table, Key: key }));
}

export async function updateItem(
  db: Database,
  table: string,
  input: {
    readonly key: Item;
    readonly update: string;
    readonly names?: Record<string, string>;
    readonly values?: Item;
  },
): Promise<void> {
  await db.client.send(
    new UpdateCommand({
      TableName: table,
      Key: input.key,
      UpdateExpression: input.update,
      ...(input.names === undefined ? {} : { ExpressionAttributeNames: input.names }),
      ...(input.values === undefined ? {} : { ExpressionAttributeValues: input.values }),
    }),
  );
}

/**
 * 条件つきの UpdateItem。条件を満たさなければ、何もしないで false を返す
 * （「最大値だけ更新する」などの、競合しても結果が変わらない更新に使う）。
 */
export async function updateItemIf(
  db: Database,
  table: string,
  input: {
    readonly key: Item;
    readonly update: string;
    readonly condition: string;
    readonly names?: Record<string, string>;
    readonly values?: Item;
  },
): Promise<boolean> {
  try {
    await db.client.send(
      new UpdateCommand({
        TableName: table,
        Key: input.key,
        UpdateExpression: input.update,
        ConditionExpression: input.condition,
        ...(input.names === undefined ? {} : { ExpressionAttributeNames: input.names }),
        ...(input.values === undefined ? {} : { ExpressionAttributeValues: input.values }),
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return false;
    }
    throw error;
  }
}

export async function transactWrite(db: Database, items: readonly TransactItem[]): Promise<void> {
  await db.client.send(new TransactWriteCommand({ TransactItems: [...items] }));
}

/** Query の条件。ソートキーの範囲（両端を含む）は、片方だけでもよい。 */
export interface QueryOptions {
  readonly table: string;
  /** インデックスの名前（テーブル本体なら省略）。 */
  readonly index?: string;
  /** パーティションキー・ソートキーの属性名（インデックスなら、そのキー）。 */
  readonly hashName: string;
  readonly hashValue: string;
  readonly sortName: string;
  readonly lower?: string | undefined;
  readonly upper?: string | undefined;
  readonly forward: boolean;
  /** 1 回の Query で読む件数。 */
  readonly pageSize: number;
  readonly consistent?: boolean;
  /** この位置（ソートキーの値）の次から読む。範囲の内側でなければならない。 */
  readonly startAfter?: Item | undefined;
}

function keyCondition(options: QueryOptions): {
  expression: string;
  names: Record<string, string>;
  values: Item;
} | null {
  const { lower, upper } = options;
  if (lower !== undefined && upper !== undefined && lower > upper) {
    return null;
  }
  const values: Item = { ':h': options.hashValue };
  const names: Record<string, string> = { '#h': options.hashName };
  let expression = '#h = :h';
  if (lower !== undefined || upper !== undefined) {
    names['#s'] = options.sortName;
  }
  if (lower !== undefined && upper !== undefined) {
    expression += ' AND #s BETWEEN :lo AND :hi';
    values[':lo'] = lower;
    values[':hi'] = upper;
  } else if (lower !== undefined) {
    expression += ' AND #s >= :lo';
    values[':lo'] = lower;
  } else if (upper !== undefined) {
    expression += ' AND #s <= :hi';
    values[':hi'] = upper;
  }
  return { expression, names, values };
}

/** Query の結果を、1 ページずつ返す（読み終えたら終わる。消費側が止めれば、それ以降は読まない）。 */
export async function* queryPages(
  db: Database,
  options: QueryOptions,
): AsyncGenerator<Item[], void, undefined> {
  const condition = keyCondition(options);
  if (condition === null) {
    return;
  }
  let startKey = options.startAfter;
  do {
    const result = await db.client.send(
      new QueryCommand({
        TableName: options.table,
        ...(options.index === undefined ? {} : { IndexName: options.index }),
        KeyConditionExpression: condition.expression,
        ExpressionAttributeNames: condition.names,
        ExpressionAttributeValues: condition.values,
        ScanIndexForward: options.forward,
        Limit: options.pageSize,
        ...(options.consistent === true ? { ConsistentRead: true } : {}),
        ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
      }),
    );
    const items = result.Items ?? [];
    if (items.length > 0) {
      yield items;
    }
    startKey = result.LastEvaluatedKey;
  } while (startKey !== undefined);
}

/** Query の結果を、1 件ずつ返す。 */
export async function* queryItems(
  db: Database,
  options: QueryOptions,
): AsyncGenerator<Item, void, undefined> {
  for await (const items of queryPages(db, options)) {
    yield* items;
  }
}

/** パーティションの全件を、ソートキーの昇順で読む（少量のパーティション用）。 */
export async function queryAll(
  db: Database,
  table: string,
  partitionKey: string,
  options: { readonly consistent?: boolean } = {},
): Promise<Item[]> {
  const all: Item[] = [];
  for await (const items of queryPages(db, {
    table,
    hashName: 'pk',
    hashValue: partitionKey,
    sortName: 'sk',
    forward: true,
    pageSize: 1000,
    consistent: options.consistent ?? true,
  })) {
    all.push(...items);
  }
  return all;
}

function chunked<Value>(values: readonly Value[], size: number): Value[][] {
  const chunks: Value[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/** 重複を除いたキーで、まとめて読む（100 件ずつ。処理されなかった分は、再び読む）。 */
export async function batchGetItems(
  db: Database,
  table: string,
  keys: readonly Item[],
  options: { readonly consistent?: boolean } = {},
): Promise<Item[]> {
  const found: Item[] = [];
  for (const chunk of chunked(keys, BATCH_GET_LIMIT)) {
    let pending: Item[] = chunk;
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      if (attempt >= MAX_UNPROCESSED_ATTEMPTS) {
        throw new AppError('SERVICE_UNAVAILABLE', 'データの取得を完了できませんでした');
      }
      if (attempt > 0) {
        await sleep(UNPROCESSED_BASE_DELAY_MS * 2 ** attempt);
      }
      const result = await db.client.send(
        new BatchGetCommand({
          RequestItems: {
            [table]: { Keys: pending, ConsistentRead: options.consistent ?? true },
          },
        }),
      );
      found.push(...(result.Responses?.[table] ?? []));
      pending = result.UnprocessedKeys?.[table]?.Keys ?? [];
    }
  }
  return found;
}

export type WriteRequest = { readonly put: Item } | { readonly delete: Item };

/** まとめて書く（25 件ずつ。処理されなかった分は、待ってから再び書く）。1 つのテーブルに、重複するキーを渡さない。 */
export async function batchWriteItems(
  db: Database,
  table: string,
  requests: readonly WriteRequest[],
): Promise<void> {
  await mapConcurrent(chunked(requests, BATCH_WRITE_LIMIT), CONCURRENCY, async (chunk) => {
    let pending = chunk.map((request) =>
      'put' in request
        ? { PutRequest: { Item: request.put } }
        : { DeleteRequest: { Key: request.delete } },
    );
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      if (attempt >= MAX_UNPROCESSED_ATTEMPTS) {
        throw new AppError('SERVICE_UNAVAILABLE', 'データの書き込みを完了できませんでした');
      }
      if (attempt > 0) {
        await sleep(UNPROCESSED_BASE_DELAY_MS * 2 ** attempt);
      }
      const result = await db.client.send(
        new BatchWriteCommand({ RequestItems: { [table]: pending } }),
      );
      pending = (result.UnprocessedItems?.[table] ?? []) as typeof pending;
    }
  });
}

/** 並列数を制限して、値ごとに処理する（結果は、入力と同じ順）。 */
export async function mapConcurrent<Value, Result>(
  values: readonly Value[],
  limit: number,
  action: (value: Value) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array<Result>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await action(values[index] as Value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

export { CONCURRENCY };
