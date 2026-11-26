/** 取り込み（取り込み済みファイル・ログ）と、連携（キュー・ログ）の Repository（ローカル実装）。 */

import {
  FederationItemSchema,
  type FacilityFederationLog,
  type FacilityIngestionLog,
  type FederationItem,
  FederationLogSchema,
  IngestionLogSchema,
  type IngestionLog,
} from '@smart-farm/shared/schemas/ingestion';
import {
  EquipmentIngestionStateSchema,
  IngestedFileRecordSchema,
  SourceIngestionStateSchema,
} from '../../../application/ports/records.ts';
import { z } from 'zod';
import type { ClockPort } from '../../../application/ports/clock-port.ts';
import type {
  FederationRepository,
  IngestionLogFilter,
  IngestionRepository,
} from '../../../application/ports/repositories.ts';
import { isLogExpired } from '../../common/log-retention.ts';
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

/** 設備の絞り込み: その設備のログと、（取り込み元を指定すれば）その取り込み元の、設備に結びつかないログ。 */
function matchesEquipment(log: IngestionLog, equipment: IngestionLogFilter['equipment']): boolean {
  if (equipment === undefined) {
    return true;
  }
  return log.equipmentId === undefined
    ? equipment.sourceId !== undefined && log.sourceId === equipment.sourceId
    : log.equipmentId === equipment.equipmentId;
}

/** 結果の絞り込み: 成功は SUCCESS。失敗は、FAILURE と、一部成功（PARTIAL）。 */
function matchesResult(
  result: IngestionLog['result'],
  wanted: IngestionLogFilter['result'],
): boolean {
  if (wanted === undefined) {
    return true;
  }
  return wanted === 'SUCCESS' ? result === 'SUCCESS' : result !== 'SUCCESS';
}

export interface LocalIngestionRepository {
  readonly repository: IngestionRepository;
}

/**
 * 取り込みログの期限切れ（90 日。Issue #230）は、時計を渡したときだけ、読み書きのときに消す
 * （DynamoDB 実装は、TTL で消える。時計がないと、固定の日付のデータを使うテストが、時間の経過で壊れるため、消さない）。
 */
export function createIngestionRepository(
  store: LocalStore,
  clock?: ClockPort,
): LocalIngestionRepository {
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

  function purgeExpiredLogs(): void {
    if (clock === undefined) {
      return;
    }
    const now = clock.now();
    for (const log of ingestionLogs.values()) {
      if (isLogExpired(log.startedAt, now)) {
        ingestionLogs.delete(log.logId);
      }
    }
  }

  const repository: IngestionRepository = {
    findIngestedFile(sourceId, fileId, contentHash) {
      // 同じ識別子の、最新の版が、同じハッシュなら、取り込み済み（結果を問わない。Issue #201）
      const latest = ingestedFiles.get(`${sourceId}#${fileId}`);
      return Promise.resolve(latest?.contentHash === contentHash ? latest : undefined);
    },
    recordFile: saverOf(ingestedFiles),
    addLog(log) {
      purgeExpiredLogs();
      ingestionLogs.put(log);
      return Promise.resolve();
    },
    listLogs(filter, page) {
      purgeExpiredLogs();
      const matched = ingestionLogs
        .values()
        .filter((log) => filter.sourceId === undefined || log.sourceId === filter.sourceId)
        .filter((log) => matchesEquipment(log, filter.equipment))
        .filter((log) => matchesResult(log.result, filter.result))
        .filter(
          (log) =>
            (filter.from === undefined || log.startedAt >= filter.from.toISOString()) &&
            (filter.to === undefined || log.startedAt <= filter.to.toISOString()),
        )
        .sort(
          (left, right) =>
            right.startedAt.localeCompare(left.startedAt) || right.logId.localeCompare(left.logId),
        );
      return paginated(matched, page);
    },
    listFacilityLogs(facilityIds, page) {
      purgeExpiredLogs();
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

/** 期限で消えた、送信済みの連携項目の件数（DynamoDB 実装の、状態ごとのカウンターは、TTL で消えても減らない。累計）。 */
const SENT_PURGED_KEY = 'SENT';
const SentPurgedSchema = z.object({
  key: z.literal(SENT_PURGED_KEY),
  count: z.number().int().nonnegative(),
});

/** 連携ログ・送信済みの連携項目の期限切れ（90 日。Issue #230）は、取り込みログと同じく、時計を渡したときだけ消す。 */
export function createFederationRepository(
  store: LocalStore,
  clock?: ClockPort,
): FederationRepository {
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
  const sentPurged = store.collection('federationSentPurged', SentPurgedSchema, (item) => item.key);

  function purgeExpired(): void {
    if (clock === undefined) {
      return;
    }
    const now = clock.now();
    for (const log of federationLogs.values()) {
      if (isLogExpired(log.occurredAt, now)) {
        federationLogs.delete(log.logId);
      }
    }
    // 送信済みになった時点（更新日時）から 90 日。消えた分は、件数に残す
    const expired = federationItems
      .values()
      .filter((item) => item.status === 'SENT' && isLogExpired(item.updatedAt, now));
    if (expired.length > 0) {
      for (const item of expired) {
        federationItems.delete(item.federationItemId);
      }
      sentPurged.put({
        key: SENT_PURGED_KEY,
        count: (sentPurged.get(SENT_PURGED_KEY)?.count ?? 0) + expired.length,
      });
    }
  }

  return {
    enqueue(item) {
      purgeExpired();
      federationItems.put(item);
      return Promise.resolve();
    },
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
    update(item) {
      purgeExpired();
      federationItems.put(item);
      return Promise.resolve();
    },
    addLog(entry) {
      purgeExpired();
      federationLogs.put(entry);
      return Promise.resolve();
    },
    listLogs(page) {
      purgeExpired();
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
      purgeExpired();
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
      purgeExpired();
      const counts = {
        PENDING: 0,
        SENT: sentPurged.get(SENT_PURGED_KEY)?.count ?? 0,
        FAILED: 0,
        HELD: 0,
        EXPIRED: 0,
      };
      for (const item of federationItems.values()) {
        counts[item.status] += 1;
      }
      return Promise.resolve(counts);
    },
  };
}
