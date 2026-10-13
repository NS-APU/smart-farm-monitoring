import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  ITEM_CATALOG,
  findItemDefinition,
  isValidItemValue,
  itemsOfCategory,
  satisfactionItemKey,
} from '@smart-farm/shared/constants/items';
import {
  formatMetricValue,
  getMetricMeta,
  MISSING_VALUE_TEXT,
} from '@smart-farm/shared/constants/metrics';
import {
  VIEWPOINTS,
  findViewpointMeta,
  viewpointsForEquipmentType,
} from '@smart-farm/shared/constants/viewpoints';
import { AppError, isAppError } from '@smart-farm/shared/errors';
import {
  PASSWORD_MIN_LENGTH,
  PasswordSchema,
  findPasswordPolicyViolation,
} from '@smart-farm/shared/schemas/auth';
import { toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
import {
  CriterionSchema,
  findThresholdOrderViolation,
  validateCriteriaInput,
} from '@smart-farm/shared/schemas/criteria';
import { EquipmentSchema } from '@smart-farm/shared/schemas/equipment';
import { observationKey } from '@smart-farm/shared/schemas/observation';
import { PageQuerySchema } from '@smart-farm/shared/schemas/api';

describe('観点の定義', () => {
  it('10観点を、表示順（収穫精度 → … → 満足度）で持つ', () => {
    expect(VIEWPOINTS.map((viewpoint) => viewpoint.name)).toEqual([
      '収穫精度',
      '収穫速度',
      '環境適応性',
      '操作性',
      'メンテナンス性',
      'コスト効率',
      '安全性',
      'データ活用度合い',
      '耐久性',
      '満足度',
    ]);
  });

  it('設備の種別ごとに、評価する観点を決める', () => {
    expect(viewpointsForEquipmentType('FACILITY')).toHaveLength(10);
    expect(viewpointsForEquipmentType('ROBOT').map((viewpoint) => viewpoint.id)).toEqual([
      'harvestAccuracy',
      'harvestSpeed',
      'operability',
      'maintainability',
      'costEfficiency',
      'safety',
      'durability',
    ]);
    expect(viewpointsForEquipmentType('SENSOR').map((viewpoint) => viewpoint.id)).toEqual([
      'environmentalAdaptability',
    ]);
  });

  it('観点の識別子から観点を引く。存在しなければ undefined', () => {
    expect(findViewpointMeta('safety')?.name).toBe('安全性');
    expect(findViewpointMeta('nothing')).toBeUndefined();
  });
});

describe('データ項目のカタログ', () => {
  it('項目の識別子は重複しない', () => {
    const keys = ITEM_CATALOG.map((item) => item.itemKey);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('すべてのカテゴリに、項目がある', () => {
    for (const category of CATEGORIES) {
      expect(itemsOfCategory(category).length).toBeGreaterThan(0);
    }
  });

  it('満足度の項目は、満足度以外の9観点に対して持つ', () => {
    expect(itemsOfCategory('SATISFACTION')).toHaveLength(9);
    expect(findItemDefinition(satisfactionItemKey('safety'))).toMatchObject({
      min: 1,
      max: 5,
      valueType: 'integer',
    });
  });

  it('項目が見つからなければ undefined', () => {
    expect(findItemDefinition('nothing')).toBeUndefined();
  });

  it.each([
    ['harvestCount', 0, true],
    ['harvestCount', 3, true],
    ['harvestCount', -1, false],
    ['harvestCount', 2.5, false],
    ['humidityPercent', 100, true],
    ['humidityPercent', 100.5, false],
    ['temperatureCelsius', -5.5, true],
    ['temperatureCelsius', Number.NaN, false],
    ['temperatureCelsius', '20', false],
    ['statusCode', 'RUNNING', true],
    ['statusCode', '', false],
    ['statusCode', 1, false],
    [satisfactionItemKey('safety'), 5, true],
    [satisfactionItemKey('safety'), 0, false],
    [satisfactionItemKey('safety'), 6, false],
  ] as const)('%s に %s を入力すると、有効かどうかは %s', (itemKey, value, expected) => {
    const item = findItemDefinition(itemKey);
    if (item === undefined) {
      throw new Error('テストの前提: 項目がカタログにある');
    }

    expect(isValidItemValue(item, value)).toBe(expected);
  });
});

describe('メトリクスの表示', () => {
  it('単位つきで、定義された桁数に整形する', () => {
    expect(formatMetricValue('marketableFruitRatePercent', 90)).toBe('90.0%');
    expect(formatMetricValue('economicProductivity', 1.234)).toBe('1.23');
    expect(formatMetricValue('harvestCount', 12)).toBe('12個');
  });

  it('欠損は「—」で表示する', () => {
    expect(formatMetricValue('mttrHours', null)).toBe(MISSING_VALUE_TEXT);
    expect(formatMetricValue('mttrHours', undefined)).toBe(MISSING_VALUE_TEXT);
  });

  it('定義にない識別子は、識別子をそのままラベルにする', () => {
    expect(getMetricMeta('totallyUnknown')).toEqual({
      label: 'totallyUnknown',
      unit: '',
      fractionDigits: 1,
    });
  });

  it('小数の項目は、カタログの単位から補う', () => {
    expect(getMetricMeta('temperatureCelsius')).toMatchObject({
      label: '温度',
      unit: '℃',
      fractionDigits: 1,
    });
  });
});

describe('判断基準の検証', () => {
  const valid = {
    criteria: [
      {
        indicator: 'a',
        kind: 'UPPER',
        thresholds: { cautionFrom: 5, errorFrom: 10 },
        label: '条件',
      },
    ],
  };

  it('正しい判断基準は、エラーなし', () => {
    expect(validateCriteriaInput(valid)).toEqual([]);
  });

  it.each([
    [
      '上限型: 注意開始値と異常開始値が同じ',
      { kind: 'UPPER', thresholds: { cautionFrom: 10, errorFrom: 10 } },
    ],
    [
      '上限型: 注意開始値が異常開始値より大きい',
      { kind: 'UPPER', thresholds: { cautionFrom: 11, errorFrom: 10 } },
    ],
    [
      '下限型: 異常下限が注意下限以上',
      { kind: 'LOWER', thresholds: { errorBelow: 90, cautionBelow: 80 } },
    ],
    [
      '範囲型: 正常下限が正常上限以上',
      {
        kind: 'RANGE',
        thresholds: { errorLower: 0, normalLower: 30, normalUpper: 20, errorUpper: 40 },
      },
    ],
    [
      '範囲型: 異常下限が正常下限以上',
      {
        kind: 'RANGE',
        thresholds: { errorLower: 10, normalLower: 10, normalUpper: 20, errorUpper: 40 },
      },
    ],
    [
      '範囲型: 正常上限が異常上限以上',
      {
        kind: 'RANGE',
        thresholds: { errorLower: 0, normalLower: 10, normalUpper: 40, errorUpper: 40 },
      },
    ],
  ])('%s は保存できない', (_name, override) => {
    const errors = validateCriteriaInput({
      criteria: [{ indicator: 'a', label: '条件', ...override }],
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.name).toBe('criteria.0.thresholds');
  });

  it('範囲型の正しい組み合わせは保存できる', () => {
    const criterion = {
      indicator: 'a',
      kind: 'RANGE',
      thresholds: { errorLower: 0, normalLower: 10, normalUpper: 25, errorUpper: 35 },
      label: '温度',
    };

    expect(CriterionSchema.safeParse(criterion).success).toBe(true);
    expect(
      findThresholdOrderViolation({
        ...criterion,
        kind: 'RANGE',
        thresholds: criterion.thresholds,
      }),
    ).toBeNull();
  });

  it('数値でない閾値は保存できない', () => {
    const errors = validateCriteriaInput({
      criteria: [
        {
          indicator: 'a',
          kind: 'UPPER',
          thresholds: { cautionFrom: 'x', errorFrom: 10 },
          label: '条件',
        },
      ],
    });

    expect(errors[0]).toMatchObject({
      name: 'criteria.0.thresholds.cautionFrom',
      message: '閾値は数値で指定してください',
    });
  });

  it('条件名が空欄または200文字超なら保存できない', () => {
    const withLabel = (label: string) => ({
      criteria: [
        { indicator: 'a', kind: 'UPPER', thresholds: { cautionFrom: 1, errorFrom: 2 }, label },
      ],
    });

    expect(validateCriteriaInput(withLabel('   '))[0]?.name).toBe('criteria.0.label');
    expect(validateCriteriaInput(withLabel('あ'.repeat(201)))[0]?.name).toBe('criteria.0.label');
    expect(validateCriteriaInput(withLabel('あ'.repeat(200)))).toEqual([]);
  });

  it('条件が0件、または20件を超えるときは保存できない', () => {
    const criterion = valid.criteria[0];

    expect(validateCriteriaInput({ criteria: [] })[0]?.name).toBe('criteria');
    expect(
      validateCriteriaInput({ criteria: Array.from({ length: 20 }, () => criterion) }),
    ).toEqual([]);
    expect(
      validateCriteriaInput({ criteria: Array.from({ length: 21 }, () => criterion) })[0]?.name,
    ).toBe('criteria');
  });
});

describe('パスワードの条件', () => {
  it.each([
    ['Abcdef1', false],
    ['Abcdefg1', true],
    ['abcdefg1', false],
    ['ABCDEFG1', false],
    ['Abcdefgh', false],
    ['', false],
  ] as const)('%s は、条件を満たすかどうか: %s', (password, expected) => {
    expect(findPasswordPolicyViolation(password) === null).toBe(expected);
    expect(PasswordSchema.safeParse(password).success).toBe(expected);
  });

  it(`最低${String(PASSWORD_MIN_LENGTH)}文字を求める`, () => {
    expect(findPasswordPolicyViolation('Ab1')).toContain(String(PASSWORD_MIN_LENGTH));
  });
});

describe('設備・識別子・観測値のスキーマ', () => {
  const base = {
    equipmentId: 'ROBOT-1',
    name: 'ロボット',
    isDeleted: false,
    createdAt: '2026-10-01T00:00:00Z',
  };

  it('ロボット・センサーは親のハウスが必須で、ハウスは親を持てない', () => {
    expect(EquipmentSchema.safeParse({ ...base, equipmentType: 'ROBOT' }).success).toBe(false);
    expect(
      EquipmentSchema.safeParse({ ...base, equipmentType: 'ROBOT', facilityId: 'HOUSE-1' }).success,
    ).toBe(true);
    expect(EquipmentSchema.safeParse({ ...base, equipmentType: 'FACILITY' }).success).toBe(true);
    expect(
      EquipmentSchema.safeParse({ ...base, equipmentType: 'FACILITY', facilityId: 'HOUSE-1' })
        .success,
    ).toBe(false);
  });

  it('名称は必須で、前後の空白は除く', () => {
    expect(
      EquipmentSchema.safeParse({ ...base, equipmentType: 'FACILITY', name: '  ' }).success,
    ).toBe(false);
    expect(
      EquipmentSchema.parse({ ...base, equipmentType: 'FACILITY', name: ' ハウス ' }).name,
    ).toBe('ハウス');
  });

  it('識別子は、英数字・ハイフン・アンダースコアのみで、先頭は英数字', () => {
    expect(toEquipmentId('HOUSE_01-a')).toBe('HOUSE_01-a');
    expect(() => toEquipmentId('-bad')).toThrow();
    expect(() => toEquipmentId('日本語')).toThrow();
    expect(() => toUserId('')).toThrow();
  });

  it('観測値の一意キーは、設備・項目・計測日時・取得元から作る', () => {
    expect(
      observationKey({
        equipmentId: toEquipmentId('ROBOT-1'),
        itemKey: 'harvestCount',
        observedAt: '2026-10-09T01:00:00.000Z',
        source: 'MANUAL',
      }),
    ).toBe('ROBOT-1#harvestCount#2026-10-09T01:00:00.000Z#MANUAL');
  });
});

describe('エラー型とページ分割', () => {
  it('AppError は、コード・メッセージ・項目ごとのエラー・原因を持つ', () => {
    const cause = new Error('原因');
    const error = new AppError('VALIDATION_ERROR', '入力が不正です', {
      fields: [{ name: 'a', message: 'b' }],
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(isAppError(error)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.fields).toEqual([{ name: 'a', message: 'b' }]);
    expect(error.cause).toBe(cause);
    expect(new AppError('NOT_FOUND', 'なし').fields).toEqual([]);
  });

  it('ページ分割の既定は20件で、1〜100件に制限する', () => {
    expect(PageQuerySchema.parse({}).limit).toBe(20);
    expect(PageQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(PageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(PageQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});
