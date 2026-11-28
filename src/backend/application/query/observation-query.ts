/**
 * 参照（Query）: 観測値の一覧（FR-6.4 元データ、FR-6.8 取り込み済みデータ。UC-02・UC-20）。
 * 設備（ハウスは配下のロボット・センサーを含む）、観点（その観点の元データの項目）、カテゴリ・項目・取得元・期間で絞り込み、
 * キーワード（項目・カテゴリ・設備・取得元・状態の表示名、値）で検索する。並べ替え・ページ分割はサーバー側で行う。
 * 計測単位の一覧（listMeasurements。Issue #363）は、1 回の計測（設備・計測日時・取得元）の項目をまとめて返す（日時順だけ）。
 * `includeUsage` のときは、合計（累積）の項目の手動入力の行に、「評価に使われるか」（`usage`）を付ける（SC-09-4。D-26。`observation-usage.ts`）。
 */

import { AppError } from '@smart-farm/shared/errors';
import {
  CATEGORY_LABELS,
  ITEM_CATALOG,
  findItemDefinition,
  type Category,
} from '@smart-farm/shared/constants/items';
import {
  OBSERVATION_QUALITY_LABELS,
  OBSERVATION_SOURCE_LABELS,
} from '@smart-farm/shared/constants/observation-labels';
import type { ObservationSortKey, SortDirection } from '@smart-farm/shared/constants/sorting';
import type { ObservationSource } from '@smart-farm/shared/constants/status';
import { findViewpointMeta } from '@smart-farm/shared/constants/viewpoints';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type {
  Measurement,
  MeasurementListResponse,
  Observation,
  ObservationListResponse,
  ObservationRow,
} from '@smart-farm/shared/schemas/observation';
import { compareIsoInstants } from '@smart-farm/shared/time';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { getViewpointDefinition } from '../../domain/evaluation/viewpoints/registry.ts';
import { viewpointSourceItemKeys } from '../../domain/evaluation/viewpoints/source-items.ts';
import { ALL_EQUIPMENT, canViewEquipment, type EquipmentScope } from '../access/facility-scope.ts';
import { EQUIPMENT_NOT_FOUND_MESSAGE } from '../equipment/require-active-equipment.ts';
import { resolveEvaluationScope } from '../evaluation/scope.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { Repositories } from '../ports/repositories.ts';
import { judgeObservationUsage } from './observation-usage.ts';

export interface ObservationListParams {
  readonly equipmentId?: EquipmentId | undefined;
  /** 閲覧範囲（省略は全設備。Issue #330）。範囲外の設備の指定は、存在しないもの（NOT_FOUND）。指定しなければ、範囲内の設備だけ。 */
  readonly scope?: EquipmentScope | undefined;
  readonly viewpointId?: string | undefined;
  readonly category?: Category | undefined;
  readonly itemKey?: string | undefined;
  readonly source?: ObservationSource | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly keyword?: string | undefined;
  /** true なら、有効でない観測値（欠損・遅延・不正）だけ（SC-09-3）。 */
  readonly problemOnly?: boolean | undefined;
  readonly sort: ObservationSortKey;
  readonly direction: SortDirection;
  readonly limit: number;
  readonly cursor?: string | undefined;
  /** true なら、合計の項目の手動入力の行に、「評価に使われるか」（`usage`）を付ける（SC-09-4）。 */
  readonly includeUsage?: boolean | undefined;
}

/** 計測単位の一覧の条件（観点・項目の絞り込みと、並べ替えの指定はない。日時順だけ）。 */
export interface MeasurementListParams {
  readonly equipmentId?: EquipmentId | undefined;
  readonly scope?: EquipmentScope | undefined;
  readonly category?: Category | undefined;
  readonly source?: ObservationSource | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly keyword?: string | undefined;
  /** true なら、有効でない項目（欠損・遅延・不正）を 1 つでも含む計測だけ（SC-09-3。計測の全項目を示す）。 */
  readonly problemOnly?: boolean | undefined;
  readonly direction: SortDirection;
  /** 1 ページの計測の数の目安（同じ日時の計測は、まとめて返すため、これを超えることがある）。 */
  readonly limit: number;
  /** 前のページの最後の計測の日時（ISO 8601）。 */
  readonly cursor?: string | undefined;
  /** true なら、合計の項目の手動入力の行に、「評価に使われるか」（`usage`）を付ける（SC-09-4）。 */
  readonly includeUsage?: boolean | undefined;
}

export interface ObservationQuery {
  list(params: ObservationListParams): Promise<ObservationListResponse>;
  listMeasurements(params: MeasurementListParams): Promise<MeasurementListResponse>;
}

export interface ObservationQueryDeps {
  readonly repositories: Pick<Repositories, 'equipment' | 'observations' | 'statusCodes'>;
  /** 「評価に使われるか」の評価時刻（現在）。 */
  readonly clock: ClockPort;
}

export interface ObservationNames {
  readonly equipment: ReadonlyMap<string, string>;
  readonly statusCodes: ReadonlyMap<string, string>;
}

/** キーワードに一致するか（大文字・小文字を区別しない部分一致）。 */
export function observationMatchesKeyword(
  observation: Observation,
  keyword: string,
  names: ObservationNames,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  const value = observation.value === null ? '' : String(observation.value);
  const haystacks = [
    observation.itemKey,
    findItemDefinition(observation.itemKey)?.label ?? '',
    CATEGORY_LABELS[observation.category],
    names.equipment.get(observation.equipmentId) ?? '',
    OBSERVATION_SOURCE_LABELS[observation.source],
    OBSERVATION_QUALITY_LABELS[observation.quality],
    value,
    names.statusCodes.get(value) ?? '',
  ];
  return haystacks.some((text) => text.toLowerCase().includes(needle));
}

/**
 * キーワードの判定関数を作る。観測値ごとに変わらない部分（項目・カテゴリ・設備・取得元・状態の表示名）は、
 * 項目・設備・取得元・状態の組ごとに、小文字にした文字列を1度だけ作って使い回す（観測値ごとに配列・文字列を作り直さない。V-189）。
 * 判定の結果は、observationMatchesKeyword と同じ。
 */
export function createKeywordMatcher(
  keyword: string,
  names: ObservationNames,
): (observation: Observation) => boolean {
  const needle = keyword.trim().toLowerCase();
  if (needle === '') {
    return () => true;
  }
  // 項目 → 設備 → 取得元 → 品質 → カテゴリ の順の木（観測値ごとに、キーの文字列を作らない）
  interface MatchNode {
    readonly children: Map<string, MatchNode>;
    matched?: boolean;
  }
  const root: MatchNode = { children: new Map() };
  const staticMatchOf = (observation: Observation): boolean => {
    let node = root;
    for (const part of [
      observation.itemKey,
      observation.equipmentId,
      observation.source,
      observation.quality,
      observation.category,
    ]) {
      let child = node.children.get(part);
      if (child === undefined) {
        child = { children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.matched ??= [
      observation.itemKey,
      findItemDefinition(observation.itemKey)?.label ?? '',
      CATEGORY_LABELS[observation.category],
      names.equipment.get(observation.equipmentId) ?? '',
      OBSERVATION_SOURCE_LABELS[observation.source],
      OBSERVATION_QUALITY_LABELS[observation.quality],
    ].some((text) => text.toLowerCase().includes(needle));
    return node.matched;
  };
  return (observation) => {
    if (staticMatchOf(observation)) {
      return true;
    }
    const value = observation.value === null ? '' : String(observation.value);
    return (
      value.toLowerCase().includes(needle) ||
      (names.statusCodes.get(value) ?? '').toLowerCase().includes(needle)
    );
  };
}

/** 1 回の計測の中の項目の並び（項目の定義の順。定義にない項目は、最後に、項目名の順）。 */
const ITEM_ORDER: ReadonlyMap<string, number> = new Map(
  ITEM_CATALOG.map((item, index) => [item.itemKey, index]),
);

function compareItems(left: Observation, right: Observation): number {
  const leftOrder = ITEM_ORDER.get(left.itemKey) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = ITEM_ORDER.get(right.itemKey) ?? Number.MAX_SAFE_INTEGER;
  return leftOrder === rightOrder
    ? left.itemKey.localeCompare(right.itemKey)
    : leftOrder - rightOrder;
}

/** 1 回の計測の識別（設備・取得元・手動入力の 1 回の入力）。計測日時は、同じ日時の並びの中で束ねる。 */
function measurementKey(observation: Observation): string {
  return `${observation.equipmentId}|${observation.source}|${observation.manualEntryId ?? ''}`;
}

/** 同じ日時の観測値の並び（日時の枠）。 */
interface TimeSlot {
  readonly observedAt: string;
  readonly rows: Observation[];
}

/** 日時順に並んだ観測値を、同じ日時ごとの並び（日時の枠）にする。 */
function toTimeSlots(rows: readonly Observation[]): TimeSlot[] {
  const slots: TimeSlot[] = [];
  for (const row of rows) {
    const slot = slots.at(-1);
    if (slot !== undefined && compareIsoInstants(slot.observedAt, row.observedAt) === 0) {
      slot.rows.push(row);
    } else {
      slots.push({ observedAt: row.observedAt, rows: [row] });
    }
  }
  return slots;
}

/** 日時の枠を、1 回の計測ごとにまとめる。 */
function toMeasurements(slot: TimeSlot): Measurement[] {
  const groups = new Map<string, { readonly first: Observation; readonly rows: Observation[] }>();
  for (const row of slot.rows) {
    const key = measurementKey(row);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { first: row, rows: [row] });
    } else {
      group.rows.push(row);
    }
  }
  return [...groups.values()].map(({ first, rows }) =>
    omitUndefined({
      equipmentId: first.equipmentId,
      observedAt: first.observedAt,
      source: first.source,
      manualEntryId: first.manualEntryId,
      receivedAt: rows.reduce(
        (latest, item) =>
          compareIsoInstants(item.receivedAt, latest) > 0 ? item.receivedAt : latest,
        first.receivedAt,
      ),
      items: [...rows].sort(compareItems),
    }),
  );
}

/** 1 回の計測の読み取りの 1 回の大きさ（計測の数の目安 × 項目の数の目安）。 */
const ITEMS_PER_MEASUREMENT_HINT = 12;
const MAX_CHUNK = 500;

export function createObservationQuery(deps: ObservationQueryDeps): ObservationQuery {
  const { repositories, clock } = deps;

  /** 行に、「評価に使われるか」（合計の項目の手動入力だけ）を付ける。付けないときは、読んだ行のまま。 */
  async function withUsage(rows: readonly Observation[]): Promise<ObservationRow[]> {
    const usages = await judgeObservationUsage(repositories.observations, rows, clock.now());
    return rows.map((row) => {
      const usage = usages.get(row);
      return usage === undefined ? row : { ...row, usage };
    });
  }

  /** 閲覧範囲・設備の指定から、対象の設備の絞り込みを決める。なければ（範囲なし）、何も返さない旨を示す。 */
  async function resolveEquipmentIds(
    params: Pick<ObservationListParams, 'equipmentId' | 'scope'>,
  ): Promise<
    | { readonly empty: true }
    | {
        readonly empty: false;
        readonly equipmentIds: readonly EquipmentId[] | undefined;
        readonly allEquipment: Awaited<ReturnType<Repositories['equipment']['list']>>;
      }
  > {
    const scope = params.scope ?? ALL_EQUIPMENT;
    if (params.equipmentId !== undefined && !canViewEquipment(scope, params.equipmentId)) {
      throw new AppError('NOT_FOUND', EQUIPMENT_NOT_FOUND_MESSAGE);
    }
    if (scope.kind === 'limited' && scope.equipmentIds.size === 0) {
      return { empty: true };
    }
    const allEquipment = await repositories.equipment.list();
    // 範囲の指定がなければ、削除中・削除済みの設備を除いた、登録中の設備にする（設備のデータは、削除ジョブが消すまで残るため。D-28）
    let equipmentIds: readonly EquipmentId[] | undefined =
      scope.kind === 'limited'
        ? [...scope.equipmentIds]
        : allEquipment.map((equipment) => equipment.equipmentId);
    if (params.equipmentId !== undefined) {
      const equipment = allEquipment.find((item) => item.equipmentId === params.equipmentId);
      if (equipment === undefined) {
        throw new AppError('NOT_FOUND', EQUIPMENT_NOT_FOUND_MESSAGE);
      }
      equipmentIds = resolveEvaluationScope(equipment, allEquipment).equipmentIds;
    }
    return { empty: false, equipmentIds, allEquipment };
  }

  /**
   * 絞り込み（キーワード・カテゴリ・「問題あり」）で選ばれた計測は、一致した項目だけでなく、その計測の全項目を示す
   * （計測の中の一部の項目だけが見えると、計測の全体が分からないため）。絞り込みがなければ、読んだ内容が、全項目。
   */
  async function completeMeasurements(
    measurements: readonly Measurement[],
    filtered: boolean,
  ): Promise<Measurement[]> {
    if (!filtered) {
      return [...measurements];
    }
    return Promise.all(
      measurements.map(async (measurement) => {
        const at = new Date(measurement.observedAt);
        const page = await repositories.observations.query(
          { equipmentIds: [measurement.equipmentId], source: measurement.source, from: at, to: at },
          { limit: 200 },
          { key: 'observedAt', direction: 'asc' },
        );
        const items = page.items
          .filter((item) => item.manualEntryId === measurement.manualEntryId)
          .sort(compareItems);
        return items.length === 0 ? measurement : { ...measurement, items };
      }),
    );
  }

  /** 計測の項目に、「評価に使われるか」を付ける（全計測の項目を、まとめて判定する。読み取りは、設備・項目の組ごとに 1 回）。 */
  async function withMeasurementUsage(
    measurements: readonly Measurement[],
  ): Promise<Measurement[]> {
    const rows = await withUsage(measurements.flatMap(({ items }) => items));
    let index = 0;
    return measurements.map((measurement) => {
      const items = rows.slice(index, index + measurement.items.length);
      index += measurement.items.length;
      return { ...measurement, items };
    });
  }

  return {
    async listMeasurements(params) {
      const resolved = await resolveEquipmentIds(params);
      if (resolved.empty) {
        return { items: [], nextCursor: null };
      }
      const { equipmentIds, allEquipment } = resolved;
      const keyword = params.keyword?.trim() ?? '';
      let matches: ((observation: Observation) => boolean) | undefined;
      if (keyword !== '') {
        const statusCodes = await repositories.statusCodes.list({ includeDeleted: true });
        matches = createKeywordMatcher(keyword, {
          equipment: new Map(allEquipment.map((item) => [item.equipmentId, item.name])),
          statusCodes: new Map(statusCodes.map((item) => [item.code, item.name])),
        });
      }

      // 前のページの最後の計測の日時の、次から読む（日時は、両端を含む。1 ミリ秒ずらす）
      let { from, to } = params;
      if (params.cursor !== undefined) {
        const last = Date.parse(params.cursor);
        if (Number.isNaN(last)) {
          throw new AppError('VALIDATION_ERROR', 'ページの指定が正しくありません');
        }
        if (params.direction === 'desc') {
          const bound = new Date(last - 1);
          to = to === undefined || to.getTime() > bound.getTime() ? bound : to;
        } else {
          const bound = new Date(last + 1);
          from = from === undefined || from.getTime() < bound.getTime() ? bound : from;
        }
      }
      const filter = omitUndefined({
        equipmentIds,
        category: params.category,
        source: params.source,
        from,
        to,
        problemOnly: params.problemOnly === true ? true : undefined,
        matches,
      });
      const sort = { key: 'observedAt', direction: params.direction } as const;

      // 日時の枠（同じ日時の観測値）が、そろうまで読む。1 回の計測の項目が、ページの境界で割れないよう、
      // 最後の枠は、次の日時の観測値を読むか、データの終わりまで読んで、確定する
      const wanted = Math.max(1, params.limit);
      const chunk = Math.min(MAX_CHUNK, Math.max(100, wanted * ITEMS_PER_MEASUREMENT_HINT));
      const rows: Observation[] = [];
      let repoCursor: string | undefined;
      let exhausted = false;
      let selected: TimeSlot[] = [];
      let measurementCount = 0;
      for (;;) {
        const page = await repositories.observations.query(
          filter,
          { limit: chunk, ...omitUndefined({ cursor: repoCursor }) },
          sort,
        );
        rows.push(...page.items);
        repoCursor = page.nextCursor ?? undefined;
        exhausted = page.nextCursor === null;
        const slots = toTimeSlots(rows);
        // データが続く間は、最後の枠は、まだ、そろっていない
        const complete = exhausted ? slots : slots.slice(0, -1);
        selected = [];
        measurementCount = 0;
        for (const slot of complete) {
          if (measurementCount >= wanted) {
            break;
          }
          selected.push(slot);
          measurementCount += toMeasurements(slot).length;
        }
        if (exhausted || measurementCount >= wanted) {
          // 選んだあとに、読んだ枠が残っている（または、まだ、データが続く）なら、次のページがある
          const lastSlot = selected.at(-1);
          if (lastSlot === undefined) {
            return { items: [], nextCursor: null };
          }
          const hasMore = !exhausted || selected.length < slots.length;
          const completed = await completeMeasurements(
            selected.flatMap(toMeasurements),
            keyword !== '' || params.category !== undefined || params.problemOnly === true,
          );
          const measurements =
            params.includeUsage === true ? await withMeasurementUsage(completed) : completed;
          return { items: measurements, nextCursor: hasMore ? lastSlot.observedAt : null };
        }
      }
    },

    async list(params) {
      const resolved = await resolveEquipmentIds(params);
      if (resolved.empty) {
        return { items: [], nextCursor: null };
      }
      const { equipmentIds, allEquipment } = resolved;

      let itemKeys: readonly string[] | undefined;
      if (params.viewpointId !== undefined) {
        const meta = findViewpointMeta(params.viewpointId);
        if (meta === undefined) {
          throw new AppError('NOT_FOUND', '観点が見つかりません');
        }
        itemKeys = viewpointSourceItemKeys(getViewpointDefinition(meta.id)) ?? undefined;
      }

      const keyword = params.keyword?.trim() ?? '';
      let matches: ((observation: Observation) => boolean) | undefined;
      if (keyword !== '') {
        const statusCodes = await repositories.statusCodes.list({ includeDeleted: true });
        const names: ObservationNames = {
          equipment: new Map(allEquipment.map((item) => [item.equipmentId, item.name])),
          statusCodes: new Map(statusCodes.map((item) => [item.code, item.name])),
        };
        matches = createKeywordMatcher(keyword, names);
      }

      const page = await repositories.observations.query(
        omitUndefined({
          equipmentIds,
          category: params.category,
          itemKey: params.itemKey,
          itemKeys,
          source: params.source,
          from: params.from,
          to: params.to,
          problemOnly: params.problemOnly === true ? true : undefined,
          matches,
        }),
        { limit: params.limit, cursor: params.cursor },
        { key: params.sort, direction: params.direction },
      );
      return {
        items: params.includeUsage === true ? await withUsage(page.items) : page.items,
        nextCursor: page.nextCursor,
      };
    },
  };
}
