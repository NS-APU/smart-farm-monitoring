/** 手動入力と変更履歴の Repository（ローカル実装）。 */

import { AuditLogEntrySchema } from '@smart-farm/shared/schemas/audit';
import { compareIsoInstants } from '@smart-farm/shared/time';
import { ManualEntrySchema } from '@smart-farm/shared/schemas/manual-entry';
import type {
  AuditLogRepository,
  ManualEntryRepository,
} from '../../../application/ports/repositories.ts';
import { compareManualEntries, matchesManualEntry } from '../../common/manual-entry-rules.ts';
import type { LocalStore } from '../local-store.ts';
import { paginated, saverOf } from './collection-helpers.ts';

export function createManualEntryRepository(store: LocalStore): ManualEntryRepository {
  const manualEntries = store.collection(
    'manualEntries',
    ManualEntrySchema,
    (item) => item.entryId,
  );
  return {
    get: (entryId) => Promise.resolve(manualEntries.get(entryId)),
    save: saverOf(manualEntries),
    deleteByEquipment(equipmentId) {
      const removed = manualEntries
        .values()
        .filter((entry) => entry.equipmentId === equipmentId)
        .map((entry) => entry.entryId);
      for (const entryId of removed) {
        manualEntries.delete(entryId);
      }
      return Promise.resolve(removed);
    },
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
    deleteByTargets(targetType, targetIds) {
      const ids = new Set(targetIds);
      const removed = auditLogs
        .values()
        .filter((entry) => entry.targetType === targetType && ids.has(entry.targetId));
      for (const entry of removed) {
        auditLogs.delete(entry.auditId);
      }
      return Promise.resolve(removed.length);
    },
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
            (filter.targetId === undefined || entry.targetId === filter.targetId) &&
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
