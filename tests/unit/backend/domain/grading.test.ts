import { describe, expect, it } from 'vitest';
import type { Criterion } from '@smart-farm/shared/schemas/criteria';
import {
  combineHorizonStatuses,
  judgeByCriterion,
  worstJudgedStatus,
} from '../../../../src/backend/domain/evaluation/grading.ts';
import {
  divideOrNull,
  normalizeMetric,
  percentOrNull,
  roundTo,
} from '../../../../src/backend/domain/evaluation/numbers.ts';

const upper: Criterion = {
  indicator: 'travelStoppedRatePercent',
  kind: 'UPPER',
  thresholds: { cautionFrom: 5, errorFrom: 10 },
  label: '走行停止率',
};
const lower: Criterion = {
  indicator: 'marketableFruitRatePercent',
  kind: 'LOWER',
  thresholds: { errorBelow: 80, cautionBelow: 90 },
  label: '可販果率',
};
const range: Criterion = {
  indicator: 'temperatureCelsius',
  kind: 'RANGE',
  thresholds: { errorLower: 0, normalLower: 10, normalUpper: 25, errorUpper: 35 },
  label: '温度',
};

describe('上限型の判定', () => {
  it.each([
    [4.999, 'NORMAL'],
    [5, 'CAUTION'],
    [9.999, 'CAUTION'],
    [10, 'ERROR'],
    [100, 'ERROR'],
    [0, 'NORMAL'],
  ] as const)('値が %s のとき %s と判定する（閾値ちょうどは悪い方）', (value, expected) => {
    expect(judgeByCriterion(upper, value)).toBe(expected);
  });
});

describe('下限型の判定', () => {
  it.each([
    [90, 'NORMAL'],
    [89.999, 'CAUTION'],
    [80, 'CAUTION'],
    [79.999, 'ERROR'],
    [100, 'NORMAL'],
    [0, 'ERROR'],
  ] as const)('値が %s のとき %s と判定する（閾値ちょうどは良い方）', (value, expected) => {
    expect(judgeByCriterion(lower, value)).toBe(expected);
  });
});

describe('範囲型の判定', () => {
  it.each([
    [-0.1, 'ERROR'],
    [0, 'CAUTION'],
    [9.9, 'CAUTION'],
    [10, 'NORMAL'],
    [24.9, 'NORMAL'],
    [25, 'CAUTION'],
    [34.9, 'CAUTION'],
    [35, 'ERROR'],
    [80, 'ERROR'],
  ] as const)('温度が %s のとき %s と判定する', (value, expected) => {
    expect(judgeByCriterion(range, value)).toBe(expected);
  });
});

describe('最も悪い判定', () => {
  it('異常があれば異常、注意があれば注意、すべて正常なら正常を返す', () => {
    expect(worstJudgedStatus(['NORMAL', 'ERROR', 'CAUTION'])).toBe('ERROR');
    expect(worstJudgedStatus(['NORMAL', 'CAUTION'])).toBe('CAUTION');
    expect(worstJudgedStatus(['NORMAL', 'NORMAL'])).toBe('NORMAL');
  });

  it('判定が空のときは null を返す', () => {
    expect(worstJudgedStatus([])).toBeNull();
  });
});

describe('短期と長期の組み合わせ', () => {
  it('不明を除いた悪い方を採用する', () => {
    expect(combineHorizonStatuses('NORMAL', 'CAUTION')).toBe('CAUTION');
    expect(combineHorizonStatuses('ERROR', 'NORMAL')).toBe('ERROR');
    expect(combineHorizonStatuses('UNKNOWN', 'NORMAL')).toBe('NORMAL');
    expect(combineHorizonStatuses('CAUTION', 'UNKNOWN')).toBe('CAUTION');
  });

  it('短期評価がない観点は、長期の判定をそのまま採用する', () => {
    expect(combineHorizonStatuses(null, 'ERROR')).toBe('ERROR');
    expect(combineHorizonStatuses(null, 'UNKNOWN')).toBe('UNKNOWN');
  });

  it('両方が不明のときは不明にする', () => {
    expect(combineHorizonStatuses('UNKNOWN', 'UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('数値の補助関数', () => {
  it('分母が 0 のときは null を返し、0 で代用しない', () => {
    expect(divideOrNull(1, 0)).toBeNull();
    expect(percentOrNull(1, 0)).toBeNull();
  });

  it('割り算とパーセントを小数第6位に丸める', () => {
    expect(divideOrNull(1, 3)).toBe(0.333333);
    expect(percentOrNull(1, 3)).toBe(33.333333);
  });

  it('浮動小数点の誤差で境界値が外れないようにする', () => {
    // 100 - (3 / 30 * 100) は、誤差が出うる計算
    expect(normalizeMetric(100 - (3 / 30) * 100)).toBe(90);
    expect(roundTo(3.96, 1)).toBe(4);
    expect(roundTo(3.94, 1)).toBe(3.9);
  });
});
