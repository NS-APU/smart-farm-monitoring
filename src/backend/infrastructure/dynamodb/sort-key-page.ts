/**
 * Main テーブルの、時刻つきのソートキー（`{日時}#{識別子}`）の一覧を、ページで返す。
 * 複数のパーティション（取り込み元ごとのログなど）は、ソートキーの順に併合する。カーソルは、最後のソートキー。
 */

import { decodeKeyCursor, encodeKeyCursor } from './key-cursor.ts';
import { mergeStreams } from './merge.ts';
import { queryItems, type Database, type Item } from './operations.ts';

export interface SortKeyPageRequest {
  readonly partitions: readonly string[];
  /** true なら、ソートキーの昇順（古い順）。 */
  readonly forward: boolean;
  readonly limit: number;
  readonly cursor: string | undefined;
  /** ソートキーの範囲（両端を含む）。 */
  readonly lower?: string | undefined;
  readonly upper?: string | undefined;
  /** アイテムの追加の絞り込み。 */
  readonly accept?: ((item: Item) => boolean) | undefined;
}

async function* accepted(
  items: AsyncGenerator<Item, void, undefined>,
  accept: ((item: Item) => boolean) | undefined,
): AsyncGenerator<Item, void, undefined> {
  for await (const item of items) {
    if (accept === undefined || accept(item)) {
      yield item;
    }
  }
}

export async function pageBySortKey(
  db: Database,
  request: SortKeyPageRequest,
): Promise<{ items: Item[]; nextCursor: string | null }> {
  const after = decodeKeyCursor(request.cursor, 1)?.[0];
  const streams = request.partitions.map((partition) =>
    accepted(
      queryItems(db, {
        table: db.tables.main,
        hashName: 'pk',
        hashValue: partition,
        sortName: 'sk',
        lower: request.lower,
        upper: request.upper,
        forward: request.forward,
        pageSize: Math.min(1000, Math.max(request.limit + 1, 25)),
        consistent: true,
        startAfter: after === undefined ? undefined : { pk: partition, sk: after },
      }),
      request.accept,
    ),
  );
  const direction = request.forward ? 1 : -1;
  const merged = await mergeStreams(
    streams,
    (left, right) => {
      const leftKey = String(left.sk);
      const rightKey = String(right.sk);
      return direction * (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0);
    },
    request.limit + 1,
  );
  const items = merged.slice(0, request.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      merged.length > request.limit && last !== undefined
        ? encodeKeyCursor([String(last.sk)])
        : null,
  };
}
