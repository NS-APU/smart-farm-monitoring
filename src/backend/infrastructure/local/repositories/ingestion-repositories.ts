/** 取り込み（取り込み済みファイル・ログ）と、連携（キュー・ログ）の Repository（ローカル実装）。 */

import {
  FederationItemSchema,
  FederationLogSchema,
  IngestionLogSchema,
} from '@smart-farm/shared/schemas/ingestion';
import {
  IngestedFileRecordSchema,
  type IngestedFileRecord,
} from '../../../application/ports/records.ts';
import type {
  FederationRepository,
  IngestionRepository,
} from '../../../application/ports/repositories.ts';
import type { LocalStore } from '../local-store.ts';
import { latestOf, paginated, saverOf } from './collection-helpers.ts';

export interface LocalIngestionRepository {
  readonly repository: IngestionRepository;
  /** 取り込み済みファイルの索引を捨てる（次の参照で、全件から作り直す）。 */
  resetIndex(): void;
}

export function createIngestionRepository(store: LocalStore): LocalIngestionRepository {
  const ingestedFiles = store.collection(
    'ingestedFiles',
    IngestedFileRecordSchema,
    (item) => `${item.sourceId}#${item.fileId}#${item.contentHash}`,
  );
  const ingestionLogs = store.collection('ingestionLogs', IngestionLogSchema, (item) => item.logId);

  // 取り込み元と内容のハッシュの組 → 成功した記録（ファイル名が違っても、同じ内容は、取り込み済み）。
  // 件数が増えても、全件を走査しない（V-082）。読み込み・全消去で、作り直す
  let successByHash: Map<string, IngestedFileRecord> | undefined;
  const hashKey = (record: Pick<IngestedFileRecord, 'sourceId' | 'contentHash'>): string =>
    `${record.sourceId}#${record.contentHash}`;
  function successIndex(): Map<string, IngestedFileRecord> {
    if (successByHash === undefined) {
      successByHash = new Map();
      for (const record of ingestedFiles.values()) {
        if (record.result === 'SUCCESS' && !successByHash.has(hashKey(record))) {
          successByHash.set(hashKey(record), record);
        }
      }
    }
    return successByHash;
  }

  const repository: IngestionRepository = {
    findIngestedFile(sourceId, fileId, contentHash) {
      // 識別子とハッシュが同じ記録（結果を問わない）、または、ハッシュが同じ成功の記録
      return Promise.resolve(
        ingestedFiles.get(`${sourceId}#${fileId}#${contentHash}`) ??
          successIndex().get(hashKey({ sourceId, contentHash })),
      );
    },
    async recordFile(record) {
      await saverOf(ingestedFiles)(record);
      if (successByHash !== undefined && record.result === 'SUCCESS') {
        if (!successByHash.has(hashKey(record))) {
          successByHash.set(hashKey(record), record);
        }
      }
    },
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
    lastStartedAt(sourceId) {
      return Promise.resolve(
        latestOf(
          ingestionLogs
            .values()
            .filter((log) => log.sourceId === sourceId)
            .map((log) => log.startedAt),
        ),
      );
    },
    lastSucceededAt(sourceId) {
      return Promise.resolve(
        latestOf(
          ingestionLogs
            .values()
            .filter((log) => log.sourceId === sourceId && log.result === 'SUCCESS')
            .map((log) => log.finishedAt),
        ),
      );
    },
    lastDataIngestedAt(sourceId) {
      return Promise.resolve(
        latestOf(
          ingestionLogs
            .values()
            .filter((log) => log.sourceId === sourceId && log.recordCount > 0)
            .map((log) => log.finishedAt),
        ),
      );
    },
  };

  return {
    repository,
    resetIndex() {
      successByHash = undefined;
    },
  };
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
          .filter((item) => item.status !== 'SENT' && item.nextAttemptAt <= nowIso)
          .sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt))
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
    countByStatus() {
      const counts = { PENDING: 0, SENT: 0, FAILED: 0, HELD: 0 };
      for (const item of federationItems.values()) {
        counts[item.status] += 1;
      }
      return Promise.resolve(counts);
    },
  };
}
