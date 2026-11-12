/** 取り込み（取り込み済みファイル・ログ）と、連携（キュー・ログ）の Repository（ローカル実装）。 */

import {
  FederationItemSchema,
  type FacilityFederationLog,
  type FacilityIngestionLog,
  type FederationItem,
  FederationLogSchema,
  IngestionLogSchema,
} from '@smart-farm/shared/schemas/ingestion';
import {
  EquipmentIngestionStateSchema,
  IngestedFileRecordSchema,
  SourceIngestionStateSchema,
} from '../../../application/ports/records.ts';
import type {
  FederationRepository,
  IngestionRepository,
} from '../../../application/ports/repositories.ts';
import type { LocalStore } from '../local-store.ts';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import { paginated, saverOf } from './collection-helpers.ts';

/** ハウス別の記録の並び: 新しい順（同じ日時は、ログ・ハウスの識別子の降順。DynamoDB のソートキーと同じ順）。 */
function byNewest(
  left: { readonly occurredAt: string; readonly logId: string; readonly facilityId: string },
  right: { readonly occurredAt: string; readonly logId: string; readonly facilityId: string },
): number {
  return (
    right.occurredAt.localeCompare(left.occurredAt) ||
    right.logId.localeCompare(left.logId) ||
    right.facilityId.localeCompare(left.facilityId)
  );
}

export interface LocalIngestionRepository {
  readonly repository: IngestionRepository;
}

export function createIngestionRepository(store: LocalStore): LocalIngestionRepository {
  const ingestedFiles = store.collection(
    'ingestedFiles',
    IngestedFileRecordSchema,
    (item) => `${item.sourceId}#${item.fileId}`,
  );
  const ingestionLogs = store.collection('ingestionLogs', IngestionLogSchema, (item) => item.logId);
  const equipmentStates = store.collection(
    'ingestionEquipmentStates',
    EquipmentIngestionStateSchema,
    (item) => item.equipmentId,
  );
  const sourceStates = store.collection(
    'ingestionSourceStates',
    SourceIngestionStateSchema,
    (item) => item.sourceId,
  );

  const repository: IngestionRepository = {
    findIngestedFile(sourceId, fileId, contentHash) {
      // 同じ識別子の、最新の版が、同じハッシュなら、取り込み済み（結果を問わない。Issue #201）
      const latest = ingestedFiles.get(`${sourceId}#${fileId}`);
      return Promise.resolve(latest?.contentHash === contentHash ? latest : undefined);
    },
    recordFile: saverOf(ingestedFiles),
    addLog: saverOf(ingestionLogs),
    listLogs(filter, page) {
      const matched = ingestionLogs
        .values()
        .filter((log) => filter.sourceId === undefined || log.sourceId === filter.sourceId)
        .sort(
          (left, right) =>
            right.startedAt.localeCompare(left.startedAt) || right.logId.localeCompare(left.logId),
        );
      return paginated(matched, page);
    },
    listFacilityLogs(facilityIds, page) {
      const entries: FacilityIngestionLog[] = ingestionLogs.values().flatMap((log) =>
        (log.facilities ?? [])
          .filter((entry) => facilityIds.includes(entry.facilityId))
          .map((entry) => ({
            logId: log.logId,
            facilityId: entry.facilityId,
            sourceId: log.sourceId,
            occurredAt: log.startedAt,
            result: entry.result,
            recordCount: entry.recordCount,
          })),
      );
      return paginated(entries.sort(byNewest), page);
    },
    lastStartedAt(sourceId) {
      const state = sourceStates.get(sourceId);
      return Promise.resolve(state === undefined ? null : new Date(state.startedAt));
    },
    recordSourceStarted(sourceId, at) {
      const startedAt = at.toISOString();
      const current = sourceStates.get(sourceId);
      if (current === undefined || current.startedAt < startedAt) {
        sourceStates.put({ sourceId, startedAt });
      }
      return Promise.resolve();
    },
    listEquipmentRuns() {
      return Promise.resolve(
        new Map(
          equipmentStates.values().map((state) => [
            state.equipmentId,
            {
              startedAt: new Date(state.startedAt),
              finishedAt: new Date(state.finishedAt),
              result: state.result,
              lastSucceededAt: state.succeededAt === undefined ? null : new Date(state.succeededAt),
              lastDataAt: state.dataAt === undefined ? null : new Date(state.dataAt),
            },
          ]),
        ),
      );
    },
    recordEquipmentRuns(runs) {
      for (const run of runs) {
        const current = equipmentStates.get(run.equipmentId);
        const startedAt = run.startedAt.toISOString();
        if (current !== undefined && current.startedAt > startedAt) {
          continue;
        }
        const finishedAt = run.finishedAt.toISOString();
        const succeededAt = run.result === 'SUCCESS' ? finishedAt : current?.succeededAt;
        const dataAt = run.dataIngested ? finishedAt : current?.dataAt;
        equipmentStates.put({
          equipmentId: toEquipmentId(run.equipmentId),
          startedAt,
          finishedAt,
          result: run.result,
          ...(succeededAt === undefined ? {} : { succeededAt }),
          ...(dataAt === undefined ? {} : { dataAt }),
        });
      }
      return Promise.resolve();
    },
  };

  return { repository };
}

/** 送信していない項目（送信済み・期限切れ（破棄）を除く）。 */
function isUnsent(item: FederationItem): boolean {
  return item.status !== 'SENT' && item.status !== 'EXPIRED';
}

/** 次の試行の日時の順（同じ日時は、積んだ日時の順。それも同じなら、積んだ順（安定ソート））。 */
function byNextAttempt(left: FederationItem, right: FederationItem): number {
  return (
    left.nextAttemptAt.localeCompare(right.nextAttemptAt) ||
    left.enqueuedAt.localeCompare(right.enqueuedAt)
  );
}

export function createFederationRepository(store: LocalStore): FederationRepository {
  const federationItems = store.collection(
    'federationItems',
    FederationItemSchema,
    (item) => item.federationItemId,
  );
  const federationLogs = store.collection(
    'federationLogs',
    FederationLogSchema,
    (item) => item.logId,
  );

  return {
    enqueue: saverOf(federationItems),
    listDue(now, limit) {
      const nowIso = now.toISOString();
      return Promise.resolve(
        federationItems
          .values()
          .filter((item) => isUnsent(item) && item.nextAttemptAt <= nowIso)
          .sort(byNextAttempt)
          .slice(0, limit),
      );
    },
    listWaiting(now, limit) {
      const nowIso = now.toISOString();
      return Promise.resolve(
        federationItems
          .values()
          .filter(
            (item) =>
              (item.status === 'HELD' || item.status === 'FAILED') && item.nextAttemptAt > nowIso,
          )
          .sort(byNextAttempt)
          .slice(0, limit),
      );
    },
    update: saverOf(federationItems),
    addLog: saverOf(federationLogs),
    listLogs(page) {
      const sorted = federationLogs
        .values()
        .sort(
          (left, right) =>
            right.occurredAt.localeCompare(left.occurredAt) ||
            right.logId.localeCompare(left.logId),
        );
      return paginated(sorted, page);
    },
    listFacilityLogs(facilityIds, page) {
      const entries: FacilityFederationLog[] = federationLogs.values().flatMap((log) =>
        (log.facilities ?? [])
          .filter((entry) => facilityIds.includes(entry.facilityId))
          .map((entry) => ({
            logId: log.logId,
            facilityId: entry.facilityId,
            occurredAt: log.occurredAt,
            result: log.result,
            itemCount: entry.itemCount,
          })),
      );
      return paginated(entries.sort(byNewest), page);
    },
    countByStatus() {
      const counts = { PENDING: 0, SENT: 0, FAILED: 0, HELD: 0, EXPIRED: 0 };
      for (const item of federationItems.values()) {
        counts[item.status] += 1;
      }
      return Promise.resolve(counts);
    },
  };
}
