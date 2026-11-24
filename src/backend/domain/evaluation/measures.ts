/**
 * 観測値 → 評価の入力（集計済みの値）への変換（純粋関数）。
 * 集計の規則は dev_spec.md 4章の暫定仕様:
 * - 使う観測値: 論理削除でない、品質が VALID または LATE、値がある、計測日時が期間内、評価時刻までに受信済み
 * - 同じ設備・項目・計測日時に自動取り込みと手動入力が重なる場合は、手動入力を使う（FR-4.1.4。Q の暫定。状態値・ステータスコード・手動専用の件数の項目）
 * - 合計（TOTAL。手動専用の件数など）: 期間内の入力ごとの値の合計
 * - 累積（CUMULATIVE。収穫数・稼働時間など。D-26）: 期間内の増分の合計。設備ごとに、計測日時の順に、直前の値との差を足す。
 *   期間の直前の値を基準にし（なければ 0 から）、値が減ったときは、リセットとみなして、減った時点の値そのものを増分にする。
 *   **取得元は、自動を優先する（D-26）**: 評価の期間に、設備・項目の自動取り込みの値（使える数値）が 1 件でもあれば、自動だけを使い、
 *   手動入力は使わない（別のカウンターがつながり、増分が壊れるため）。自動がなければ、手動だけを使う（手動のみの運用）。両方とも保持する（削除しない）。
 *   取得元は、評価の期間（短期 24 時間・長期の各期間）ごと、設備・項目ごとに決める（期間によって、取得元が変わりうる。例: 24 時間は自動なし→手動、
 *   7 日は自動あり→自動）。期間の直前の値（基準）も、選んだ取得元の値だけから選ぶ
 * - 状態値（LEVEL）: 短期は最新値、長期は平均。ステータス: 短期は最新、長期は最も悪いカテゴリ
 * - 評価（RATING。満足度）: 各入力者の期間内の最新の入力を取り、入力者の平均を取る（1 人 1 票。短期・長期とも）
 * - 未取得の項目は、結果に含めない（0 で代用しない）
 */

import {
  STATUS_CODE_ITEM_KEY,
  findItemDefinition,
  isCumulativeItem,
} from '@smart-farm/shared/constants/items';
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
  /**
   * 累積の項目の基準にする、期間（from）より前の観測値（累積の項目だけが使われる。ほかの項目・期間内の観測値は無視する）。
   * 設備・項目・取得元ごとに、計測日時が最も新しい、使える観測値を、期間の直前の値にする（使う取得元の値だけを基準にする。D-26）。
   */
  readonly priorObservations?: readonly Observation[];
  /**
   * 合計（累積）の項目で、自動取り込みを使う設備・項目（`autoCumulativeKeysOf` の結果。D-26）。省略すると、この期間の観測値から決める。
   * 推移（区間ごとの集計）は、区間ではなく、推移の期間の全体で決めて渡す（区間ごとに取得元が変わらないように）。
   */
  readonly autoCumulativeKeys?: ReadonlySet<string>;
}

export interface Point {
  readonly observation: Observation;
  readonly observedMs: number;
}

/** 評価に使える観測値（論理削除でない・値がある・品質が使える・評価時刻までに受信済み）の計測日時（ミリ秒）。使えなければ undefined。 */
export function usableObservedMs(observation: Observation, knownAtMs: number): number | undefined {
  if (
    observation.isDeleted ||
    observation.value === null ||
    !isUsableQuality(observation.quality)
  ) {
    return undefined;
  }
  return Date.parse(observation.receivedAt) > knownAtMs
    ? undefined
    : Date.parse(observation.observedAt);
}

export function selectUsablePoints(
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
    const observedMs = usableObservedMs(observation, knownAtMs);
    if (observedMs === undefined || observedMs < fromMs || observedMs > toMs) {
      continue;
    }
    points.push({ observation, observedMs });
  }
  return points;
}

/** 累積の項目の、取得元を決める単位・基準を引く単位（設備・項目）。 */
function equipmentItemKey(observation: Pick<Observation, 'equipmentId' | 'itemKey'>): string {
  return `${observation.equipmentId}#${observation.itemKey}`;
}

/** 累積の項目の基準を引く単位（設備・項目・取得元。取得元を混ぜない）。 */
function baselineKey(observation: Pick<Observation, 'equipmentId' | 'itemKey' | 'source'>): string {
  return `${equipmentItemKey(observation)}#${observation.source}`;
}

/**
 * 合計（累積）の項目で、自動取り込みを使う設備・項目（キーは「設備#項目」）。使える点（期間内・使える品質・数値）に、自動取り込みが 1 件でもある
 * 設備・項目（D-26）。ここにない設備・項目は、手動入力だけを使う（手動入力もなければ、値は未取得）。
 */
export function autoCumulativeKeysOf(points: readonly Point[]): Set<string> {
  const keys = new Set<string>();
  for (const { observation } of points) {
    if (
      observation.source === 'AUTO_IMPORT' &&
      typeof observation.value === 'number' &&
      isCumulativeItem(observation.itemKey)
    ) {
      keys.add(equipmentItemKey(observation));
    }
  }
  return keys;
}

/** 期間（from〜to。評価時刻までに受信済み）の観測値から、自動取り込みを使う設備・項目（合計〔累積〕の項目。D-26）を求める。 */
export function autoCumulativeKeysIn(
  observations: readonly Observation[],
  from: Date,
  to: Date,
  knownAt: Date = to,
): Set<string> {
  return autoCumulativeKeysOf(selectUsablePoints(observations, from, to, knownAt));
}

/** 合計（累積）の項目の手動入力が、自動取り込みを優先するため、評価に使われないか（D-26）。 */
export function isManualOverriddenByAuto(
  observation: Pick<Observation, 'equipmentId' | 'itemKey' | 'source'>,
  autoKeys: ReadonlySet<string>,
): boolean {
  return (
    observation.source === 'MANUAL' &&
    isCumulativeItem(observation.itemKey) &&
    autoKeys.has(equipmentItemKey(observation))
  );
}

/**
 * 累積の項目の、期間の直前の値（設備・項目・取得元ごとに、期間（fromMs）より前で、計測日時が最も新しい、使える数値の観測値）。
 * 取得元ごとに持つ（自動と手動を混ぜない。D-26）。推移（区間ごとの集計）が、区間をまたいで、基準を引き継ぐのにも使う。
 */
export function latestBaselineObservations(
  observations: readonly Observation[],
  fromMs: number,
  knownAtMs: number,
): Observation[] {
  const latest = new Map<string, { observedMs: number; observation: Observation }>();
  for (const observation of observations) {
    if (typeof observation.value !== 'number' || !isCumulativeItem(observation.itemKey)) {
      continue;
    }
    const observedMs = usableObservedMs(observation, knownAtMs);
    if (observedMs === undefined || observedMs >= fromMs) {
      continue;
    }
    const key = baselineKey(observation);
    const current = latest.get(key);
    if (current === undefined || observedMs > current.observedMs) {
      latest.set(key, { observedMs, observation });
    }
  }
  return [...latest.values()].map(({ observation }) => observation);
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

/**
 * 入力者ごとの最新の入力の平均（1 人 1 票）。入力の回数に偏らない。入力者の記録がない入力は、1 人の入力として扱う。
 * 期間内に入力のない人は、含まれない（点は、期間内のものだけが渡る）。
 */
function averageOfLatestPerEntrant(points: readonly Point[]): number | undefined {
  const latestByEntrant = new Map<string, { observedMs: number; value: number }>();
  for (const { observation, observedMs } of points) {
    if (typeof observation.value !== 'number') {
      continue;
    }
    const entrant = observation.enteredBy ?? '';
    const current = latestByEntrant.get(entrant);
    // 同じ日時なら、後に現れた点を使う
    if (current === undefined || observedMs >= current.observedMs) {
      latestByEntrant.set(entrant, { observedMs, value: observation.value });
    }
  }
  if (latestByEntrant.size === 0) {
    return undefined;
  }
  let total = 0;
  for (const { value } of latestByEntrant.values()) {
    total += value;
  }
  return normalizeMetric(total / latestByEntrant.size);
}

function aggregateNumericItem(
  aggregation: 'TOTAL' | 'LEVEL' | 'RATING',
  horizon: Horizon,
  points: readonly Point[],
): number | undefined {
  if (aggregation === 'RATING') {
    return averageOfLatestPerEntrant(points);
  }
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

/**
 * 累積の項目の期間の値: 期間内の増分の合計（D-26）。設備ごとに、計測日時の順に、直前の値（期間の最初は、基準。なければ 0）との差を足す。
 * 値が減ったときは、リセットとみなし、減った時点の値そのものを増分にする。
 */
function aggregateCumulativeItem(
  itemKey: string,
  points: readonly Point[],
  baselines: ReadonlyMap<string, number>,
  autoKeys: ReadonlySet<string>,
): number | undefined {
  const byEquipment = new Map<string, { observedMs: number; value: number }[]>();
  for (const { observation, observedMs } of points) {
    if (typeof observation.value !== 'number') {
      continue;
    }
    const group = byEquipment.get(observation.equipmentId);
    if (group === undefined) {
      byEquipment.set(observation.equipmentId, [{ observedMs, value: observation.value }]);
    } else {
      group.push({ observedMs, value: observation.value });
    }
  }
  if (byEquipment.size === 0) {
    return undefined;
  }
  let total = 0;
  for (const [equipmentId, group] of byEquipment) {
    // 同じ計測日時は、元の順序を保つ（安定な並べ替え）。並んでいる入力は、並べ替えない
    if (
      group.some(
        (point, index) => index > 0 && point.observedMs < (group[index - 1]?.observedMs ?? 0),
      )
    ) {
      group.sort((left, right) => left.observedMs - right.observedMs);
    }
    // 基準は、使う取得元（自動があれば自動、なければ手動）の値だけから選ぶ
    const source = autoKeys.has(`${equipmentId}#${itemKey}`) ? 'AUTO_IMPORT' : 'MANUAL';
    let previous = baselines.get(`${equipmentId}#${itemKey}#${source}`) ?? 0;
    for (const { value } of group) {
      total += value >= previous ? value - previous : value;
      previous = value;
    }
  }
  return normalizeMetric(total);
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
  const autoKeys = input.autoCumulativeKeys ?? autoCumulativeKeysOf(usable);
  // 合計（累積）の項目は、自動があれば、手動入力を使わない（D-26）。それ以外は、同じ計測日時のときだけ、手動入力を優先する
  const preferred = applyManualPriority(
    autoKeys.size === 0
      ? usable
      : usable.filter(({ observation }) => !isManualOverriddenByAuto(observation, autoKeys)),
  );

  const pointsByItem = new Map<string, Point[]>();
  for (const point of preferred) {
    const group = pointsByItem.get(point.observation.itemKey);
    if (group === undefined) {
      pointsByItem.set(point.observation.itemKey, [point]);
    } else {
      group.push(point);
    }
  }

  const baselines = new Map(
    latestBaselineObservations(
      input.priorObservations ?? [],
      input.from.getTime(),
      (input.knownAt ?? input.to).getTime(),
    ).flatMap((observation) =>
      typeof observation.value === 'number'
        ? [[baselineKey(observation), observation.value] as const]
        : [],
    ),
  );
  const values: Record<string, number> = {};
  for (const [itemKey, points] of pointsByItem) {
    const definition = findItemDefinition(itemKey);
    if (definition === undefined || definition.aggregation === 'STATUS') {
      continue;
    }
    const aggregated =
      definition.aggregation === 'CUMULATIVE'
        ? aggregateCumulativeItem(itemKey, points, baselines, autoKeys)
        : aggregateNumericItem(definition.aggregation, input.horizon, points);
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
