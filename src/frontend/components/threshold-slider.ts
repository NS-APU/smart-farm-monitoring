/**
 * 判断基準の閾値のスライダーの補助（Issue #358）。範囲の決め方と、値の丸め・表示。
 * 範囲は、指標ごとの目安（shared の `criteria-ranges.ts`）を、現在の入力の値を含むように広げる。
 * 目安のない指標は、入力の値から決める。
 */

import {
  findThresholdSliderRange,
  type ThresholdSliderRange,
} from '@smart-farm/shared/constants/criteria-ranges';

/** 1 目盛りの小数の桁数（0.001 → 3）。 */
function stepDecimals(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** スライダーの値を、目盛りの桁数に丸める（浮動小数点の誤差〔0.30000000000000004〕を出さない）。 */
export function roundToStep(value: number, step: number): number {
  return Number(value.toFixed(stepDecimals(step)));
}

/** 目盛りの文字列（入力欄に入れる値）。 */
export function sliderValueText(value: number, step: number): string {
  return String(roundToStep(value, step));
}

/** 目安のない指標の範囲を、入力の値から決める（0 以上なら 0 から、最大値の 2 倍まで。目盛りは、範囲の約 100 分の 1 を 10 の冪にした値）。 */
function fallbackRange(values: readonly number[]): ThresholdSliderRange {
  const low = Math.min(0, ...values);
  const high = Math.max(1, ...values) * 2;
  const rawStep = (high - low) / 100;
  const step = 10 ** Math.floor(Math.log10(rawStep));
  return { min: low, max: Math.ceil(high / step) * step, step };
}

/**
 * スライダーの範囲を、入力の値（数値として読めるもの）を含むように、目盛りの単位で広げる（範囲の中なら、そのまま）。
 * データ入力のスライダー（Issue #361）も使う。
 */
export function extendSliderRange(
  base: ThresholdSliderRange,
  values: readonly number[],
): ThresholdSliderRange {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return base;
  }
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  return {
    min:
      low < base.min ? roundToStep(Math.floor(low / base.step) * base.step, base.step) : base.min,
    max:
      high > base.max ? roundToStep(Math.ceil(high / base.step) * base.step, base.step) : base.max,
    step: base.step,
  };
}

/**
 * 閾値のスライダーの範囲。指標の目安の範囲（なければ、入力の値から決める）を、入力の値を含むように広げる。
 */
export function thresholdSliderRange(
  indicator: string,
  values: readonly number[],
): ThresholdSliderRange {
  const finite = values.filter((value) => Number.isFinite(value));
  return extendSliderRange(findThresholdSliderRange(indicator) ?? fallbackRange(finite), values);
}
