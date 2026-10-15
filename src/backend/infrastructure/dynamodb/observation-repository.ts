/**
 * 観測値の Repository（DynamoDB 実装。ADR-0007）。
 *
 * - `Observations` テーブル: パーティション = 設備 × 項目、ソートキー = 計測日時（ミリ秒つきの UTC）+ 取得元（A・M）
 * - 設備ごとの項目の一覧（`OBSREG`）と、最終の受信日時（`OBSSTAT`）は、`Main` に持つ。書き込みのときに更新する
 * - 計測日時の順の一覧: 対象のパーティションを、先頭から必要な分だけ読み、併合する。カーソルは、最後の一意キー
 * - 値・カテゴリの順の一覧（と、キーワード検索）: 条件に合う観測値を読み、アプリ側で並べ替える。上限（READ_LIMIT）を超えたら、
 *   期間を絞り込むよう求める
 * - 観測値は、結果整合で読む（容量が半分）。書き込みの直後に、強い整合で読む必要がある `findByKey` は、強い整合
 */

import type { Category } from '@smart-farm/shared/constants/items';
import { findItemDefinition } from '@smart-farm/shared/constants/items';
import type { SortDirection } from '@smart-farm/shared/constants/sorting';
import { AppError } from '@smart-farm/shared/errors';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import type {
  ObservationFilter,
  ObservationRepository,
} from '../../application/ports/repositories.ts';
import {
  compareByObservedAt,
  compareObservations,
  matchesObservation,
  type ObservationOrderKey,
  type ObservedBounds,
} from '../common/observation-rules.ts';
import { decodeCursor, invalidCursorError, paginatedSorted } from '../common/pagination.ts';
import { decodeKeyCursor, encodeKeyCursor } from './key-cursor.ts';
import { instantKey, timeOfSortKey, upperBoundOf } from './keys.ts';
import { mergeStreams } from './merge.ts';
import {
  fromObservationItem,
  normalizedInstant,
  observationPartitionKey,
  observationSortKey,
  toObservationItem,
} from './observation-mapping.ts';
import {
  batchGetItems,
  batchWriteItems,
  getItem,
  mapConcurrent,
  queryAll,
  queryItems,
  queryPages,
  updateItem,
  updateItemIf,
  type Database,
  type Item,
  type QueryOptions,
} from './operations.ts';
import { OBSERVATIONS_MANUAL_INDEX } from './table-schema.ts';

/** 設備ごとの、項目の一覧（レジストリ）と、最終の受信日時（Main テーブルのパーティション）。 */
const REGISTRY = 'OBSREG';
const RECEIVED_STATS = 'OBSSTAT';

/** 1 回の操作で読む観測値の上限。超えたら、期間を絞り込むよう求める（Lambda のメモリ・読み取りの費用を守る）。 */
export const READ_LIMIT = 50_000;
/** 並列に読むパーティションの数。 */
const PARTITION_CONCURRENCY = 12;
const PAGE_SIZE_MAX = 1000;

/** 読むパーティション（設備 × 項目）、または、手動入力の GSI（設備ごと）。 */
type Target =
  | { readonly kind: 'partition'; readonly key: string }
  | { readonly kind: 'manual'; readonly equipmentId: string };

interface RegistryEntry {
  readonly equipmentId: string;
  readonly itemKeys: readonly string[];
}

function tooManyError(): AppError {
  return new AppError(
    'VALIDATION_ERROR',
    '条件に合う観測値が多すぎます。期間を絞り込んでください',
    {
      fields: [{ name: 'from', message: '期間を絞り込んでください' }],
    },
  );
}

/** 読んだ件数の上限を守る（件数を数え、超えたら入力不正にする）。 */
function createReadBudget(limit: number): () => void {
  let read = 0;
  return () => {
    read += 1;
    if (read > limit) {
      throw tooManyError();
    }
  };
}

function maxOf(left: string | undefined, right: string): string {
  return left === undefined || left < right ? right : left;
}

/** 項目の絞り込み（項目・複数の項目・カテゴリ）。カテゴリは、項目カタログから導く（カタログにない項目は、残す）。 */
function itemKeyPredicate(filter: ObservationFilter): (itemKey: string) => boolean {
  const category: Category | undefined = filter.category;
  return (itemKey) => {
    if (filter.itemKey !== undefined && itemKey !== filter.itemKey) {
      return false;
    }
    if (filter.itemKeys !== undefined && !filter.itemKeys.includes(itemKey)) {
      return false;
    }
    const catalogCategory = findItemDefinition(itemKey)?.category;
    return category === undefined || catalogCategory === undefined || catalogCategory === category;
  };
}

function boundsOf(filter: ObservationFilter): ObservedBounds {
  return { fromIso: filter.from?.toISOString(), toIso: filter.to?.toISOString() };
}

/** 計測日時の範囲を、ソートキーの範囲（両端を含む）にする。 */
function sortKeyRangeOf(filter: ObservationFilter): {
  lower: string | undefined;
  upper: string | undefined;
} {
  return {
    lower: filter.from === undefined ? undefined : instantKey(filter.from.toISOString()),
    upper: filter.to === undefined ? undefined : upperBoundOf(instantKey(filter.to.toISOString())),
  };
}

/** 一覧のカーソル: 最後に返した観測値の一意キー（設備・項目・計測日時・取得元）。 */
function decodeObservationCursor(cursor: string | undefined): ObservationOrderKey | undefined {
  const parts = decodeKeyCursor(cursor, 4);
  if (parts === undefined) {
    return undefined;
  }
  const [equipmentId, itemKey, observedAt, source] = parts;
  if (
    equipmentId === undefined ||
    itemKey === undefined ||
    observedAt === undefined ||
    (source !== 'AUTO_IMPORT' && source !== 'MANUAL') ||
    normalizedInstant(observedAt) === undefined
  ) {
    throw invalidCursorError();
  }
  return { equipmentId: equipmentId as Observation['equipmentId'], itemKey, observedAt, source };
}

export function createObservationRepository(
  db: Database,
  options: { readonly readLimit?: number } = {},
): ObservationRepository {
  const readLimit = options.readLimit ?? READ_LIMIT;
  const observationsTable = db.tables.observations;
  const mainTable = db.tables.main;

  /** 設備ごとの項目の一覧。設備を指定しなければ、すべての設備。 */
  async function registryOf(equipmentIds: readonly string[] | undefined): Promise<RegistryEntry[]> {
    const items =
      equipmentIds === undefined
        ? await queryAll(db, mainTable, REGISTRY)
        : await batchGetItems(
            db,
            mainTable,
            [...new Set(equipmentIds)].map((equipmentId) => ({ pk: REGISTRY, sk: equipmentId })),
          );
    return items.map((item) => ({
      equipmentId: String(item.sk),
      itemKeys: [...((item.ik as Set<string> | undefined) ?? [])],
    }));
  }

  function targetsOf(entries: readonly RegistryEntry[], filter: ObservationFilter): Target[] {
    if (filter.source === 'MANUAL') {
      // 手動入力は、疎な GSI から読む（自動取り込みのパーティションを読まない）
      return entries.map((entry) => ({ kind: 'manual', equipmentId: entry.equipmentId }));
    }
    const wanted = itemKeyPredicate(filter);
    return entries.flatMap((entry) =>
      entry.itemKeys.filter(wanted).map((itemKey): Target => ({
        kind: 'partition',
        key: observationPartitionKey(entry.equipmentId, itemKey),
      })),
    );
  }

  function queryOptionsOf(
    target: Target,
    range: { readonly lower: string | undefined; readonly upper: string | undefined },
    forward: boolean,
    pageSize: number,
  ): QueryOptions {
    return target.kind === 'partition'
      ? {
          table: observationsTable,
          hashName: 'pk',
          hashValue: target.key,
          sortName: 'sk',
          ...range,
          forward,
          pageSize,
        }
      : {
          table: observationsTable,
          index: OBSERVATIONS_MANUAL_INDEX,
          hashName: 'g2',
          hashValue: target.equipmentId,
          sortName: 'g2s',
          ...range,
          forward,
          pageSize,
        };
  }

  /**
   * 1 つのパーティションの観測値を、計測日時の順（同じ計測日時は一意キーの順）に返す。
   * 同じ計測日時のものは、まとめて並べ替える（DynamoDB の順序は、降順のとき、一意キーの順にならないため）。
   */
  async function* observationStream(
    target: Target,
    options: {
      readonly range: { readonly lower: string | undefined; readonly upper: string | undefined };
      readonly direction: SortDirection;
      readonly pageSize: number;
      readonly accept: (observation: Observation) => boolean;
      readonly countRead: () => void;
    },
  ): AsyncGenerator<Observation, void, undefined> {
    const compare = compareByObservedAt(options.direction);
    const sortName = target.kind === 'partition' ? 'sk' : 'g2s';
    let group: Observation[] = [];
    let groupTime: string | undefined;
    const settle = (): Observation[] => group.sort(compare).filter(options.accept);
    for await (const item of queryItems(
      db,
      queryOptionsOf(target, options.range, options.direction === 'asc', options.pageSize),
    )) {
      options.countRead();
      const time = timeOfSortKey(String(item[sortName]));
      if (groupTime !== undefined && time !== groupTime) {
        const settled = settle();
        group = [];
        yield* settled;
      }
      groupTime = time;
      group.push(fromObservationItem(item));
    }
    yield* settle();
  }

  async function collect(
    stream: AsyncGenerator<Observation, void, undefined>,
  ): Promise<Observation[]> {
    const collected: Observation[] = [];
    for await (const observation of stream) {
      collected.push(observation);
    }
    return collected;
  }

  async function queryByObservedAt(
    filter: ObservationFilter,
    page: { readonly limit: number; readonly cursor?: string | undefined },
    direction: SortDirection,
  ): Promise<{ items: Observation[]; nextCursor: string | null }> {
    const after = decodeObservationCursor(page.cursor);
    const compare = compareByObservedAt(direction);
    const bounds = boundsOf(filter);
    let { lower, upper } = sortKeyRangeOf(filter);
    if (after !== undefined) {
      // カーソルの計測日時より前（降順なら後）は、読まない
      const cursorTime = instantKey(after.observedAt);
      if (direction === 'asc') {
        lower = maxOf(lower, cursorTime);
      } else if (upper === undefined || upperBoundOf(cursorTime) < upper) {
        upper = upperBoundOf(cursorTime);
      }
    }
    const countRead = createReadBudget(readLimit);
    const streams = targetsOf(await registryOf(filter.equipmentIds), filter).map((target) =>
      observationStream(target, {
        range: { lower, upper },
        direction,
        pageSize: Math.min(PAGE_SIZE_MAX, Math.max(page.limit + 1, 25)),
        accept: (observation) =>
          matchesObservation(observation, filter, bounds) &&
          (after === undefined || compare(observation, after) > 0),
        countRead,
      }),
    );
    const merged = await mergeStreams(streams, compare, page.limit + 1);
    const items = merged.slice(0, page.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        merged.length > page.limit && last !== undefined
          ? encodeKeyCursor([last.equipmentId, last.itemKey, last.observedAt, last.source])
          : null,
    };
  }

  /** 設備ごとの、受信日時の最大（Main テーブル）を、新しい値のときだけ更新する。 */
  async function raiseReceived(
    equipmentId: string,
    attribute: string,
    time: number,
  ): Promise<void> {
    await updateItemIf(db, mainTable, {
      key: { pk: RECEIVED_STATS, sk: equipmentId },
      update: 'SET #a = :v',
      condition: 'attribute_not_exists(#a) OR #a < :v',
      names: { '#a': attribute },
      values: { ':v': time },
    });
  }

  return {
    async saveMany(observations) {
      if (observations.length === 0) {
        return;
      }
      // 一意キーが同じものは、あとのものを残す（1 回の BatchWriteItem に、同じキーを入れられない）
      const writes = new Map<string, Item>();
      const itemKeys = new Map<string, Set<string>>();
      const received = new Map<string, { all: number; auto: number | undefined }>();
      for (const observation of observations) {
        const item = toObservationItem(observation);
        writes.set(`${String(item.pk)}|${String(item.sk)}`, item);
        const equipment = itemKeys.get(observation.equipmentId) ?? new Set<string>();
        equipment.add(observation.itemKey);
        itemKeys.set(observation.equipmentId, equipment);
        const time = Number(item.r);
        const current = received.get(observation.equipmentId) ?? { all: time, auto: undefined };
        received.set(observation.equipmentId, {
          all: Math.max(current.all, time),
          auto:
            observation.source === 'AUTO_IMPORT' && !observation.isDeleted
              ? Math.max(current.auto ?? time, time)
              : current.auto,
        });
      }
      // 読む側が使う一覧・最終の受信日時を、観測値より先に更新する（途中で失敗しても、読めない観測値が残らない）
      await Promise.all([
        ...[...itemKeys].map(([equipmentId, keys]) =>
          updateItem(db, mainTable, {
            key: { pk: REGISTRY, sk: equipmentId },
            update: 'ADD #ik :keys',
            names: { '#ik': 'ik' },
            values: { ':keys': keys },
          }),
        ),
        ...[...received].flatMap(([equipmentId, time]) => [
          raiseReceived(equipmentId, 'all', time.all),
          ...(time.auto === undefined ? [] : [raiseReceived(equipmentId, 'auto', time.auto)]),
        ]),
      ]);
      await batchWriteItems(
        db,
        observationsTable,
        [...writes.values()].map((put) => ({ put })),
      );
    },
    async findForEvaluation(equipmentIds, from, to) {
      const range = {
        lower: instantKey(from.toISOString()),
        upper: upperBoundOf(instantKey(to.toISOString())),
      };
      const partitions = (await registryOf(equipmentIds)).flatMap((entry) =>
        entry.itemKeys.map((itemKey) => observationPartitionKey(entry.equipmentId, itemKey)),
      );
      const countRead = createReadBudget(Number.POSITIVE_INFINITY);
      const found = await mapConcurrent(partitions, PARTITION_CONCURRENCY, async (key) => {
        const observations: Observation[] = [];
        for await (const items of queryPages(
          db,
          queryOptionsOf({ kind: 'partition', key }, range, true, PAGE_SIZE_MAX),
        )) {
          for (const item of items) {
            countRead();
            const observation = fromObservationItem(item);
            if (!observation.isDeleted) {
              observations.push(observation);
            }
          }
        }
        return observations;
      });
      return found.flat();
    },
    async query(filter, page, sort = { key: 'observedAt', direction: 'desc' }) {
      if (sort.key === 'observedAt') {
        return queryByObservedAt(filter, page, sort.direction);
      }
      decodeCursor(page.cursor);
      const bounds = boundsOf(filter);
      const range = sortKeyRangeOf(filter);
      const countRead = createReadBudget(readLimit);
      const targets = targetsOf(await registryOf(filter.equipmentIds), filter);
      const matched = await mapConcurrent(targets, PARTITION_CONCURRENCY, (target) =>
        collect(
          observationStream(target, {
            range,
            direction: 'asc',
            pageSize: PAGE_SIZE_MAX,
            accept: (observation) => matchesObservation(observation, filter, bounds),
            countRead,
          }),
        ),
      );
      return paginatedSorted(matched.flat(), compareObservations(sort.key, sort.direction), page);
    },
    async findByKey(equipmentId, itemKey, observedAt, source) {
      const instant = normalizedInstant(observedAt);
      if (instant === undefined) {
        return undefined;
      }
      const item = await getItem(db, observationsTable, {
        pk: observationPartitionKey(equipmentId, itemKey),
        sk: observationSortKey(instant, source),
      });
      return item === undefined ? undefined : fromObservationItem(item);
    },
    async latestReceivedAt(equipmentIds, options = {}) {
      if (equipmentIds?.length === 0) {
        return null;
      }
      const items =
        equipmentIds === undefined
          ? await queryAll(db, mainTable, RECEIVED_STATS)
          : await batchGetItems(
              db,
              mainTable,
              [...new Set(equipmentIds)].map((equipmentId) => ({
                pk: RECEIVED_STATS,
                sk: equipmentId,
              })),
            );
      const attribute = options.autoImportOnly === true ? 'auto' : 'all';
      const times = items.flatMap((item) =>
        typeof item[attribute] === 'number' ? [item[attribute]] : [],
      );
      return times.length === 0 ? null : new Date(Math.max(...times));
    },
  };
}
