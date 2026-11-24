/**
 * 未登録のコード値（SC-12-5。ADR-0017 の D-23。Issue #158）の、純粋な規則の単体テスト。
 * 集計（不正の品質のステータスコードの観測値だけ）・100 文字で切る・記録の上限・登録できる形式の判定・初期値の案（正規化）。
 */

import { describe, expect, it } from 'vitest';
import {
  UNREGISTERED_CODES_MAX_NEW_PER_RUN,
  UNREGISTERED_CODES_MAX_TOTAL,
  countUnregisteredStatusCodes,
  isRegistrableStatusCode,
  isUnregisteredStatusCode,
  planUnregisteredRecording,
  suggestStatusCode,
  truncateStatusCodeValue,
} from '../../../../src/backend/domain/unregistered-status-code.ts';
import { observation, statusCodeMap } from '../../../support/builders.ts';

const invalidCode = (value: string | number | null, overrides = {}) =>
  observation({ itemKey: 'statusCode', value, quality: 'INVALID', ...overrides });

describe('isUnregisteredStatusCode（定義がない、または論理削除されたコード値）', () => {
  it('登録済みは未登録でない。定義がない値と、論理削除したコード値は、未登録', () => {
    const codes = statusCodeMap();
    codes.set('GONE', { code: 'GONE', name: '削除済み', category: 'NORMAL', isDeleted: true });

    expect(isUnregisteredStatusCode('RUNNING', codes)).toBe(false);
    expect(isUnregisteredStatusCode('NO_SUCH_CODE', codes)).toBe(true);
    expect(isUnregisteredStatusCode('GONE', codes)).toBe(true);
  });
});

describe('truncateStatusCodeValue（100 文字で切る）', () => {
  it('100 文字以内は、そのまま。超える分は切る（文字単位。サロゲートペアを割らない）', () => {
    expect(truncateStatusCodeValue('A'.repeat(100))).toBe('A'.repeat(100));
    expect(truncateStatusCodeValue('A'.repeat(101))).toBe('A'.repeat(100));
    const emoji = '😀'.repeat(101);
    expect(Array.from(truncateStatusCodeValue(emoji))).toHaveLength(100);
  });

  it('対になっていないサロゲートは、置換文字にする（保存できない文字を、残さない）', () => {
    expect(truncateStatusCodeValue('A\ud800B')).toBe('A�B');
  });
});

describe('countUnregisteredStatusCodes（保存した不正のステータスコードの観測値だけを、コード値ごとに数える）', () => {
  it('不正で、定義にないコード値だけを数える。登録済み・数値・欠損・ほかの項目・有効な観測値は、数えない', () => {
    const counts = countUnregisteredStatusCodes(
      [
        invalidCode('ERR_X'),
        invalidCode('ERR_X', { observedAt: '2026-10-09T02:15:00.000Z' }),
        invalidCode('ERR_Y'),
        // 登録済みのコード値が不正になる理由（計測日時が未来）は、対象外
        invalidCode('RUNNING'),
        invalidCode(42),
        invalidCode(null),
        observation({ itemKey: 'statusCode', value: 'ERR_Z', quality: 'VALID' }),
        observation({ itemKey: 'harvestCount', value: -3, quality: 'INVALID' }),
      ],
      statusCodeMap(),
    );

    expect(Object.fromEntries(counts)).toEqual({ ERR_X: 2, ERR_Y: 1 });
  });

  it('100 文字で切ったあとのコード値で、数える。空の値は、記録しない', () => {
    const counts = countUnregisteredStatusCodes(
      [invalidCode(`${'A'.repeat(100)}1`), invalidCode(`${'A'.repeat(100)}2`), invalidCode('')],
      statusCodeMap(),
    );

    expect(Object.fromEntries(counts)).toEqual({ ['A'.repeat(100)]: 2 });
  });
});

describe('planUnregisteredRecording（記録の上限）', () => {
  const counts = (entries: Record<string, number>) => new Map(Object.entries(entries));
  const codesOf = (plan: ReturnType<typeof planUnregisteredRecording>) =>
    plan.increments.map((entry) => entry.code);

  it('上限は、1 回の取り込みで新しい値 20 種類・全体で 50 件', () => {
    expect(UNREGISTERED_CODES_MAX_NEW_PER_RUN).toBe(20);
    expect(UNREGISTERED_CODES_MAX_TOTAL).toBe(50);
  });

  it('上限の内なら、すべて記録する（件数つき）', () => {
    const plan = planUnregisteredRecording(counts({ A: 2, B: 1 }), new Set());

    expect(plan.increments).toEqual([
      { code: 'A', count: 2 },
      { code: 'B', count: 1 },
    ]);
    expect(plan.skippedKinds).toBe(0);
  });

  it('1 回の取り込みで新しく記録するのは、20 種類まで。件数の多い順（同じなら、コード値の順）に選び、残りは記録しない', () => {
    const entries: Record<string, number> = {};
    for (let index = 0; index < 25; index += 1) {
      entries[`CODE_${String(index).padStart(2, '0')}`] = index === 24 ? 9 : 1;
    }

    const plan = planUnregisteredRecording(counts(entries), new Set());

    expect(plan.increments).toHaveLength(20);
    expect(codesOf(plan)[0]).toBe('CODE_24');
    expect(codesOf(plan)).not.toContain('CODE_20');
    expect(plan.skippedKinds).toBe(5);
  });

  it('全体で 50 件に達していれば、新しい値は記録しない。すでにある値の件数の加算は、続ける', () => {
    const recorded = new Set(
      Array.from({ length: 50 }, (_unused, index) => `OLD_${String(index)}`),
    );

    const plan = planUnregisteredRecording(counts({ NEW_1: 3, OLD_7: 2 }), recorded);

    expect(plan.increments).toEqual([{ code: 'OLD_7', count: 2 }]);
    expect(plan.skippedKinds).toBe(1);
  });

  it('全体の残りが 20 より少ないときは、残りの数まで', () => {
    const recorded = new Set(
      Array.from({ length: 48 }, (_unused, index) => `OLD_${String(index)}`),
    );

    const plan = planUnregisteredRecording(counts({ A: 1, B: 2, C: 3 }), recorded);

    expect(codesOf(plan)).toEqual(['C', 'B']);
    expect(plan.skippedKinds).toBe(1);
  });

  it('すでにある値は、新しい値の上限（20 種類）に数えない', () => {
    const recorded = new Set(['OLD_A', 'OLD_B']);
    const entries: Record<string, number> = { OLD_A: 1, OLD_B: 1 };
    for (let index = 0; index < 20; index += 1) {
      entries[`NEW_${String(index).padStart(2, '0')}`] = 1;
    }

    const plan = planUnregisteredRecording(counts(entries), recorded);

    expect(plan.increments).toHaveLength(22);
    expect(plan.skippedKinds).toBe(0);
  });

  it('記録するものがなければ、空', () => {
    expect(planUnregisteredRecording(new Map(), new Set())).toEqual({
      increments: [],
      skippedKinds: 0,
    });
  });
});

describe('登録できる形式と、登録ダイアログの初期値の案', () => {
  it.each([
    ['ERR_01', true],
    ['A', true],
    ['err_01', false],
    ['1ERR', false],
    ['_ERR', false],
    ['ERR-01', false],
    ['ERR 01', false],
    ['エラー', false],
    ['A'.repeat(101), false],
  ])('登録できる形式か: %s → %s', (code, expected) => {
    expect(isRegistrableStatusCode(code)).toBe(expected);
  });

  it.each([
    ['ERR_01', 'ERR_01'],
    ['err_01', 'ERR_01'],
    ['  Low Battery ', 'LOW_BATTERY'],
    ['low-battery', 'LOW_BATTERY'],
    ['stop.mode', 'STOP_MODE'],
    ['low  --  battery', 'LOW_BATTERY'],
  ])(
    '変換できる値は、大文字化・空白と区切り記号の置き換えで、初期値の案にする: %s → %s',
    (code, expected) => {
      expect(suggestStatusCode(code)).toBe(expected);
    },
  );

  it.each([
    ['1ERR'],
    ['_'],
    ['エラー'],
    ['ERR#1'],
    ['   '],
    ['A'.repeat(99) + '-' + 'B'.repeat(5)],
  ])(
    '変換できない値は、案がない（先頭が数字・記号だけ・日本語・使えない記号・変換後に 100 文字を超える）: %s',
    (code) => {
      expect(suggestStatusCode(code)).toBeUndefined();
    },
  );
});
