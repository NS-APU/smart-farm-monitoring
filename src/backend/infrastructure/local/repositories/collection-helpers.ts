/**
 * ローカル実装の Repository で共通に使う補助: 保存・削除の Promise 化、削除済みの除外、
 * 通知の既読のキー、最新日時の取得（ページ分割は common/pagination.ts）。
 */

import type { Collection } from '../local-store.ts';

// ページ分割の処理は、DynamoDB 実装と共通のため、common/ にある（既存の参照を保つため、ここから再公開する）
export { decodeCursor, encodeCursor, paginated, paginatedSorted } from '../../common/pagination.ts';

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
