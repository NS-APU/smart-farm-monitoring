/** 観点の定義で使う補助関数（純粋関数）。 */

import { MINUTES_PER_HOUR, SECONDS_PER_HOUR } from '@smart-farm/shared/time';
import type { MeasureValues } from '../definition.ts';
import { divideOrNull, normalizeMetric, percentOrNull } from '../numbers.ts';

/** 指定した項目がすべて取得できている場合のみ、値を返す。1つでも欠けていれば null。 */
export function pickAll<Key extends string>(
  values: MeasureValues,
  keys: readonly Key[],
): Record<Key, number> | null {
  // 空のオブジェクトから、keys のすべてのキーを埋めて返すため、型を断定する（途中で欠けていれば null を返す）
  const picked = {} as Record<Key, number>;
  for (const key of keys) {
    const value = values[key];
    if (value === undefined) {
      return null;
    }
    picked[key] = value;
  }
  return picked;
}

/** 取得できている項目の値（欠けていれば null）。 */
export function optionalValue(values: MeasureValues, key: string): number | null {
  return values[key] ?? null;
}

/** 指定した項目の値を、そのままメトリクスにする（欠けていれば null）。 */
export function passThrough<Key extends string>(
  values: MeasureValues,
  keys: readonly Key[],
): Record<Key, number | null> {
  // Object.fromEntries はキーの型を string に広げるため、結果の型を断定する（キーは keys の要素のみ）
  return Object.fromEntries(keys.map((key) => [key, optionalValue(values, key)])) as Record<
    Key,
    number | null
  >;
}

/** 可販果率（%）= 100 − ((誤収穫数 + 果実損傷数) ÷ 収穫数 × 100）。robot-health.md 1章。 */
export function marketableFruitRatePercent(values: MeasureValues): number | null {
  const picked = pickAll(values, ['harvestCount', 'damagedFruitCount', 'wrongHarvestCount']);
  if (picked === null) {
    return null;
  }
  const lossRate = percentOrNull(
    picked.damagedFruitCount + picked.wrongHarvestCount,
    picked.harvestCount,
  );
  return lossRate === null ? null : normalizeMetric(100 - lossRate);
}

/** 平均処理時間（秒/果実）= 収穫稼働時間 × 3600（SECONDS_PER_HOUR）÷ 収穫数。robot-health.md 2章。 */
export function averageSecondsPerFruit(values: MeasureValues): number | null {
  const picked = pickAll(values, ['harvestOperatingHours', 'harvestCount']);
  return picked === null
    ? null
    : divideOrNull(picked.harvestOperatingHours * SECONDS_PER_HOUR, picked.harvestCount);
}

/**
 * MTTR（時間）= 復旧に要した時間（分）÷ 60（MINUTES_PER_HOUR）÷ 故障回数。故障回数が 0 の場合は 0。
 * 復旧時間は分で入力し、MTTR の判断基準は時間のため、境界で換算する（robot-health.md 4章の確認事項）。
 */
export function mttrHours(values: MeasureValues): number | null {
  const picked = pickAll(values, ['recoveryMinutes', 'failureCount']);
  if (picked === null) {
    return null;
  }
  return picked.failureCount === 0
    ? 0
    : normalizeMetric(picked.recoveryMinutes / MINUTES_PER_HOUR / picked.failureCount);
}

/** MTBF（時間）= 稼働時間 ÷ 故障回数。故障回数が 0 の場合は稼働時間。robot-health.md 5章・7章。 */
export function mtbfHours(values: MeasureValues): number | null {
  const picked = pickAll(values, ['operatingHours', 'failureCount']);
  if (picked === null) {
    return null;
  }
  return picked.failureCount === 0
    ? normalizeMetric(picked.operatingHours)
    : normalizeMetric(picked.operatingHours / picked.failureCount);
}

/** 稼働率（%）= MTBF ÷ (MTBF + MTTR) × 100。分母が 0 の場合は null。 */
export function availabilityPercent(mtbf: number | null, mttr: number | null): number | null {
  if (mtbf === null || mttr === null) {
    return null;
  }
  return percentOrNull(mtbf, mtbf + mttr);
}
