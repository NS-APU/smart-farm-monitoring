/**
 * 取り込み（取り込み済みファイル・ログ）と、連携（キュー・ログ）の Repository（DynamoDB 実装）。
 *
 * - 取り込み済みファイル: `SRC#{取り込み元}` / `FILE#{ファイル}#{ハッシュ}`、成功したハッシュ `HASH#{ハッシュ}`（最初の成功を残す）
 * - 取り込み元の状態: `SRC#{取り込み元}` / `STATE`（直近の開始・成功・データ取り込みの日時。ログの追加のたびに、最大値で更新する）
 * - 取り込みログ: `ILOG#{取り込み元}` / `{開始日時}#{ログID}`。取り込み元の一覧は、`ILOGSRC` に持つ
 * - 連携の項目: `FED` / `{ID}`。未送信の項目だけが、疎な GSI1（`FDUE`）に載る。状態ごとの件数は、カウンター（`FED#{状態}`）
 * - 連携ログ: `FLOG` / `{日時}#{ログID}`
 */

import {
  FederationItemSchema,
  FederationLogSchema,
  IngestionLogSchema,
  type FederationItem,
} from '@smart-farm/shared/schemas/ingestion';
import { FEDERATION_STATUSES } from '@smart-farm/shared/constants/status';
import {
  IngestedFileRecordSchema,
  type IngestedFileRecord,
} from '../../application/ports/records.ts';
import type {
  FederationRepository,
  IngestionRepository,
} from '../../application/ports/repositories.ts';
import { timedSortKey } from './keys.ts';
import { counterAdd, mainAggregate, readCounters } from './main-table.ts';
import {
  getItem,
  isConditionalCheckFailed,
  putItem,
  queryAll,
  queryItems,
  transactWrite,
  updateItemIf,
  type Database,
  type TransactItem,
} from './operations.ts';
import { pageBySortKey } from './sort-key-page.ts';
import { MAIN_INDEX_1 } from './table-schema.ts';

const FEDERATION_ITEM = 'FED';
const FEDERATION_LOG = 'FLOG';
const FEDERATION_DUE = 'FDUE';
const INGESTION_SOURCES = 'ILOGSRC';

const sourcePartition = (sourceId: string): string => `SRC#${sourceId}`;
const logPartition = (sourceId: string): string => `ILOG#${sourceId}`;
const fileSortKey = (fileId: string, contentHash: string): string =>
  `FILE#${fileId}#${contentHash}`;
const hashSortKey = (contentHash: string): string => `HASH#${contentHash}`;
const STATE = 'STATE';
const federationCounter = (status: FederationItem['status']): string => `FED#${status}`;

function toDate(value: unknown): Date | null {
  return typeof value === 'number' ? new Date(value) : null;
}

export function createIngestionRepository(db: Database): IngestionRepository {
  const table = db.tables.main;
  const files = mainAggregate(db, IngestedFileRecordSchema);
  const logs = mainAggregate(db, IngestionLogSchema);

  /** 取り込み元の状態の日時を、新しい値のときだけ更新する（古いログを後から足しても、戻さない）。 */
  async function raiseState(
    sourceId: string,
    attribute: string,
    isoDateTime: string,
  ): Promise<void> {
    await updateItemIf(db, table, {
      key: { pk: sourcePartition(sourceId), sk: STATE },
      update: 'SET #a = :v',
      condition: 'attribute_not_exists(#a) OR #a < :v',
      names: { '#a': attribute },
      values: { ':v': Date.parse(isoDateTime) },
    });
  }

  async function stateOf(sourceId: string, attribute: string): Promise<Date | null> {
    const state = await getItem(db, table, { pk: sourcePartition(sourceId), sk: STATE });
    return toDate(state?.[attribute]);
  }

  return {
    async findIngestedFile(sourceId, fileId, contentHash) {
      // 識別子とハッシュが同じ記録（結果を問わない）、または、ハッシュが同じ成功の記録
      const [sameFile, sameContent] = await Promise.all([
        files.get(sourcePartition(sourceId), fileSortKey(fileId, contentHash)),
        files.get(sourcePartition(sourceId), hashSortKey(contentHash)),
      ]);
      return sameFile ?? sameContent;
    },
    async recordFile(record: IngestedFileRecord) {
      const partition = sourcePartition(record.sourceId);
      await files.put(partition, fileSortKey(record.fileId, record.contentHash), record);
      if (record.result === 'SUCCESS') {
        // 同じ内容の最初の成功を残す（ファイル名が違っても、同じ内容は、取り込み済み）
        try {
          await putItem(
            db,
            table,
            { pk: partition, sk: hashSortKey(record.contentHash), data: record },
            'attribute_not_exists(pk)',
          );
        } catch (error) {
          if (!isConditionalCheckFailed(error)) {
            throw error;
          }
        }
      }
    },
    async addLog(log) {
      await logs.put(logPartition(log.sourceId), timedSortKey(log.startedAt, log.logId), log);
      await putItem(db, table, { pk: INGESTION_SOURCES, sk: log.sourceId });
      await Promise.all([
        raiseState(log.sourceId, 'lastStarted', log.startedAt),
        log.result === 'SUCCESS'
          ? raiseState(log.sourceId, 'lastSucceeded', log.finishedAt)
          : Promise.resolve(),
        log.recordCount > 0
          ? raiseState(log.sourceId, 'lastDataIngested', log.finishedAt)
          : Promise.resolve(),
      ]);
    },
    async listLogs(filter, page) {
      const partitions =
        filter.sourceId === undefined
          ? (await queryAll(db, table, INGESTION_SOURCES)).map((item) =>
              logPartition(String(item.sk)),
            )
          : [logPartition(filter.sourceId)];
      const result = await pageBySortKey(db, {
        partitions,
        forward: false,
        limit: page.limit,
        cursor: page.cursor,
      });
      return { items: result.items.map(logs.parse), nextCursor: result.nextCursor };
    },
    lastStartedAt: (sourceId) => stateOf(sourceId, 'lastStarted'),
    lastSucceededAt: (sourceId) => stateOf(sourceId, 'lastSucceeded'),
    lastDataIngestedAt: (sourceId) => stateOf(sourceId, 'lastDataIngested'),
  };
}

export function createFederationRepository(db: Database): FederationRepository {
  const table = db.tables.main;
  const items = mainAggregate(db, FederationItemSchema);
  const logs = mainAggregate(db, FederationLogSchema);

  /** 項目を保存し、状態が変わったら、同じトランザクションで、状態ごとの件数を更新する。 */
  async function save(item: FederationItem): Promise<void> {
    const existing = await items.get(FEDERATION_ITEM, item.federationItemId);
    const indexKeys =
      item.status === 'SENT'
        ? {}
        : { gsi1pk: FEDERATION_DUE, gsi1sk: timedSortKey(item.enqueuedAt, item.federationItemId) };
    if (existing?.status === item.status) {
      await items.put(FEDERATION_ITEM, item.federationItemId, item, indexKeys);
      return;
    }
    const operations: TransactItem[] = [
      items.putOperation(FEDERATION_ITEM, item.federationItemId, item, indexKeys),
      counterAdd(db, federationCounter(item.status), 1),
    ];
    if (existing !== undefined) {
      operations.push(counterAdd(db, federationCounter(existing.status), -1));
    }
    await transactWrite(db, operations);
  }

  return {
    enqueue: save,
    async listDue(now, limit) {
      const nowMs = now.getTime();
      const due: FederationItem[] = [];
      for await (const stored of queryItems(db, {
        table,
        index: MAIN_INDEX_1,
        hashName: 'gsi1pk',
        hashValue: FEDERATION_DUE,
        sortName: 'gsi1sk',
        forward: true,
        pageSize: Math.min(1000, Math.max(limit, 25)),
      })) {
        const item = items.parse(stored);
        if (Date.parse(item.nextAttemptAt) <= nowMs) {
          due.push(item);
          if (due.length >= limit) {
            break;
          }
        }
      }
      return due;
    },
    update: save,
    addLog: (entry) => logs.put(FEDERATION_LOG, timedSortKey(entry.occurredAt, entry.logId), entry),
    async listLogs(page) {
      const result = await pageBySortKey(db, {
        partitions: [FEDERATION_LOG],
        forward: false,
        limit: page.limit,
        cursor: page.cursor,
      });
      return { items: result.items.map(logs.parse), nextCursor: result.nextCursor };
    },
    async countByStatus() {
      const counts = await readCounters(db, FEDERATION_STATUSES.map(federationCounter));
      return {
        PENDING: counts.get(federationCounter('PENDING')) ?? 0,
        SENT: counts.get(federationCounter('SENT')) ?? 0,
        FAILED: counts.get(federationCounter('FAILED')) ?? 0,
        HELD: counts.get(federationCounter('HELD')) ?? 0,
      };
    },
  };
}
