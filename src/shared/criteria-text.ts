/**
 * 判断基準の表示用の変換（画面で、閾値を「条件」として示す。functional-specification.md 3.2）。
 * 境界は「以上」「未満」（evaluation.md 3章）。閾値の判定そのものは backend のドメイン層（grading.ts）が持つ。
 */

import { getMetricMeta } from './constants/metrics.ts';
import type { JudgedStatus } from './constants/status.ts';
import type { Criterion } from './schemas/criteria.ts';

export interface CriterionRow {
  readonly status: JudgedStatus;
  /** 区分の条件（例: 「90%以上」）。 */
  readonly condition: string;
}

/** 判断基準の区分の範囲 [from, to)。下限なし・上限なしは無限大で示す。 */
export interface CriterionBand {
  readonly status: JudgedStatus;
  readonly from: number;
  readonly to: number;
}

/** 数値を、3桁区切りで表示する（例: 10000 → 10,000）。 */
export function formatThreshold(value: number): string {
  const [integerPart = '', fractionPart] = String(value).split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fractionPart === undefined ? grouped : `${grouped}.${fractionPart}`;
}

export interface DescribeOptions {
  /** 閾値の小数の桁数（指定しなければ、そのまま表示する。例: 満足度は 4.0）。 */
  readonly fractionDigits?: number;
}

/** 区分（正常・注意・異常）ごとの条件。 */
export function describeCriterionRows(
  criterion: Criterion,
  options: DescribeOptions = {},
): CriterionRow[] {
  const { unit } = getMetricMeta(criterion.indicator);
  const text = (value: number): string =>
    `${options.fractionDigits === undefined ? formatThreshold(value) : value.toFixed(options.fractionDigits)}${unit}`;
  switch (criterion.kind) {
    case 'UPPER': {
      const { cautionFrom, errorFrom } = criterion.thresholds;
      return [
        { status: 'NORMAL', condition: `${text(cautionFrom)}未満` },
        { status: 'CAUTION', condition: `${text(cautionFrom)}以上${text(errorFrom)}未満` },
        { status: 'ERROR', condition: `${text(errorFrom)}以上` },
      ];
    }
    case 'LOWER': {
      const { errorBelow, cautionBelow } = criterion.thresholds;
      return [
        { status: 'NORMAL', condition: `${text(cautionBelow)}以上` },
        { status: 'CAUTION', condition: `${text(errorBelow)}以上${text(cautionBelow)}未満` },
        { status: 'ERROR', condition: `${text(errorBelow)}未満` },
      ];
    }
    case 'RANGE': {
      const { errorLower, normalLower, normalUpper, errorUpper } = criterion.thresholds;
      return [
        { status: 'NORMAL', condition: `${text(normalLower)}以上${text(normalUpper)}未満` },
        {
          status: 'CAUTION',
          condition: `${text(errorLower)}以上${text(normalLower)}未満、${text(normalUpper)}以上${text(errorUpper)}未満`,
        },
        { status: 'ERROR', condition: `${text(errorLower)}未満、${text(errorUpper)}以上` },
      ];
    }
  }
}

/** 判断基準の区分を、数直線上の範囲にする（グラフの背景の帯）。 */
export function criterionBands(criterion: Criterion): CriterionBand[] {
  switch (criterion.kind) {
    case 'UPPER': {
      const { cautionFrom, errorFrom } = criterion.thresholds;
      return [
        { status: 'NORMAL', from: Number.NEGATIVE_INFINITY, to: cautionFrom },
        { status: 'CAUTION', from: cautionFrom, to: errorFrom },
        { status: 'ERROR', from: errorFrom, to: Number.POSITIVE_INFINITY },
      ];
    }
    case 'LOWER': {
      const { errorBelow, cautionBelow } = criterion.thresholds;
      return [
        { status: 'ERROR', from: Number.NEGATIVE_INFINITY, to: errorBelow },
        { status: 'CAUTION', from: errorBelow, to: cautionBelow },
        { status: 'NORMAL', from: cautionBelow, to: Number.POSITIVE_INFINITY },
      ];
    }
    case 'RANGE': {
      const { errorLower, normalLower, normalUpper, errorUpper } = criterion.thresholds;
      return [
        { status: 'ERROR', from: Number.NEGATIVE_INFINITY, to: errorLower },
        { status: 'CAUTION', from: errorLower, to: normalLower },
        { status: 'NORMAL', from: normalLower, to: normalUpper },
        { status: 'CAUTION', from: normalUpper, to: errorUpper },
        { status: 'ERROR', from: errorUpper, to: Number.POSITIVE_INFINITY },
      ];
    }
  }
}
