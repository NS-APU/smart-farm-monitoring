/**
 * 取り込み（取り込み済みファイル・ログ）と、連携（キュー・ログ）の Repository（DynamoDB 実装）。
 *
 * - 取り込み済みファイル: `SRC#{取り込み元}` / `FILE#{ファイル}#{ハッシュ}`、成功したハッシュ `HASH#{ハッシュ}`（最初の成功を残す）
 * - 取り込み元の状態: `SRC#{取り込み元}` / `STATE`（直近の開始・成功・データ取り込みの日時。ログの追加のたびに、最大値で更新する）
 * - 取り込みログ: `ILOG#{取り込み元}` / `{開始日時}#{ログID}`。取り込み元の一覧は、`ILOGSRC` に持つ
 * - ハウス別の取り込みの記録（Issue #332。ログの facilities の内訳。一般ユーザー向け）: `ILOGF#{ハウス}` / `{開始日時}#{ログID}#{ハウス}`
 * - 連携の項目: `FED` / `{ID}`。未送信の項目だけが、疎な GSI1（`FDUE`）に載る。状態ごとの件数は、カウンター（`FED#{状態}`）
 * - 連携ログ: `FLOG` / `{日時}#{ログID}`
 * - ハウス別の連携の記録（Issue #332。ログの facilities の内訳。一般ユーザー向け）: `FLOGF#{ハウス}` / `{日時}#{ログID}#{ハウス}`
 */

import {
  FacilityFederationLogSchema,
  FacilityIngestionLogSchema,
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
import { instantKey, timedSortKey, upperBoundOf } from './keys.ts';
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
const facilityIngestionPartition = (facilityId: string): string => `ILOGF#${facilityId}`;
const facilityFederationPartition = (facilityId: string): string => `FLOGF#${facilityId}`;
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
  const facilityLogs = mainAggregate(db, FacilityIngestionLogSchema);

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
      // ハウスごとの内訳は、ハウス別の記録としても持つ（一般ユーザーが、全体のログを読まずに、自分のハウスの分だけを読めるように）
      for (const entry of log.facilities ?? []) {
        await facilityLogs.put(
          facilityIngestionPartition(entry.facilityId),
          timedSortKey(log.startedAt, `${log.logId}#${entry.facilityId}`),
          {
            logId: log.logId,
            facilityId: entry.facilityId,
            sourceId: log.sourceId,
            occurredAt: log.startedAt,
            result: entry.result,
            recordCount: entry.recordCount,
          },
        );
      }
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
    async listFacilityLogs(facilityIds, page) {
      const result = await pageBySortKey(db, {
        partitions: facilityIds.map(facilityIngestionPartition),
        forward: false,
        limit: page.limit,
        cursor: page.cursor,
      });
      return { items: result.items.map(facilityLogs.parse), nextCursor: result.nextCursor };
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
  const facilityLogs = mainAggregate(db, FacilityFederationLogSchema);

  /**
   * 項目を保存し、状態が変わったら、同じトランザクションで、状態ごとの件数を更新する。
   * 送信していない項目は、次の試行の日時の順に並ぶインデックスに載せる（同じ日時は、積んだ順）。
   * 期限が来た項目・先の項目を、範囲で読めて、溜まった件数に比例して読まない（ADR-0016 の D-06。#203）。
   */
  async function save(item: FederationItem): Promise<void> {
    const existing = await items.get(FEDERATION_ITEM, item.federationItemId);
    const indexKeys =
      item.status === 'SENT' || item.status === 'EXPIRED'
        ? {}
        : {
            gsi1pk: FEDERATION_DUE,
            gsi1sk: timedSortKey(
              item.nextAttemptAt,
              `${instantKey(item.enqueuedAt)}#${item.federationItemId}`,
            ),
          };
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

  /**
   * 送信していない項目を、次の試行の日時の順（範囲は、キーの値で指定）に読み、条件に合うものを、limit 件まで返す。
   * 条件は、キーの形が古い項目（積んだ日時のキー）を、読み飛ばすための確認。
   */
  async function pickUnsent(
    limit: number,
    range: { readonly lower?: string; readonly upper?: string },
    accepts: (item: FederationItem) => boolean,
  ): Promise<FederationItem[]> {
    const picked: FederationItem[] = [];
    for await (const stored of queryItems(db, {
      table,
      index: MAIN_INDEX_1,
      hashName: 'gsi1pk',
      hashValue: FEDERATION_DUE,
      sortName: 'gsi1sk',
      ...range,
      forward: true,
      pageSize: Math.min(1000, Math.max(limit, 1)),
    })) {
      const item = items.parse(stored);
      if (accepts(item)) {
        picked.push(item);
        if (picked.length >= limit) {
          break;
        }
      }
    }
    return picked;
  }

  return {
    enqueue: save,
    listDue(now, limit) {
      const nowMs = now.getTime();
      return pickUnsent(
        limit,
        { upper: upperBoundOf(instantKey(now.toISOString())) },
        (item) => Date.parse(item.nextAttemptAt) <= nowMs,
      );
    },
    listWaiting(now, limit) {
      const nowMs = now.getTime();
      // 現在の日時（ミリ秒）の項目は、含めない（`$` は `#` の次の文字）
      return pickUnsent(
        limit,
        { lower: upperBoundOf(instantKey(now.toISOString())) },
        (item) =>
          (item.status === 'HELD' || item.status === 'FAILED') &&
          Date.parse(item.nextAttemptAt) > nowMs,
      );
    },
    update: save,
    async addLog(entry) {
      await logs.put(FEDERATION_LOG, timedSortKey(entry.occurredAt, entry.logId), entry);
      for (const facility of entry.facilities ?? []) {
        await facilityLogs.put(
          facilityFederationPartition(facility.facilityId),
          timedSortKey(entry.occurredAt, `${entry.logId}#${facility.facilityId}`),
          {
            logId: entry.logId,
            facilityId: facility.facilityId,
            occurredAt: entry.occurredAt,
            result: entry.result,
            itemCount: facility.itemCount,
          },
        );
      }
    },
    async listFacilityLogs(facilityIds, page) {
      const result = await pageBySortKey(db, {
        partitions: facilityIds.map(facilityFederationPartition),
        forward: false,
        limit: page.limit,
        cursor: page.cursor,
      });
      return { items: result.items.map(facilityLogs.parse), nextCursor: result.nextCursor };
    },
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
        EXPIRED: counts.get(federationCounter('EXPIRED')) ?? 0,
      };
    },
  };
}
