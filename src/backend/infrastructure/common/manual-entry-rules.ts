/**
 * 手動入力の絞り込み・並べ替えの規則（ローカル実装と DynamoDB 実装で共通）。
 */

import type { ManualEntrySortKey, SortDirection } from '@smart-farm/shared/constants/sorting';
import { compareIsoInstants } from '@smart-farm/shared/time';
import type { ManualEntry } from '@smart-farm/shared/schemas/manual-entry';
import type { ManualEntryFilter } from '../../application/ports/repositories.ts';

export function matchesManualEntry(entry: ManualEntry, filter: ManualEntryFilter): boolean {
  const fromIso = filter.from?.toISOString();
  const toIso = filter.to?.toISOString();
  return (
    !entry.isDeleted &&
    (filter.category === undefined || entry.category === filter.category) &&
    (filter.equipmentId === undefined || entry.equipmentId === filter.equipmentId) &&
    (fromIso === undefined || compareIsoInstants(entry.observedAt, fromIso) >= 0) &&
    (toIso === undefined || compareIsoInstants(entry.observedAt, toIso) <= 0) &&
    (filter.matches?.(entry) ?? true)
  );
}

export function compareManualEntries(
  key: ManualEntrySortKey,
  direction: SortDirection,
): (left: ManualEntry, right: ManualEntry) => number {
  const sign = direction === 'asc' ? 1 : -1;
  return (left, right) =>
    // 同じ値のときは、計測日時の新しい順 → 識別子の順で並べ、ページ分割の結果を安定させる
    sign * left[key].localeCompare(right[key]) ||
    right.observedAt.localeCompare(left.observedAt) ||
    left.entryId.localeCompare(right.entryId);
}
