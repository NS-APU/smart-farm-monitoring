/** 判断基準の表示用の変換（条件の文言・グラフの帯）の単体テスト。境界は「以上」「未満」。 */

import { describe, expect, it } from 'vitest';
import {
  criterionBands,
  describeCriterionRows,
  formatThreshold,
} from '../../../src/shared/criteria-text.ts';
import { getDefaultCriteria } from '../../../src/backend/domain/evaluation/default-criteria.ts';
import {
  OBSERVATION_QUALITY_LABELS,
  OBSERVATION_SOURCE_LABELS,
} from '../../../src/shared/constants/observation-labels.ts';
import type { Criterion } from '../../../src/shared/schemas/criteria.ts';

function criterionOf(
  viewpointId: Parameters<typeof getDefaultCriteria>[0],
  indicator: string,
): Criterion {
  const found = getDefaultCriteria(viewpointId).criteria.find(
    (item) => item.indicator === indicator,
  );
  if (found === undefined) {
    throw new Error('テストの前提: 判断基準がある');
  }
  return found;
}

describe('formatThreshold', () => {
  it.each([
    [0, '0'],
    [90, '90'],
    [999, '999'],
    [1000, '1,000'],
    [10000, '10,000'],
    [1234567, '1,234,567'],
    [0.01, '0.01'],
    [1.5, '1.5'],
    [-1200, '-1,200'],
    [-0.5, '-0.5'],
  ])('%s は %s', (value, expected) => {
    expect(formatThreshold(value)).toBe(expected);
  });
});

describe('describeCriterionRows', () => {
  it('下限型: 90%以上が正常、80%以上90%未満が注意、80%未満が異常', () => {
    expect(
      describeCriterionRows(criterionOf('harvestAccuracy', 'marketableFruitRatePercent')),
    ).toEqual([
      { status: 'NORMAL', condition: '90%以上' },
      { status: 'CAUTION', condition: '80%以上90%未満' },
      { status: 'ERROR', condition: '80%未満' },
    ]);
  });

  it('上限型: 5%未満が正常、5%以上10%未満が注意、10%以上が異常', () => {
    expect(describeCriterionRows(criterionOf('harvestSpeed', 'travelStoppedRatePercent'))).toEqual([
      { status: 'NORMAL', condition: '5%未満' },
      { status: 'CAUTION', condition: '5%以上10%未満' },
      { status: 'ERROR', condition: '10%以上' },
    ]);
  });

  it('範囲型: 範囲内が正常、範囲の外側が注意、さらに外側が異常（3桁区切りの単位つき）', () => {
    expect(
      describeCriterionRows(criterionOf('environmentalAdaptability', 'illuminanceLux')),
    ).toEqual([
      { status: 'NORMAL', condition: '20,000lx以上40,000lx未満' },
      { status: 'CAUTION', condition: '10,000lx以上20,000lx未満、40,000lx以上50,000lx未満' },
      { status: 'ERROR', condition: '10,000lx未満、50,000lx以上' },
    ]);
  });

  it('小数の桁数を指定すると、閾値をその桁数で表示する（満足度の 4.0）', () => {
    expect(
      describeCriterionRows(criterionOf('satisfaction', 'overallSatisfaction'), {
        fractionDigits: 1,
      }),
    ).toEqual([
      { status: 'NORMAL', condition: '4.0以上' },
      { status: 'CAUTION', condition: '3.0以上4.0未満' },
      { status: 'ERROR', condition: '3.0未満' },
    ]);
  });
});

describe('criterionBands', () => {
  it('下限型: 異常・注意・正常の順に、下から並ぶ', () => {
    expect(criterionBands(criterionOf('harvestAccuracy', 'marketableFruitRatePercent'))).toEqual([
      { status: 'ERROR', from: Number.NEGATIVE_INFINITY, to: 80 },
      { status: 'CAUTION', from: 80, to: 90 },
      { status: 'NORMAL', from: 90, to: Number.POSITIVE_INFINITY },
    ]);
  });

  it('上限型: 正常・注意・異常の順に、下から並ぶ', () => {
    expect(criterionBands(criterionOf('harvestSpeed', 'travelStoppedRatePercent'))).toEqual([
      { status: 'NORMAL', from: Number.NEGATIVE_INFINITY, to: 5 },
      { status: 'CAUTION', from: 5, to: 10 },
      { status: 'ERROR', from: 10, to: Number.POSITIVE_INFINITY },
    ]);
  });

  it('範囲型: 異常・注意・正常・注意・異常の5つの帯', () => {
    const bands = criterionBands(criterionOf('environmentalAdaptability', 'temperatureCelsius'));

    expect(bands.map((band) => band.status)).toEqual([
      'ERROR',
      'CAUTION',
      'NORMAL',
      'CAUTION',
      'ERROR',
    ]);
    expect(bands.map((band) => [band.from, band.to])).toEqual([
      [Number.NEGATIVE_INFINITY, 0],
      [0, 10],
      [10, 25],
      [25, 35],
      [35, Number.POSITIVE_INFINITY],
    ]);
  });
});

describe('観測値の取得元・状態の表示名', () => {
  it('取得元と状態のすべての値に、表示名がある', () => {
    expect(OBSERVATION_SOURCE_LABELS).toEqual({ AUTO_IMPORT: '自動取り込み', MANUAL: '手動入力' });
    expect(OBSERVATION_QUALITY_LABELS).toEqual({
      VALID: '有効',
      MISSING: '欠損',
      LATE: '遅延',
      INVALID: '不正',
    });
  });
});
