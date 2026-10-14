import { describe, expect, it } from 'vitest';
import { findItemDefinition, type ItemDefinition } from '../../../src/shared/constants/items.ts';
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

  it('備考: 上限の文字数まで有効。超えるとエラー', () => {
    expect(validateManualEntry(draft({ note: 'あ'.repeat(MAX_NOTE_LENGTH) }), NOW)).toEqual([]);
    expect(
      validateManualEntry(draft({ note: 'あ'.repeat(MAX_NOTE_LENGTH + 1) }), NOW),
    ).toContainEqual({ name: 'note', message: '備考は2000文字以内で入力してください' });
  });
});
