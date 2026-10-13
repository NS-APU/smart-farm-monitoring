/**
 * ローカル実装の Repository で共通に使う補助: ページ分割（不透明なカーソル）、保存・削除の Promise 化、
 * 通知の既読のキー、最新日時の取得。
 */

import { AppError } from '@smart-farm/shared/errors';
import type { Page, PageRequest } from '../../../application/ports/repositories.ts';
import type { Collection } from '../local-store.ts';

/** 件数と位置（オフセット）から、不透明なカーソルを作る。 */
export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const offset = Number(decoded);
  if (!/^\d+$/.test(decoded) || !Number.isSafeInteger(offset)) {
    throw new AppError('VALIDATION_ERROR', 'cursor が不正です', {
      fields: [{ name: 'cursor', message: 'cursor が不正です' }],
    });
  }
  return offset;
}

function paginate<Item>(items: readonly Item[], page: PageRequest): Page<Item> {
  const offset = decodeCursor(page.cursor);
  const end = offset + page.limit;
  return {
    items: items.slice(offset, end),
    nextCursor: end < items.length ? encodeCursor(end) : null,
  };
}

/** ページ分割した結果を返す。不正なカーソルは、同期の例外ではなく、拒否された Promise にする。 */
export function paginated<Item>(items: readonly Item[], page: PageRequest): Promise<Page<Item>> {
  try {
    return Promise.resolve(paginate(items, page));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** 先頭からこの件数までのページは、全件の並べ替えをせず、上位の件数だけを選ぶ。 */
const TOP_SELECTION_LIMIT = 1000;

/**
 * 並べ替えてからページ分割した結果を返す。比較関数は、全順序（同じ順位がない）でなければならない。
 * 先頭に近いページ（位置 + 件数が TOP_SELECTION_LIMIT 以下）は、全件の並べ替え（n log n）ではなく、
 * 上位の件数だけを保つ選択（n × 小さな定数）で求める。結果は、全件を並べ替えた場合と同じ（V-075）。
 */
export function paginatedSorted<Item>(
  items: readonly Item[],
  compare: (left: Item, right: Item) => number,
  page: PageRequest,
): Promise<Page<Item>> {
  try {
    const offset = decodeCursor(page.cursor);
    const end = offset + page.limit;
    if (end > TOP_SELECTION_LIMIT) {
      return paginated([...items].sort(compare), page);
    }
    const top = selectSmallest(items, compare, end);
    return Promise.resolve({
      items: top.slice(offset, end),
      nextCursor: end < items.length ? encodeCursor(end) : null,
    });
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** 比較関数の順で、先頭から count 件を、昇順で返す（上位 count 件だけを、二分探索で挿入して保つ）。 */
function selectSmallest<Item>(
  items: readonly Item[],
  compare: (left: Item, right: Item) => number,
  count: number,
): Item[] {
  const selected: Item[] = [];
  if (count <= 0) {
    return selected;
  }
  for (const item of items) {
    const worst = selected.at(-1);
    if (selected.length >= count && worst !== undefined && compare(item, worst) >= 0) {
      continue;
    }
    let low = 0;
    let high = selected.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const candidate = selected[middle];
      if (candidate !== undefined && compare(candidate, item) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    selected.splice(low, 0, item);
    if (selected.length > count) {
      selected.pop();
    }
  }
  return selected;
}

/** 値を保存する（同じキーは上書き）。同期の処理を、Promise を返す Repository のメソッドにする。 */
export function saverOf<Value>(collection: Collection<Value>): (value: Value) => Promise<void> {
  return (value) => {
    collection.put(value);
    return Promise.resolve();
  };
}

/** キーで削除する。 */
export function deleterOf<Value>(collection: Collection<Value>): (key: string) => Promise<void> {
  return (key) => {
    collection.delete(key);
    return Promise.resolve();
  };
}

/** 削除済みを除くか（includeDeleted が true のときだけ、削除済みも含める）。 */
export function visibleOnly<Item extends { readonly isDeleted: boolean }>(
  items: readonly Item[],
  listOptions: { readonly includeDeleted?: boolean } | undefined,
): Item[] {
  return items.filter((item) => listOptions?.includeDeleted === true || !item.isDeleted);
}

/** 通知の既読の記録のキー（通知と利用者の組）。 */
export function readKey(notificationId: string, userId: string): string {
  return `${notificationId}#${userId}`;
}

/** 日時（ISO 8601）の文字列のうち、最も新しいものを Date で返す。1件もなければ null。 */
export function latestOf(isoValues: Iterable<string>): Date | null {
  let latest: string | undefined;
  for (const value of isoValues) {
    if (latest === undefined || value > latest) {
      latest = value;
    }
  }
  return latest === undefined ? null : new Date(latest);
}
