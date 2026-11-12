/**
 * 取り込み（取り込み済みファイル・ログ）と、連携（キュー・ログ）の Repository（DynamoDB 実装）。
 *
 * - 取り込み済みファイル（Issue #201）: `SRC#{取り込み元}` / `FILE#{ファイル}`。ファイルごとに、最新の版（ハッシュ・結果）の 1 件を上書きする
 *   （1 つのファイルを随時更新する方式で、版ごとに増えないように。以前の、版ごとの `FILE#{ファイル}#{ハッシュ}`・`HASH#{ハッシュ}` は、読まない）
 * - 取り込み元の状態（設備が 1 つもない取り込み元の取得間隔の判定）: `SRC#{取り込み元}` / `STATE`。属性 `lastStarted`（ミリ秒）。新しい値のときだけ更新する
 * - 取り込みログ（設備に結びつかないもの。取り込み元単位）: `ILOG#{取り込み元}` / `{開始日時}#{ログID}`。取り込み元の一覧は、`ILOGSRC` に持つ
 * - 取り込みログ（設備ごと。Issue #201。新しいデータがあった実行・失敗だけ）: `ILOGE#{設備ID}` / `{開始日時}#{ログID}`。設備の一覧は、`EQINGEST` に持つ
 * - 設備ごとの取り込みの最終の実行（Issue #197・#201。取得間隔の判定・最終の実行の表示）: `EQINGEST` / `{設備ID}`。属性 `lastStarted`・`lastFinished`・
 *   `lastResult`・`lastSucceeded`・`lastData`（ミリ秒）。設備ごとに 1 件を、1 回の更新で上書きする（新しい開始日時のときだけ）。
 *   全設備を、1 回の Query で読む（取り込みのジョブは、毎分、判定する）
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
  EquipmentRunState,
  FederationRepository,
  IngestionRepository,
} from '../../application/ports/repositories.ts';
import { instantKey, timedSortKey, upperBoundOf } from './keys.ts';
import { counterAdd, mainAggregate, readCounters } from './main-table.ts';
import {
  getItem,
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
const EQUIPMENT_INGESTION = 'EQINGEST';
const INGESTION_RESULTS_STORED = ['SUCCESS', 'PARTIAL', 'FAILURE'] as const;

const sourcePartition = (sourceId: string): string => `SRC#${sourceId}`;
const logPartition = (sourceId: string): string => `ILOG#${sourceId}`;
const equipmentLogPartition = (equipmentId: string): string => `ILOGE#${equipmentId}`;
const facilityIngestionPartition = (facilityId: string): string => `ILOGF#${facilityId}`;
const facilityFederationPartition = (facilityId: string): string => `FLOGF#${facilityId}`;
const fileSortKey = (fileId: string): string => `FILE#${fileId}`;
const STATE = 'STATE';
const federationCounter = (status: FederationItem['status']): string => `FED#${status}`;

/** 結果の絞り込み: 成功は SUCCESS。失敗は、FAILURE と、一部成功（PARTIAL）。 */
function matchesResult(
  result: 'SUCCESS' | 'PARTIAL' | 'FAILURE',
  wanted: 'SUCCESS' | 'FAILURE' | undefined,
): boolean {
  if (wanted === undefined) {
    return true;
  }
  return wanted === 'SUCCESS' ? result === 'SUCCESS' : result !== 'SUCCESS';
}

function toDate(value: unknown): Date | null {
  return typeof value === 'number' ? new Date(value) : null;
}

export function createIngestionRepository(db: Database): IngestionRepository {
  const table = db.tables.main;
  const files = mainAggregate(db, IngestedFileRecordSchema);
  const logs = mainAggregate(db, IngestionLogSchema);
  const facilityLogs = mainAggregate(db, FacilityIngestionLogSchema);

  /** 設備に結びつかないログ（取り込み元ごと）と、設備ごとのログの、すべてのパーティション。 */
  async function allLogPartitions(sourceId: string | undefined): Promise<string[]> {
    const [sources, equipment] = await Promise.all([
      queryAll(db, table, INGESTION_SOURCES),
      queryAll(db, table, EQUIPMENT_INGESTION),
    ]);
    return [
      ...sources
        .map((item) => String(item.sk))
        .filter((candidate) => sourceId === undefined || candidate === sourceId)
        .map(logPartition),
      ...equipment.map((item) => equipmentLogPartition(String(item.sk))),
    ];
  }

  return {
    async findIngestedFile(sourceId, fileId, contentHash) {
      // 同じ識別子の、最新の版が、同じハッシュなら、取り込み済み（結果を問わない）
      const latest = await files.get(sourcePartition(sourceId), fileSortKey(fileId));
      return latest?.contentHash === contentHash ? latest : undefined;
    },
    async recordFile(record: IngestedFileRecord) {
      await files.put(sourcePartition(record.sourceId), fileSortKey(record.fileId), record);
    },
    async addLog(log) {
      // 設備ごとのログは、設備のパーティションに、設備に結びつかないログは、取り込み元のパーティションに持つ
      await logs.put(
        log.equipmentId === undefined
          ? logPartition(log.sourceId)
          : equipmentLogPartition(log.equipmentId),
        timedSortKey(log.startedAt, log.logId),
        log,
      );
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
      if (log.equipmentId === undefined) {
        await putItem(db, table, { pk: INGESTION_SOURCES, sk: log.sourceId });
      }
    },
    async listLogs(filter, page) {
      // 設備を指定すれば、その設備のパーティションと、取り込み元のパーティションだけを読む。指定がなければ、
      // 設備に結びつかないログ（取り込み元ごと）と、設備ごとのログを、併合する（設備の一覧は、設備ごとの最終の実行の項目）
      const partitions =
        filter.equipment === undefined
          ? await allLogPartitions(filter.sourceId)
          : [
              equipmentLogPartition(filter.equipment.equipmentId),
              ...(filter.equipment.sourceId === undefined
                ? []
                : [logPartition(filter.equipment.sourceId)]),
            ];
      const result = await pageBySortKey(db, {
        partitions,
        forward: false,
        limit: page.limit,
        cursor: page.cursor,
        lower: filter.from === undefined ? undefined : instantKey(filter.from.toISOString()),
        upper:
          filter.to === undefined ? undefined : upperBoundOf(instantKey(filter.to.toISOString())),
        accept: (item) => {
          const log = logs.parse(item);
          return (
            (filter.sourceId === undefined || log.sourceId === filter.sourceId) &&
            matchesResult(log.result, filter.result) &&
            // 設備のパーティションには、設備のログだけ、取り込み元のパーティションには、設備に結びつかないログだけがある
            (filter.equipment === undefined ||
              log.equipmentId === undefined ||
              log.equipmentId === filter.equipment.equipmentId)
          );
        },
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
    async listEquipmentRuns() {
      const states = new Map<string, EquipmentRunState>();
      for (const item of await queryAll(db, table, EQUIPMENT_INGESTION)) {
        const startedAt = toDate(item.lastStarted);
        const finishedAt = toDate(item.lastFinished);
        const result = INGESTION_RESULTS_STORED.find((candidate) => candidate === item.lastResult);
        if (startedAt !== null && finishedAt !== null && result !== undefined) {
          states.set(String(item.sk), {
            startedAt,
            finishedAt,
            result,
            lastSucceededAt: toDate(item.lastSucceeded),
            lastDataAt: toDate(item.lastData),
          });
        }
      }
      return states;
    },
    async recordEquipmentRuns(runs) {
      await Promise.all(
        runs.map((run) =>
          updateItemIf(db, table, {
            key: { pk: EQUIPMENT_INGESTION, sk: run.equipmentId },
            update: [
              'SET lastStarted = :s, lastFinished = :f, lastResult = :r',
              ...(run.result === 'SUCCESS' ? ['lastSucceeded = :f'] : []),
              ...(run.dataIngested ? ['lastData = :f'] : []),
            ].join(', '),
            // 新しい実行のときだけ、更新する（古い実行で戻さない）。まだ記録がなければ、作る
            condition: 'attribute_not_exists(lastStarted) OR lastStarted <= :s',
            values: {
              ':s': run.startedAt.getTime(),
              ':f': run.finishedAt.getTime(),
              ':r': run.result,
            },
          }),
        ),
      );
    },
    async lastStartedAt(sourceId) {
      const state = await getItem(db, table, { pk: sourcePartition(sourceId), sk: STATE });
      return toDate(state?.lastStarted);
    },
    async recordSourceStarted(sourceId, at) {
      await updateItemIf(db, table, {
        key: { pk: sourcePartition(sourceId), sk: STATE },
        update: 'SET #a = :v',
        condition: 'attribute_not_exists(#a) OR #a < :v',
        names: { '#a': 'lastStarted' },
        values: { ':v': at.getTime() },
      });
    },
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
