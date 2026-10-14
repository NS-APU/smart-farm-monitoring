/**
 * 評価で使う数値の補助関数（純粋関数）。
 * 小数の比較は許容誤差を明示する（coding-standards.md）。境界値（例: 90%ちょうど）が
 * 浮動小数点の誤差で外れないよう、メトリクスは小数第6位に丸めてから判定する。
 */

const METRIC_PRECISION_DIGITS = 6;

export function roundTo(value: number, fractionDigits: number): number {
  const factor = 10 ** fractionDigits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** メトリクスの値を、判定に使う精度（小数第6位）に揃える。 */
export function normalizeMetric(value: number): number {
  return roundTo(value, METRIC_PRECISION_DIGITS);
}

/** 分母が 0 の場合は null（「不明」の入力）を返す。0 で代用しない。 */
export function divideOrNull(numerator: number, denominator: number): number | null {
  if (denominator === 0) {
    return null;
  }
  return normalizeMetric(numerator / denominator);
}

export function percentOrNull(numerator: number, denominator: number): number | null {
  if (denominator === 0) {
    return null;
  }
  return normalizeMetric((numerator / denominator) * 100);
}
