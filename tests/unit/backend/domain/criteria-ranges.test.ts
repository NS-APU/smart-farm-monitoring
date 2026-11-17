import { describe, expect, it } from 'vitest';
import { findThresholdSliderRange } from '../../../../src/shared/constants/criteria-ranges.ts';
import { VIEWPOINT_IDS } from '../../../../src/shared/constants/viewpoints.ts';
import { getDefaultCriteria } from '../../../../src/backend/domain/evaluation/default-criteria.ts';

/**
 * 判断基準の編集（SC-13）のスライダーの範囲の目安（Issue #358）が、すべての既定の判断基準の指標を覆い、
 * 既定の閾値が範囲に収まること。新しい指標・既定値を足したときに、範囲の定義の漏れ・ずれに気づくための確認。
 */
describe('スライダーの範囲の目安は、すべての既定の判断基準を覆う', () => {
  const cases = VIEWPOINT_IDS.flatMap((viewpointId) =>
    getDefaultCriteria(viewpointId).criteria.map(
      (criterion) =>
        [viewpointId, criterion.indicator, Object.values(criterion.thresholds)] as const,
    ),
  );

  it('既定の判断基準の指標は、観点をまたいで、重複を除いて 1 つ以上ある（確認の前提）', () => {
    expect(new Set(cases.map(([, indicator]) => indicator)).size).toBeGreaterThanOrEqual(19);
  });

  it.each(cases)(
    '%s の %s: 範囲があり、既定の閾値が、範囲に収まる',
    (_viewpointId, indicator, values) => {
      const range = findThresholdSliderRange(indicator);

      expect(range, `${indicator} の範囲の目安がありません`).toBeDefined();
      if (range === undefined) {
        return;
      }
      expect(range.min).toBeLessThan(range.max);
      expect(range.step).toBeGreaterThan(0);
      for (const value of values) {
        expect(value).toBeGreaterThanOrEqual(range.min);
        expect(value).toBeLessThanOrEqual(range.max);
      }
    },
  );

  it('範囲の目安がない指標は、undefined を返す', () => {
    expect(findThresholdSliderRange('unknownMetric')).toBeUndefined();
  });
});
