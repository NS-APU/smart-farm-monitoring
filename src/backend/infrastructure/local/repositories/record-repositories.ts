/** 手動入力と変更履歴の Repository（ローカル実装）。 */

import type { ManualEntrySortKey, SortDirection } from '@smart-farm/shared/constants/sorting';
import { AuditLogEntrySchema } from '@smart-farm/shared/schemas/audit';
import { compareIsoInstants } from '@smart-farm/shared/time';
import { ManualEntrySchema, type ManualEntry } from '@smart-farm/shared/schemas/manual-entry';
import type {
  AuditLogRepository,
  ManualEntryFilter,
  ManualEntryRepository,
} from '../../../application/ports/repositories.ts';
import type { LocalStore } from '../local-store.ts';
import { paginated, saverOf } from './collection-helpers.ts';

function matchesManualEntry(entry: ManualEntry, filter: ManualEntryFilter): boolean {
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

function compareManualEntries(
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

export function createManualEntryRepository(store: LocalStore): ManualEntryRepository {
  const manualEntries = store.collection(
    'manualEntries',
    ManualEntrySchema,
    (item) => item.entryId,
  );
  return {
    get: (entryId) => Promise.resolve(manualEntries.get(entryId)),
    save: saverOf(manualEntries),
    list(filter, page, sort = { key: 'observedAt', direction: 'desc' }) {
      const matched = manualEntries
        .values()
        .filter((entry) => matchesManualEntry(entry, filter))
        .sort(compareManualEntries(sort.key, sort.direction));
      return paginated(matched, page);
    },
  };
}

export function createAuditLogRepository(store: LocalStore): AuditLogRepository {
  const auditLogs = store.collection('auditLogs', AuditLogEntrySchema, (item) => item.auditId);
  return {
    add: saverOf(auditLogs),
    list(filter, page) {
      const fromIso = filter.from?.toISOString();
      const toIso = filter.to?.toISOString();
      const matched = auditLogs
        .values()
        .filter(
          (entry) =>
            (filter.operation === undefined || entry.operation === filter.operation) &&
            (filter.actor === undefined || entry.actor === filter.actor) &&
            (filter.targetType === undefined || entry.targetType === filter.targetType) &&
            (fromIso === undefined || compareIsoInstants(entry.occurredAt, fromIso) >= 0) &&
            (toIso === undefined || compareIsoInstants(entry.occurredAt, toIso) <= 0),
        )
        .sort((left, right) => {
          const sign = filter.direction === 'asc' ? -1 : 1;
          return (
            sign * right.occurredAt.localeCompare(left.occurredAt) ||
            sign * right.auditId.localeCompare(left.auditId)
          );
        });
      return paginated(matched, page);
    },
  };
}
