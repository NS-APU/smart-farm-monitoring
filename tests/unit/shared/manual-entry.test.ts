import { describe, expect, it } from 'vitest';
import {
  findItemDefinition,
  itemsOfCategory,
  type ItemDefinition,
} from '../../../src/shared/constants/items.ts';
import { FUTURE_TOLERANCE_MINUTES, MAX_NOTE_LENGTH } from '../../../src/shared/constants/limits.ts';
import {
  describeRange,
  findItemValueViolation,
  manualItemsOfCategory,
  validateManualEntry,
  type ManualEntryDraft,
} from '../../../src/shared/schemas/manual-entry.ts';

const NOW = new Date('2026-10-09T03:00:00.000Z');

function draft(overrides: Partial<ManualEntryDraft> = {}): ManualEntryDraft {
  return {
    equipmentId: 'ROBOT-01',
    category: 'FAILURE',
    observedAt: '2026-10-09T02:00:00.000Z',
    items: { failureCount: 2 },
    note: '',
    ...overrides,
  };
}

function names(errors: readonly { name: string }[]): string[] {
  return errors.map((error) => error.name);
}

function item(key: string) {
  const found = findItemDefinition(key);
  if (found === undefined) {
    throw new Error(`項目がありません: ${key}`);
  }
  return found;
}

describe('manualItemsOfCategory', () => {
  it('カテゴリの項目のうち、手動入力できる項目だけを返す', () => {
    const keys = manualItemsOfCategory('FAILURE').map((definition) => definition.itemKey);
    expect(keys).toContain('failureCount');
    for (const definition of manualItemsOfCategory('ENVIRONMENT')) {
      expect(definition.origins).toContain('MANUAL');
    }
  });
});

describe('describeRange（入力できる値の説明）', () => {
  it('下限だけの整数・数値、下限と上限のある整数を説明する', () => {
    expect(describeRange(item('operationStepCount'))).toBe('0以上の整数');
    expect(describeRange(item('operationMinutes'))).toBe('0以上の数値');
    expect(describeRange({ ...item('operationStepCount'), min: 1, max: 5 })).toBe(
      '1以上5以下の整数',
    );
  });

  it('環境情報の項目は、データとして許容する範囲（上限・下限）を説明する（D-10）', () => {
    expect(describeRange(item('temperatureCelsius'))).toBe('-50以上100以下の数値');
    expect(describeRange(item('humidityPercent'))).toBe('0以上100以下の数値');
    expect(describeRange(item('illuminanceLux'))).toBe('0以上200000以下の数値');
    expect(describeRange(item('co2Ppm'))).toBe('0以上10000以下の数値');
  });

  it('範囲がなければ、型だけを説明する', () => {
    const full = item('operationStepCount');
    const withoutMin: ItemDefinition = {
      itemKey: full.itemKey,
      category: full.category,
      label: full.label,
      unit: full.unit,
      valueType: full.valueType,
      aggregation: full.aggregation,
      origins: full.origins,
    };
    expect(describeRange(withoutMin)).toBe('整数');
    expect(describeRange({ ...withoutMin, valueType: 'number' })).toBe('数値');
  });
});

describe('findItemValueViolation', () => {
  it('正しい値は null。不正な値は、項目名と値の説明を含む理由を返す', () => {
    expect(findItemValueViolation(item('operationStepCount'), 3)).toBeNull();
    expect(findItemValueViolation(item('operationStepCount'), -1)).toBe(
      '操作ステップ数は0以上の整数で指定してください',
    );
    expect(findItemValueViolation(item('operationStepCount'), 1.5)).not.toBeNull();
  });
});

describe('validateManualEntry（手動入力の検証）', () => {
  it('正しい入力は、エラーなし', () => {
    expect(validateManualEntry(draft(), NOW)).toEqual([]);
  });

  it('必須の項目（設備・カテゴリ・計測日時・項目の値）が空なら、それぞれのエラーを返す', () => {
    const errors = validateManualEntry(
      draft({ equipmentId: ' ', category: '', observedAt: '', items: {} }),
      NOW,
    );
    expect(names(errors).sort()).toEqual(['category', 'equipmentId', 'items', 'observedAt']);
  });

  it('手動入力できないカテゴリ（稼働情報・不明な値）は、エラー', () => {
    expect(validateManualEntry(draft({ category: 'OPERATION', items: {} }), NOW)).toContainEqual({
      name: 'category',
      message: 'このカテゴリは手動で入力できません',
    });
    expect(
      names(validateManualEntry(draft({ category: 'UNKNOWN', items: { failureCount: 1 } }), NOW)),
    ).toContain('category');
  });

  it('計測日時: 形式が不正ならエラー。未来は許容（5分）を超えるとエラーで、許容の範囲内なら有効', () => {
    expect(validateManualEntry(draft({ observedAt: 'invalid' }), NOW)).toContainEqual({
      name: 'observedAt',
      message: '計測日時の形式が正しくありません',
    });
    const limit = new Date(NOW.getTime() + FUTURE_TOLERANCE_MINUTES * 60_000);
    expect(validateManualEntry(draft({ observedAt: limit.toISOString() }), NOW)).toEqual([]);
    const over = new Date(limit.getTime() + 1);
    expect(validateManualEntry(draft({ observedAt: over.toISOString() }), NOW)).toContainEqual({
      name: 'observedAt',
      message: '計測日時に未来の日時は指定できません',
    });
  });

  it('項目: カテゴリに含まれない項目・存在しない項目は、エラー。カテゴリが不明な場合は、項目を指定できない旨', () => {
    const wrongCategory = validateManualEntry(draft({ items: { operationStepCount: 1 } }), NOW);
    expect(wrongCategory).toContainEqual({
      name: 'items.operationStepCount',
      message: 'この項目は「故障情報」に含まれません',
    });
    const unknownItem = validateManualEntry(draft({ items: { noSuchItem: 1 } }), NOW);
    expect(names(unknownItem)).toEqual(['items.noSuchItem']);
    const noCategory = validateManualEntry(
      draft({ category: '', items: { failureCount: 1 } }),
      NOW,
    );
    expect(noCategory).toContainEqual({
      name: 'items.failureCount',
      message: '項目を指定できません',
    });
  });

  it('項目の値が、型・範囲に合わなければ、項目ごとにエラー', () => {
    const errors = validateManualEntry(draft({ items: { failureCount: -1 } }), NOW);
    expect(names(errors)).toEqual(['items.failureCount']);
    expect(validateManualEntry(draft({ items: { failureCount: 'abc' } }), NOW)).toHaveLength(1);
  });

  describe('環境情報の値の範囲（D-10。範囲外は保存できない。境界値は有効）', () => {
    const environment = (items: Record<string, number>) =>
      validateManualEntry(draft({ category: 'ENVIRONMENT', items }), NOW);

    it.each([
      ['temperatureCelsius', -50, 100],
      ['humidityPercent', 0, 100],
      ['illuminanceLux', 0, 200_000],
      ['co2Ppm', 0, 10_000],
    ] as const)('%s: 下限（%d）・上限（%d）は有効', (key, min, max) => {
      expect(environment({ [key]: min })).toEqual([]);
      expect(environment({ [key]: max })).toEqual([]);
    });

    it.each([
      ['temperatureCelsius', -50.1, '温度は-50以上100以下の数値で指定してください'],
      ['temperatureCelsius', 100.1, '温度は-50以上100以下の数値で指定してください'],
      ['illuminanceLux', -1, '照度は0以上200000以下の数値で指定してください'],
      ['illuminanceLux', 200_001, '照度は0以上200000以下の数値で指定してください'],
      ['co2Ppm', -1, 'CO2濃度は0以上10000以下の数値で指定してください'],
      ['co2Ppm', 10_001, 'CO2濃度は0以上10000以下の数値で指定してください'],
    ] as const)('%s: 範囲外の値（%d）は、範囲を示すエラー', (key, value, message) => {
      expect(environment({ [key]: value })).toEqual([{ name: `items.${key}`, message }]);
    });
  });

  describe('満足度（D-18: 9観点すべてが必須）', () => {
    const allKeys = itemsOfCategory('SATISFACTION').map((definition) => definition.itemKey);
    const fullItems = Object.fromEntries(allKeys.map((key) => [key, 4]));

    it('9観点がすべて揃っていれば、エラーなし', () => {
      expect(
        validateManualEntry(draft({ category: 'SATISFACTION', items: fullItems }), NOW),
      ).toEqual([]);
    });

    it('一部の観点だけの入力は、入力のない観点ごとに、選択を求めるエラー', () => {
      const partial = Object.fromEntries(
        Object.entries(fullItems).filter(([key]) => key !== 'satisfaction.safety'),
      );
      expect(validateManualEntry(draft({ category: 'SATISFACTION', items: partial }), NOW)).toEqual(
        [{ name: 'items.satisfaction.safety', message: '満足度（安全性）を選択してください' }],
      );
    });

    it('観点が1つも入力されていなければ、9観点すべてのエラーと、項目のエラー', () => {
      const errors = validateManualEntry(draft({ category: 'SATISFACTION', items: {} }), NOW);
      expect(names(errors).sort()).toEqual(
        ['items', ...allKeys.map((key) => `items.${key}`)].sort(),
      );
    });

    it('揃っていても、範囲外の値（0・6）は、その観点のエラー', () => {
      const errors = validateManualEntry(
        draft({
          category: 'SATISFACTION',
          items: { ...fullItems, 'satisfaction.safety': 0, 'satisfaction.durability': 6 },
        }),
        NOW,
      );
      expect(names(errors)).toEqual(['items.satisfaction.safety', 'items.satisfaction.durability']);
    });

    it('満足度以外のカテゴリには、全項目の必須を課さない', () => {
      expect(
        validateManualEntry(draft({ category: 'FAILURE', items: { failureCount: 1 } }), NOW),
      ).toEqual([]);
    });
  });

  it('備考: 上限の文字数まで有効。超えるとエラー', () => {
    expect(validateManualEntry(draft({ note: 'あ'.repeat(MAX_NOTE_LENGTH) }), NOW)).toEqual([]);
    expect(
      validateManualEntry(draft({ note: 'あ'.repeat(MAX_NOTE_LENGTH + 1) }), NOW),
    ).toContainEqual({ name: 'note', message: '備考は2000文字以内で入力してください' });
  });
});
