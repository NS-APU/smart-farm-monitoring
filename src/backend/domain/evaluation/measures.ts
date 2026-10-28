/**
 * 観測値 → 評価の入力（集計済みの値）への変換（純粋関数）。
 * 集計の規則は dev_spec.md 4章の暫定仕様:
 * - 使う観測値: 論理削除でない、品質が VALID または LATE、値がある、計測日時が期間内、評価時刻までに受信済み
 * - 同じ設備・項目・計測日時に自動取り込みと手動入力が重なる場合は、手動入力を使う（FR-4.1.4。Q の暫定）
 * - 合計（TOTAL）: 期間内の合計。状態値（LEVEL）: 短期は最新値、長期は平均。ステータス: 短期は最新、長期は最も悪いカテゴリ
 * - 未取得の項目は、結果に含めない（0 で代用しない）
 */

import { STATUS_CODE_ITEM_KEY, findItemDefinition } from '@smart-farm/shared/constants/items';
import { STATUS_SEVERITY, type Horizon } from '@smart-farm/shared/constants/status';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import type { StatusDetail } from '@smart-farm/shared/schemas/evaluation';
import type { StatusCodeDefinition } from '@smart-farm/shared/schemas/status-code';
import { MS_PER_DAY, MS_PER_MINUTE } from '@smart-farm/shared/time';
import type { Measures } from './definition.ts';
import { normalizeMetric } from './numbers.ts';
import { isUsableQuality } from '../observation-quality.ts';

/** 評価の対象に、データの入口（ロボット・環境センサー）が存在するか。 */
export interface ExpectedStreams {
  readonly robot: boolean;
  readonly sensor: boolean;
}

export interface AggregationInput {
  readonly observations: readonly Observation[];
  readonly horizon: Horizon;
  /** 集計期間の開始・終了（終了は評価時刻）。 */
  readonly from: Date;
  readonly to: Date;
  /** この時刻までに受信済みの値のみ使う（既定は to）。推移（区間ごとの集計）では、現在時刻を指定する。 */
  readonly knownAt?: Date;
  readonly statusCodes: ReadonlyMap<string, StatusCodeDefinition>;
  readonly expectedStreams: ExpectedStreams;
  /** データ活用度合いの「期待される取得数」を数える間隔（分）。取り込み間隔の既定値を使う。 */
  readonly coverageSlotMinutes: number;
}

interface Point {
  readonly observation: Observation;
  readonly observedMs: number;
}

function selectUsablePoints(
  observations: readonly Observation[],
  from: Date,
  to: Date,
  knownAt: Date,
): Point[] {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const knownAtMs = knownAt.getTime();
  const points: Point[] = [];
  for (const observation of observations) {
    if (
      observation.isDeleted ||
      observation.value === null ||
      !isUsableQuality(observation.quality)
    ) {
      continue;
    }
    const observedMs = Date.parse(observation.observedAt);
    if (
      observedMs < fromMs ||
      observedMs > toMs ||
      Date.parse(observation.receivedAt) > knownAtMs
    ) {
      continue;
    }
    points.push({ observation, observedMs });
  }
  return points;
}

/** 同じ設備・項目・計測日時に自動取り込みと手動入力がある場合は、手動入力だけを残す。 */
function applyManualPriority(points: readonly Point[]): Point[] {
  const manualKeys = new Set<string>();
  for (const { observation } of points) {
    if (observation.source === 'MANUAL') {
      manualKeys.add(manualPriorityKey(observation));
    }
  }
  return points.filter(
    ({ observation }) =>
      observation.source === 'MANUAL' || !manualKeys.has(manualPriorityKey(observation)),
  );
}

/** 手動入力の優先を判定する単位（設備・項目・計測日時）。取得元は含めない。 */
function manualPriorityKey(
  observation: Pick<Observation, 'equipmentId' | 'itemKey' | 'observedAt'>,
): string {
  return `${observation.equipmentId}#${observation.itemKey}#${observation.observedAt}`;
}

/** 計測日時が最も新しい点。同じ日時の点が複数あるときは、後のものを使う。 */
function latestOf<Item extends { readonly observedMs: number }>(
  items: readonly Item[],
): Item | undefined {
  let latest: Item | undefined;
  for (const item of items) {
    if (latest === undefined || item.observedMs >= latest.observedMs) {
      latest = item;
    }
  }
  return latest;
}

function aggregateNumericItem(
  aggregation: 'TOTAL' | 'LEVEL',
  horizon: Horizon,
  points: readonly Point[],
): number | undefined {
  const numeric = points.flatMap(({ observation, observedMs }) =>
    typeof observation.value === 'number' ? [{ observedMs, value: observation.value }] : [],
  );
  const latest = latestOf(numeric);
  if (latest === undefined) {
    return undefined;
  }
  if (aggregation === 'LEVEL' && horizon === 'SHORT') {
    return latest.value;
  }
  const total = numeric.reduce((sum, point) => sum + point.value, 0);
  return normalizeMetric(aggregation === 'TOTAL' ? total : total / numeric.length);
}

function resolveStatus(
  horizon: Horizon,
  points: readonly Point[],
  statusCodes: ReadonlyMap<string, StatusCodeDefinition>,
): StatusDetail | null {
  const resolved: { point: Point; detail: StatusDetail }[] = [];
  for (const point of points) {
    const definition =
      typeof point.observation.value === 'string'
        ? statusCodes.get(point.observation.value)
        : undefined;
    if (definition !== undefined && !definition.isDeleted) {
      resolved.push({
        point,
        detail: { code: definition.code, name: definition.name, category: definition.category },
      });
    }
  }
  if (resolved.length === 0) {
    return null;
  }
  let candidates = resolved;
  if (horizon === 'LONG') {
    // 引数の展開（Math.max(...配列)）は、点が約 12 万件を超えると、呼び出しのスタックが足りず失敗する
    // （ロボットが 1 分間隔の 90 日分。Issue #266）。件数に依存しないよう、ループで求める
    let worstSeverity = Number.NEGATIVE_INFINITY;
    for (const { detail } of resolved) {
      worstSeverity = Math.max(worstSeverity, STATUS_SEVERITY[detail.category]);
    }
    candidates = resolved.filter(
      ({ detail }) => STATUS_SEVERITY[detail.category] === worstSeverity,
    );
  }
  const latest = latestOf(candidates.map(({ point }) => point));
  return candidates.find(({ point }) => point === latest)?.detail ?? null;
}

function slotIndex(startMs: number, observedMs: number, slotMs: number, slotCount: number): number {
  return Math.min(slotCount - 1, Math.max(0, Math.floor((observedMs - startMs) / slotMs)));
}

/**
 * データ活用度合いの入力（取得数・全データ数）。暫定の定義（dev_spec.md 4章）:
 * 期間を一定の間隔のスロットに区切り、データの入口（ロボット・環境センサー・手動入力）ごとに、
 * 値が1件以上あったスロットの数を「取得数」、スロットの総数を「全データ数」とする。
 * 期間の開始は、最初の観測値の日時（データの取得が始まってから）。手動入力のスロットは1日。
 */
function computeCoverage(
  points: readonly Point[],
  input: AggregationInput,
): Record<string, number> {
  const first = points.reduce(
    (min, point) => Math.min(min, point.observedMs),
    Number.POSITIVE_INFINITY,
  );
  const startMs = Math.max(input.from.getTime(), first);
  const spanMs = Math.max(0, input.to.getTime() - startMs);
  const autoSlotMs = input.coverageSlotMinutes * MS_PER_MINUTE;
  const autoSlotCount = Math.max(1, Math.ceil(spanMs / autoSlotMs));
  const manualSlotCount = Math.max(1, Math.ceil(spanMs / MS_PER_DAY));

  const robotSlots = new Set<number>();
  const sensorSlots = new Set<number>();
  const manualSlots = new Set<number>();
  for (const { observation, observedMs } of points) {
    if (observation.source === 'MANUAL') {
      manualSlots.add(slotIndex(startMs, observedMs, MS_PER_DAY, manualSlotCount));
    } else if (observation.category === 'ENVIRONMENT') {
      sensorSlots.add(slotIndex(startMs, observedMs, autoSlotMs, autoSlotCount));
    } else {
      robotSlots.add(slotIndex(startMs, observedMs, autoSlotMs, autoSlotCount));
    }
  }

  const robotDataCount = input.expectedStreams.robot ? robotSlots.size : 0;
  const sensorDataCount = input.expectedStreams.sensor ? sensorSlots.size : 0;
  const totalDataCount =
    (input.expectedStreams.robot ? autoSlotCount : 0) +
    (input.expectedStreams.sensor ? autoSlotCount : 0) +
    manualSlotCount;
  return { robotDataCount, sensorDataCount, manualDataCount: manualSlots.size, totalDataCount };
}

/** 観測値を、視点（短期・長期）に応じて集計し、評価の入力にする。 */
export function aggregateMeasures(input: AggregationInput): Measures {
  const usable = selectUsablePoints(
    input.observations,
    input.from,
    input.to,
    input.knownAt ?? input.to,
  );
  const preferred = applyManualPriority(usable);

  const pointsByItem = new Map<string, Point[]>();
  for (const point of preferred) {
    const group = pointsByItem.get(point.observation.itemKey);
    if (group === undefined) {
      pointsByItem.set(point.observation.itemKey, [point]);
    } else {
      group.push(point);
    }
  }

  const values: Record<string, number> = {};
  for (const [itemKey, points] of pointsByItem) {
    const definition = findItemDefinition(itemKey);
    if (definition === undefined || definition.aggregation === 'STATUS') {
      continue;
    }
    const aggregated = aggregateNumericItem(definition.aggregation, input.horizon, points);
    if (aggregated !== undefined) {
      values[itemKey] = aggregated;
    }
  }

  if (input.horizon === 'LONG' && usable.length > 0) {
    Object.assign(values, computeCoverage(usable, input));
  }

  const status = resolveStatus(
    input.horizon,
    pointsByItem.get(STATUS_CODE_ITEM_KEY) ?? [],
    input.statusCodes,
  );
  return { values, status };
}
