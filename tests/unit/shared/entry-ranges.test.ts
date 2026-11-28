import { describe, expect, it } from 'vitest';
import { findEntrySliderRange } from '../../../src/shared/constants/entry-ranges.ts';
import { manualMaxOf } from '../../../src/shared/constants/items.ts';
import { MANUAL_INPUT_CATEGORIES, itemsOfCategory } from '../../../src/shared/constants/items.ts';

/**
 * データ入力のスライダーの範囲の目安（Issue #361）が、手動入力できる数値の項目をすべて覆い、
 * 保存できる範囲（最小・手動入力の上限）と、食い違わないこと。項目を足したときの、定義の漏れ・ずれを検出する。
 */
describe('データ入力のスライダーの範囲の目安', () => {
  const numeric = MANUAL_INPUT_CATEGORIES.flatMap((category) =>
    itemsOfCategory(category).filter(
      (item) => item.origins.includes('MANUAL') && item.valueType !== 'string',
    ),
  ).filter((item) => item.category !== 'SATISFACTION');

  it('確認の前提: 手動入力できる数値の項目（満足度を除く）が、複数ある', () => {
    expect(numeric.length).toBeGreaterThanOrEqual(20);
  });

  it.each(numeric.map((item) => [item.itemKey, item] as const))(
    '%s: 範囲の目安があり、保存できる範囲に収まる。整数の項目の目盛りは整数',
    (_key, item) => {
      const range = findEntrySliderRange(item.itemKey);

      expect(range, `${item.itemKey} の範囲の目安がありません`).toBeDefined();
      if (range === undefined) {
        return;
      }
      expect(range.min).toBeLessThan(range.max);
      expect(range.step).toBeGreaterThan(0);
      if (item.min !== undefined) {
        expect(range.min).toBeGreaterThanOrEqual(item.min);
      }
      const limit = manualMaxOf(item);
      if (limit !== undefined) {
        expect(range.max).toBeLessThanOrEqual(limit);
      }
      if (item.valueType === 'integer') {
        expect(Number.isInteger(range.step)).toBe(true);
      }
    },
  );

  it('数値でない項目（ステータスコード・満足度）は、範囲の目安を持たない', () => {
    expect(findEntrySliderRange('statusCode')).toBeUndefined();
    expect(findEntrySliderRange('satisfaction.safety')).toBeUndefined();
  });
});
