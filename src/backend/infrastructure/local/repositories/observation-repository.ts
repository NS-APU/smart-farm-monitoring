/**
 * 観測値の Repository（ローカル実装）。
 * 観測値は件数が多いため、設備ごとの索引と、計測日時の順の索引を持つ（評価・参照で全件を走査・並べ替えしない）。
 * 索引は、ファイルからの読み込み・全消去で作り直す（resetIndex）。
 */

import type { ObservationSortKey, SortDirection } from '@smart-farm/shared/constants/sorting';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import { compareIsoInstants } from '@smart-farm/shared/time';
import { observationKey, type Observation } from '@smart-farm/shared/schemas/observation';
import type {
  ObservationFilter,
  ObservationRepository,
} from '../../../application/ports/repositories.ts';
import type { Collection } from '../local-store.ts';
import { decodeCursor, encodeCursor, latestOf, paginatedSorted } from './collection-helpers.ts';

/** 計測日時の範囲の境界（ISO 8601）。行ごとに変換し直さないよう、検索の前に1回だけ作る。 */
interface ObservedBounds {
  readonly fromIso: string | undefined;
  readonly toIso: string | undefined;
}

function matchesObservation(
  observation: Observation,
  filter: ObservationFilter,
  bounds: ObservedBounds,
): boolean {
  if (!filter.includeDeleted && observation.isDeleted) {
    return false;
  }
  if (filter.equipmentIds !== undefined && !filter.equipmentIds.includes(observation.equipmentId)) {
    return false;
  }
  if (filter.category !== undefined && observation.category !== filter.category) {
    return false;
  }
  if (filter.itemKey !== undefined && observation.itemKey !== filter.itemKey) {
    return false;
  }
  if (filter.itemKeys !== undefined && !filter.itemKeys.includes(observation.itemKey)) {
    return false;
  }
  if (filter.source !== undefined && observation.source !== filter.source) {
    return false;
  }
  if (
    bounds.fromIso !== undefined &&
    compareIsoInstants(observation.observedAt, bounds.fromIso) < 0
  ) {
    return false;
  }
  if (bounds.toIso !== undefined && compareIsoInstants(observation.observedAt, bounds.toIso) > 0) {
    return false;
  }
  return filter.matches?.(observation) ?? true;
}

/** 文字列の照合（`localeCompare` と同じ順序）。比較のたびに照合の設定を作り直さないよう、1つを使い回す（V-086）。 */
const COLLATOR = new Intl.Collator();

/** 日時（ISO 8601）の文字列の比較。同じ長さなら、単純な比較で足りる（照合より大幅に速い）。違う長さ（ミリ秒の有無）は照合の順序。 */
function compareIso(left: string, right: string): number {
  if (left.length === right.length) {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return COLLATOR.compare(left, right);
}

function compareObservations(
  key: ObservationSortKey,
  direction: SortDirection,
): (left: Observation, right: Observation) => number {
  const sign = direction === 'asc' ? 1 : -1;
  const isTimestampKey = key === 'observedAt';
  return (left, right) => {
    let result: number;
    if (key === 'value') {
      const leftValue = typeof left.value === 'number' ? left.value : Number.NEGATIVE_INFINITY;
      const rightValue = typeof right.value === 'number' ? right.value : Number.NEGATIVE_INFINITY;
      result = leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
    } else {
      result = isTimestampKey
        ? compareIso(left[key], right[key])
        : COLLATOR.compare(left[key], right[key]);
    }
    // 同じ値のときは、計測日時 → 一意キーの順で並べ、ページ分割の結果を安定させる
    return (
      sign * result ||
      compareIso(right.observedAt, left.observedAt) ||
      COLLATOR.compare(observationKey(left), observationKey(right))
    );
  };
}

/** 新しい一意キーが、この件数以下なら、位置を二分探索して挿入する（これを超えたら、整列してから、全体を併合する）。 */
const INSERT_LIMIT = 5000;

/** 計測日時の順（同じ日時は一意キーの順）の比較。一覧の並べ替え（compareObservations）の昇順と同じ順序。 */
function compareByObservedAtThenKey(
  left: { readonly observedAt: string; readonly key: string },
  right: { readonly observedAt: string; readonly key: string },
): number {
  return compareIso(left.observedAt, right.observedAt) || COLLATOR.compare(left.key, right.key);
}

/** 計測日時の順の索引の1件（一意キーと、その計測日時）。観測値そのものは、コレクションから引く（上書きされても、位置は変わらない）。 */
interface TimeEntry {
  readonly key: string;
  readonly observedAt: string;
}

/** 索引の指定の位置の項目（範囲内の位置だけを渡す）。 */
function entryAt(entries: readonly TimeEntry[], position: number): TimeEntry {
  const entry = entries[position];
  if (entry === undefined) {
    throw new RangeError('計測日時の順の索引の範囲外です');
  }
  return entry;
}

/** 整列済みの配列の中で、指定した1件より後ろ（同じ順位のものの後ろ）の位置。 */
function upperBound(base: readonly TimeEntry[], entry: TimeEntry): number {
  let low = 0;
  let high = base.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareByObservedAtThenKey(entryAt(base, middle), entry) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * 整列済みの配列に、整列済みの少数の項目を加える。挿入の位置を二分探索で求め、区間ごとにコピーして、新しい配列にする
 * （全項目を比較して併合しない。1回の保存が数百〜数千件でも、索引の件数に比例した比較をしない）。
 */
function insertSorted(base: readonly TimeEntry[], added: readonly TimeEntry[]): TimeEntry[] {
  const parts: TimeEntry[][] = [];
  let previous = 0;
  for (const entry of added) {
    const position = upperBound(base, entry);
    if (position > previous) {
      parts.push(base.slice(previous, position));
      previous = position;
    }
    parts.push([entry]);
  }
  parts.push(base.slice(previous));
  return ([] as TimeEntry[]).concat(...parts);
}

/** 整列済みの2つの配列を、整列を保って1つにまとめる。 */
function mergeSorted(base: readonly TimeEntry[], added: readonly TimeEntry[]): TimeEntry[] {
  const merged: TimeEntry[] = [];
  let left = 0;
  let right = 0;
  while (left < base.length && right < added.length) {
    const baseEntry = entryAt(base, left);
    const addedEntry = entryAt(added, right);
    if (compareByObservedAtThenKey(addedEntry, baseEntry) < 0) {
      merged.push(addedEntry);
      right += 1;
    } else {
      merged.push(baseEntry);
      left += 1;
    }
  }
  while (left < base.length) {
    merged.push(entryAt(base, left));
    left += 1;
  }
  while (right < added.length) {
    merged.push(entryAt(added, right));
    right += 1;
  }
  return merged;
}

export interface LocalObservationRepository {
  readonly repository: ObservationRepository;
  /** 設備ごとの索引と、計測日時の順の索引を捨てる（次の参照で、全件から作り直す）。 */
  resetIndex(): void;
  /** 索引を、いま作る（読み込みの直後に呼び、最初の参照の応答を、索引の構築で遅くしない）。 */
  buildIndexes(): void;
}

export function createObservationRepository(
  observations: Collection<Observation>,
): LocalObservationRepository {
  // 設備 → （一意キー → 観測値）。評価・参照で、設備の観測値を、全件から探さず、直接たどる
  let index: Map<string, Map<string, Observation>> | undefined;
  // 計測日時の順の索引（一意キーと計測日時。昇順。計測日時が同じなら一意キーの順）。一覧の既定の並べ替え（計測日時）で、
  // 全件を並べ替えずに、先頭のページだけを取り出す。保存のたびに、新しい一意キーだけを整列を保って加える
  let timeIndex: TimeEntry[] | undefined;
  // 索引ができたあとに保存された、新しい一意キー（次の参照で、まとめて索引へ加える。保存のたびに、索引全体を作り直さない）
  let pendingTimeEntries: TimeEntry[] = [];
  // 最終の受信日時の計算結果（設備の集合ごと）。観測値を書き込んだら捨てる（読み取りのたびに、全件を走査しない。V-077）
  let latestCache = new Map<string, Date | null>();

  function addToIndex(
    target: Map<string, Map<string, Observation>>,
    observation: Observation,
    key: string = observationKey(observation),
  ): void {
    const entries = target.get(observation.equipmentId);
    if (entries === undefined) {
      target.set(observation.equipmentId, new Map([[key, observation]]));
    } else {
      entries.set(key, observation);
    }
  }

  function indexOfObservations(): Map<string, Map<string, Observation>> {
    if (index === undefined) {
      index = new Map();
      for (const observation of observations.values()) {
        addToIndex(index, observation);
      }
    }
    return index;
  }

  function observationsOf(equipmentIds: readonly EquipmentId[] | undefined): Observation[] {
    if (equipmentIds === undefined) {
      return observations.values();
    }
    const equipmentIndex = indexOfObservations();
    const found: Observation[] = [];
    for (const equipmentId of equipmentIds) {
      for (const observation of equipmentIndex.get(equipmentId)?.values() ?? []) {
        found.push(observation);
      }
    }
    return found;
  }

  /** 計測日時の順の索引（なければ、全件から作る。保存された新しい一意キーは、ここで、まとめて加える）。 */
  function timeIndexOf(): TimeEntry[] {
    if (timeIndex === undefined) {
      timeIndex = observations
        .values()
        .map((observation) => ({
          key: observationKey(observation),
          observedAt: observation.observedAt,
        }))
        .sort(compareByObservedAtThenKey);
      pendingTimeEntries = [];
    } else if (pendingTimeEntries.length > 0) {
      timeIndex = addToTimeIndex(timeIndex, pendingTimeEntries);
      pendingTimeEntries = [];
    }
    return timeIndex;
  }

  /** 新しい一意キーを、計測日時の順の索引へ加える（少数は挿入、多数は併合）。 */
  /** 新しい一意キーを、計測日時の順の索引へ加える（少数は挿入、多数は併合）。 */
  function addToTimeIndex(base: TimeEntry[], added: TimeEntry[]): TimeEntry[] {
    if (added.length === 0) {
      return base;
    }
    const sorted = added.sort(compareByObservedAtThenKey);
    return sorted.length > INSERT_LIMIT ? mergeSorted(base, sorted) : insertSorted(base, sorted);
  }

  /**
   * 計測日時の順の一覧（昇順・降順）。索引をたどり、条件に合う観測値を、必要な件数（次のページの有無を含む）だけ集める。
   * 降順でも、計測日時が同じ観測値は、一意キーの昇順（compareObservations と同じ順序）。
   */
  function queryByObservedAt(
    filter: ObservationFilter,
    bounds: ObservedBounds,
    page: { readonly limit: number; readonly cursor?: string | undefined },
    direction: SortDirection,
  ): Promise<{ items: Observation[]; nextCursor: string | null }> {
    try {
      const offset = decodeCursor(page.cursor);
      const end = offset + page.limit;
      const entries = timeIndexOf();
      const matched: Observation[] = [];
      const collect = (entry: TimeEntry): void => {
        const observation = observations.get(entry.key);
        if (observation !== undefined && matchesObservation(observation, filter, bounds)) {
          matched.push(observation);
        }
      };
      if (direction === 'asc') {
        for (let position = 0; position < entries.length && matched.length <= end; position += 1) {
          collect(entryAt(entries, position));
        }
      } else {
        let last = entries.length - 1;
        while (last >= 0 && matched.length <= end) {
          let first = last;
          const observedAt = entryAt(entries, last).observedAt;
          while (first > 0 && entryAt(entries, first - 1).observedAt === observedAt) {
            first -= 1;
          }
          for (let position = first; position <= last; position += 1) {
            collect(entryAt(entries, position));
          }
          last = first - 1;
        }
      }
      return Promise.resolve({
        items: matched.slice(offset, end),
        nextCursor: matched.length > end ? encodeCursor(end) : null,
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  const repository: ObservationRepository = {
    saveMany(items) {
      latestCache = new Map();
      const equipmentIndex = indexOfObservations();
      for (const item of items) {
        const key = observationKey(item);
        // 計測日時の順の索引は、新しい一意キーだけを覚えておく（索引がまだなければ、参照のときに、全件から作る）
        if (timeIndex !== undefined && observations.get(key) === undefined) {
          pendingTimeEntries.push({ key, observedAt: item.observedAt });
        }
        observations.put(item);
        addToIndex(equipmentIndex, item, key);
      }
      return Promise.resolve();
    },
    findForEvaluation(equipmentIds, from, to) {
      const fromIso = from.toISOString();
      const toIso = to.toISOString();
      return Promise.resolve(
        observationsOf(equipmentIds).filter(
          (item) =>
            !item.isDeleted &&
            compareIsoInstants(item.observedAt, fromIso) >= 0 &&
            compareIsoInstants(item.observedAt, toIso) <= 0,
        ),
      );
    },
    query(filter, page, sort = { key: 'observedAt', direction: 'desc' }) {
      const bounds = { fromIso: filter.from?.toISOString(), toIso: filter.to?.toISOString() };
      if (sort.key === 'observedAt') {
        return queryByObservedAt(filter, bounds, page, sort.direction);
      }
      const matched = observationsOf(filter.equipmentIds).filter((item) =>
        matchesObservation(item, filter, bounds),
      );
      return paginatedSorted(matched, compareObservations(sort.key, sort.direction), page);
    },
    findByKey(equipmentId, itemKey, observedAt, source) {
      return Promise.resolve(
        observations.get(observationKey({ equipmentId, itemKey, observedAt, source })),
      );
    },
    latestReceivedAt(equipmentIds, options = {}) {
      const cacheKey = `${options.autoImportOnly === true ? 'auto' : 'all'}|${equipmentIds === undefined ? '*' : equipmentIds.join(',')}`;
      const cached = latestCache.get(cacheKey);
      if (cached !== undefined) {
        return Promise.resolve(cached);
      }
      // 自動取り込みのみ（手動入力・削除済みを除く）を指定すると、ロボット・センサーからのデータの新しさを返す
      const targets =
        options.autoImportOnly === true
          ? observationsOf(equipmentIds).filter(
              (item) => item.source === 'AUTO_IMPORT' && !item.isDeleted,
            )
          : observationsOf(equipmentIds);
      const latest = latestOf(targets.map((item) => item.receivedAt));
      latestCache.set(cacheKey, latest);
      return Promise.resolve(latest);
    },
  };

  return {
    repository,
    buildIndexes() {
      indexOfObservations();
      timeIndexOf();
    },
    resetIndex() {
      index = undefined;
      timeIndex = undefined;
      pendingTimeEntries = [];
      latestCache = new Map();
    },
  };
}
