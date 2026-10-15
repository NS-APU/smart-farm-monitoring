/**
 * 観測値の絞り込み・並べ替えの規則（ローカル実装と DynamoDB 実装で共通）。
 * 同じ規則を、両方のアダプタが使い、契約テスト（tests/integration/repository-contract.test.ts）で同じ結果を保証する。
 */

import type { ObservationSortKey, SortDirection } from '@smart-farm/shared/constants/sorting';
import { compareIsoInstants } from '@smart-farm/shared/time';
import { observationKey, type Observation } from '@smart-farm/shared/schemas/observation';
import type { ObservationFilter } from '../../application/ports/repositories.ts';

/** 計測日時の範囲の境界（ISO 8601）。行ごとに変換し直さないよう、検索の前に1回だけ作る。 */
export interface ObservedBounds {
  readonly fromIso: string | undefined;
  readonly toIso: string | undefined;
}

export function matchesObservation(
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
export const COLLATOR = new Intl.Collator();

/** 日時（ISO 8601）の文字列の比較。同じ長さなら、単純な比較で足りる（照合より大幅に速い）。違う長さ（ミリ秒の有無）は照合の順序。 */
export function compareIso(left: string, right: string): number {
  if (left.length === right.length) {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return COLLATOR.compare(left, right);
}

/** 一意キーを決める 4 つの値（設備・項目・計測日時・取得元）。計測日時の順は、これだけで決まる。 */
export type ObservationOrderKey = Pick<
  Observation,
  'equipmentId' | 'itemKey' | 'observedAt' | 'source'
>;

/**
 * 計測日時の順の比較（昇順・降順）。同じ計測日時のものは、方向にかかわらず、一意キーの昇順。
 * DynamoDB の実装は、パーティションごとの結果を併合するときと、カーソルの位置の判定に、同じ比較を使う。
 */
export function compareByObservedAt(
  direction: SortDirection,
): (left: ObservationOrderKey, right: ObservationOrderKey) => number {
  const sign = direction === 'asc' ? 1 : -1;
  return (left, right) =>
    sign * compareIso(left.observedAt, right.observedAt) ||
    COLLATOR.compare(observationKey(left), observationKey(right));
}

export function compareObservations(
  key: ObservationSortKey,
  direction: SortDirection,
): (left: Observation, right: Observation) => number {
  if (key === 'observedAt') {
    return compareByObservedAt(direction);
  }
  const sign = direction === 'asc' ? 1 : -1;
  return (left, right) => {
    let result: number;
    if (key === 'value') {
      const leftValue = typeof left.value === 'number' ? left.value : Number.NEGATIVE_INFINITY;
      const rightValue = typeof right.value === 'number' ? right.value : Number.NEGATIVE_INFINITY;
      result = leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
    } else {
      result = COLLATOR.compare(left[key], right[key]);
    }
    // 同じ値のときは、計測日時 → 一意キーの順で並べ、ページ分割の結果を安定させる
    return (
      sign * result ||
      compareIso(right.observedAt, left.observedAt) ||
      COLLATOR.compare(observationKey(left), observationKey(right))
    );
  };
}
