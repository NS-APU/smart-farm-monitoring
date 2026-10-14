import { describe, expect, it } from 'vitest';
import { CriterionSchema, findThresholdRangeViolation } from '@smart-farm/shared/schemas/criteria';

const upper = (indicator: string, cautionFrom: number, errorFrom: number) => ({
  indicator,
  kind: 'UPPER' as const,
  thresholds: { cautionFrom, errorFrom },
  label: '条件',
});
const lower = (indicator: string, errorBelow: number, cautionBelow: number) => ({
  indicator,
  kind: 'LOWER' as const,
  thresholds: { errorBelow, cautionBelow },
  label: '条件',
});

describe('判断基準の閾値の範囲（V-028）', () => {
  it('率（%）の指標の閾値は、0〜100 の範囲で、保存できる（境界を含む）', () => {
    expect(CriterionSchema.safeParse(lower('marketableFruitRatePercent', 0, 100)).success).toBe(
      true,
    );
    expect(CriterionSchema.safeParse(upper('missedFruitRatePercent', 5, 10)).success).toBe(true);
  });

  it.each([
    ['異常下限が負（常に異常にならない）', lower('marketableFruitRatePercent', -10, 80)],
    ['上限が 100 を超える', upper('missedFruitRatePercent', 5, 150)],
    ['湿度（%）の上限が 100 を超える', upper('humidityPercent', 80, 150)],
  ])('%s基準は、保存できない（範囲の理由を返す）', (_name, criterion) => {
    const result = CriterionSchema.safeParse(criterion);

    expect(result.success).toBe(false);
    expect(findThresholdRangeViolation(criterion)).toContain('0〜100');
  });

  it('率以外の指標（時間・環境の値）は、範囲を検証しない。大小関係の検証は、従来どおり', () => {
    expect(CriterionSchema.safeParse(upper('mttrHours', 2, 500)).success).toBe(true);
    expect(CriterionSchema.safeParse(upper('temperatureCelsius', 35, 45)).success).toBe(true);
    expect(CriterionSchema.safeParse(upper('mttrHours', 5, 2)).success).toBe(false);
  });
});
