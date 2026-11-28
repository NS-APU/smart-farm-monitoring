/**
 * 変更履歴の差分（Issue #190。SC-08-5）の単体テスト。変更前後の値を項目に分け、項目ごとの印（変更・追加・なし）を求める。
 * 入力は、各サービスが記録する before / after の実際の形（設備・ステータスコード・判断基準・ユーザー・閲覧の割り当て・取り込み設定・手動入力）。
 */

import { describe, expect, it } from 'vitest';
import {
  auditFieldsOf,
  diffFields,
  isSameValue,
  type AuditField,
  type FieldOptions,
} from '../../../src/frontend/lib/audit-diff.ts';

const OPTIONS: FieldOptions = {
  labelOf: (key) =>
    ({ name: '名称', intervalMinutes: '取得間隔', userIds: '閲覧できるユーザー' })[key] ?? key,
  elementLabelOf: (parentKey, id) => (parentKey === 'criteria' ? `指標:${id}` : `取り込み元:${id}`),
};
const CRITERIA_OPTIONS: FieldOptions = {
  ...OPTIONS,
  ignoredKeys: ['version', 'isDefault', 'updatedAt', 'updatedBy'],
};

function fields(value: unknown, options: FieldOptions = OPTIONS): AuditField[] {
  const result = auditFieldsOf(value, options);
  if (result === undefined) {
    throw new Error('項目に分けられません');
  }
  return result;
}

function marksOf(before: unknown, after: unknown, options: FieldOptions = OPTIONS) {
  const beforeFields = fields(before, options);
  const afterFields = fields(after, options);
  return {
    before: diffFields('before', beforeFields, afterFields),
    after: diffFields('after', afterFields, beforeFields),
  };
}

const EQUIPMENT = {
  equipmentId: 'ROBOT-01',
  equipmentType: 'ROBOT',
  name: '収穫ロボット1',
  facilityId: 'HOUSE-01',
  sourceFilePath: '/data/robot-01.json',
  intervalMinutes: 1,
  isDeleted: false,
  createdAt: '2026-11-01T00:00:00.000Z',
};

describe('isSameValue（値の比べ方）', () => {
  it('同じ値は同じ。数値と文字列は違う', () => {
    expect(isSameValue('a', 'a')).toBe(true);
    expect(isSameValue(5, 5)).toBe(true);
    expect(isSameValue(5, '5')).toBe(false);
    expect(isSameValue(false, 'false')).toBe(false);
  });

  it('undefined（項目がない）と null は違う。値が undefined のキーは、ないものとして扱う', () => {
    expect(isSameValue(undefined, null)).toBe(false);
    expect(isSameValue(undefined, undefined)).toBe(true);
    expect(isSameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(isSameValue({ a: 1, b: null }, { a: 1 })).toBe(false);
  });

  it('オブジェクトは、深く比べる（キーの順序は無関係）', () => {
    expect(isSameValue({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
    expect(isSameValue({ a: { x: 1, y: 2 } }, { a: { x: 1, y: 3 } })).toBe(false);
    expect(isSameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('文字列・数値だけの配列は、順序を無視して比べる。オブジェクトを含む配列は、順序どおりに比べる', () => {
    expect(isSameValue(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(isSameValue(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(isSameValue(['a'], ['a', 'b'])).toBe(false);
    expect(isSameValue([{ id: 1 }, { id: 2 }], [{ id: 1 }, { id: 2 }])).toBe(true);
    expect(isSameValue([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }])).toBe(false);
  });

  it('UTC の日時の文字列どうしは、時刻として比べる（小数秒の有無を、違いとしない）', () => {
    expect(isSameValue('2026-11-25T01:00:00Z', '2026-11-25T01:00:00.000Z')).toBe(true);
    expect(isSameValue('2026-11-25T01:00:00.000Z', '2026-11-25T01:00:01.000Z')).toBe(false);
    expect(isSameValue('2026-11-25T01:00:00.000Z', 'x')).toBe(false);
  });
});

describe('auditFieldsOf（項目への分割）', () => {
  it('記録は、トップレベルのキーごとの項目にする。値が undefined のキーは、除く', () => {
    const result = fields({ name: '圃場', intervalMinutes: undefined, isDeleted: false });

    expect(result.map((field) => field.key)).toEqual(['name', 'isDeleted']);
    expect(result[0]).toMatchObject({ label: '名称', text: '"name": "圃場"' });
    expect(result[1]?.label).toBe('isDeleted');
  });

  it('画面の呼び方がないキーは、そのキー名を使う', () => {
    expect(fields({ somethingNew: 1 })[0]?.label).toBe('somethingNew');
  });

  it('識別子（indicator・sourceId）を持つオブジェクトの配列は、要素ごとの項目にする（判断基準の指標・取り込み元）', () => {
    const criteria = fields({
      viewpointId: 'harvestAccuracy',
      criteria: [
        { indicator: 'a', kind: 'LOWER', thresholds: { errorBelow: 1, cautionBelow: 2 } },
        { indicator: 'b', kind: 'UPPER', thresholds: { cautionFrom: 1, errorFrom: 2 } },
      ],
    });
    const sources = fields([
      { sourceId: 'robot', isEnabled: true },
      { sourceId: 'environment-sensor', isEnabled: false },
    ]);

    expect(criteria.map((field) => [field.key, field.label])).toEqual([
      ['viewpointId', 'viewpointId'],
      ['criteria[a]', '指標:a'],
      ['criteria[b]', '指標:b'],
    ]);
    expect(sources.map((field) => [field.key, field.label])).toEqual([
      ['robot', '取り込み元:robot'],
      ['environment-sensor', '取り込み元:environment-sensor'],
    ]);
  });

  it('識別子が重なる・欠ける配列は、分けない。文字列の配列も、1 つの項目', () => {
    const duplicated = fields({
      criteria: [
        { indicator: 'a', n: 1 },
        { indicator: 'a', n: 2 },
      ],
    });
    const mixed = fields({ criteria: [{ indicator: 'a' }, { n: 1 }] });
    const strings = fields({ userIds: ['u1', 'u2'] });

    expect(duplicated.map((field) => field.key)).toEqual(['criteria']);
    expect(mixed.map((field) => field.key)).toEqual(['criteria']);
    expect(strings.map((field) => field.key)).toEqual(['userIds']);
  });

  it('記録でも識別子つきの配列でもない値は、undefined（そのまま JSON を示す）', () => {
    expect(auditFieldsOf('text', OPTIONS)).toBeUndefined();
    expect(auditFieldsOf(5, OPTIONS)).toBeUndefined();
    expect(auditFieldsOf(null, OPTIONS)).toBeUndefined();
    expect(auditFieldsOf(['a'], OPTIONS)).toBeUndefined();
  });
});

describe('diffFields（印）', () => {
  it('設備: 変わった項目（名称・取得間隔）だけに「変更」。変更前も同じ項目に付く。変わらない項目には付けない', () => {
    const { before, after } = marksOf(EQUIPMENT, {
      ...EQUIPMENT,
      name: '収穫ロボット2',
      intervalMinutes: 5,
    });

    expect([...before.marks]).toEqual([
      ['name', 'changed'],
      ['intervalMinutes', 'changed'],
    ]);
    expect([...after.marks]).toEqual([
      ['name', 'changed'],
      ['intervalMinutes', 'changed'],
    ]);
    expect(after.changedLabels).toEqual(['名称', '取得間隔']);
    expect(after.addedLabels).toEqual([]);
    expect(after.vanishedLabels).toEqual([]);
  });

  it('変更なし: 印は付かない（日時の表記ゆれ・キーの順序は、違いにしない）', () => {
    const { before, after } = marksOf(EQUIPMENT, {
      createdAt: '2026-11-01T00:00:00Z',
      name: '収穫ロボット1',
      ...Object.fromEntries(
        Object.entries(EQUIPMENT).filter(([key]) => key !== 'createdAt' && key !== 'name'),
      ),
    });

    expect(before.marks.size).toBe(0);
    expect(after.marks.size).toBe(0);
    expect(after.changedLabels).toEqual([]);
  });

  it('追加された項目は、変更後だけに「追加」。なくなった項目は、変更後の側の vanished（「なし」）。変更前には印を付けない', () => {
    const { before, after } = marksOf(
      { equipmentId: 'ROBOT-01', intervalMinutes: 5, sourceFilePath: '/a.json' },
      { equipmentId: 'ROBOT-01', externalId: 'R1', intervalMinutes: 5 },
    );

    expect([...after.marks]).toEqual([['externalId', 'added']]);
    expect(after.vanished.map((field) => field.key)).toEqual(['sourceFilePath']);
    expect(after.addedLabels).toEqual(['externalId']);
    expect(after.vanishedLabels).toEqual(['sourceFilePath']);
    expect(before.marks.size).toBe(0);
    expect(before.vanished).toEqual([]);
  });

  it('ステータスコード: カテゴリだけが変わる（説明が消える）', () => {
    const { after } = marksOf(
      {
        code: 'CHARGING',
        name: '充電中',
        category: 'NORMAL',
        description: '充電',
        isDeleted: false,
      },
      { code: 'CHARGING', name: '充電中', category: 'CAUTION', isDeleted: false },
    );

    expect([...after.marks]).toEqual([['category', 'changed']]);
    expect(after.vanishedLabels).toEqual(['description']);
  });

  it('ユーザー: 名前・ロールの変更と、パスワードの変更（変更後にだけある項目）', () => {
    const user = { userId: 'worker-1', userName: '作業者1', role: 'general' };

    const { after } = marksOf(user, {
      ...user,
      userName: '作業者A',
      role: 'admin',
      passwordChanged: true,
    });

    expect([...after.marks]).toEqual([
      ['userName', 'changed'],
      ['role', 'changed'],
      ['passwordChanged', 'added'],
    ]);
  });

  it('閲覧の割り当て: ユーザーの一覧の順序違いは変更にしない。要素が変われば変更', () => {
    const sameSet = marksOf(
      { facilityId: 'HOUSE-01', userIds: ['u1', 'u2'] },
      { facilityId: 'HOUSE-01', userIds: ['u2', 'u1'] },
    );
    const changed = marksOf(
      { facilityId: 'HOUSE-01', userIds: ['u1', 'u2'] },
      { facilityId: 'HOUSE-01', userIds: ['u1', 'u3'] },
    );

    expect(sameSet.after.marks.size).toBe(0);
    expect([...changed.after.marks]).toEqual([['userIds', 'changed']]);
    expect(changed.after.changedLabels).toEqual(['閲覧できるユーザー']);
  });

  it('取り込み設定: 取り込み元ごと（有効・無効）の項目。変わった取り込み元だけに「変更」', () => {
    const { before, after } = marksOf(
      [
        { sourceId: 'robot', kind: 'ROBOT', profileId: 'p1', isEnabled: true },
        { sourceId: 'environment-sensor', kind: 'SENSOR', profileId: 'p2', isEnabled: true },
      ],
      [
        { sourceId: 'robot', kind: 'ROBOT', profileId: 'p1', isEnabled: true },
        { sourceId: 'environment-sensor', kind: 'SENSOR', profileId: 'p2', isEnabled: false },
      ],
    );

    expect([...before.marks]).toEqual([['environment-sensor', 'changed']]);
    expect([...after.marks]).toEqual([['environment-sensor', 'changed']]);
    expect(after.changedLabels).toEqual(['取り込み元:environment-sensor']);
  });

  it('取り込み設定（接続）: 接続の項目の変更', () => {
    const connection = { protocol: 'HTTPS', host: 'files.example.invalid', authMethod: 'NONE' };

    const { after } = marksOf(connection, { ...connection, port: 8443, authMethod: 'BASIC' });

    expect([...after.marks]).toEqual([
      ['authMethod', 'changed'],
      ['port', 'added'],
    ]);
  });

  it('判断基準: 指標ごとの閾値の変更に印を付ける。版・既定値かどうか・更新日時・更新者は、変わっても印を付けない（表示は残す）', () => {
    const base = {
      viewpointId: 'harvestAccuracy',
      criteria: [
        {
          indicator: 'a',
          kind: 'LOWER',
          thresholds: { errorBelow: 80, cautionBelow: 90 },
          label: 'A',
        },
        {
          indicator: 'b',
          kind: 'UPPER',
          thresholds: { cautionFrom: 5, errorFrom: 10 },
          label: 'B',
        },
      ],
      version: 'DEFAULT',
      isDefault: true,
    };
    const next = {
      ...base,
      criteria: [
        {
          indicator: 'a',
          kind: 'LOWER',
          thresholds: { errorBelow: 80, cautionBelow: 92 },
          label: 'A',
        },
        base.criteria[1],
      ],
      version: 'CUSTOM-1',
      isDefault: false,
      updatedAt: '2026-11-25T01:00:00.000Z',
      updatedBy: 'admin-1',
    };

    const { before, after } = marksOf(base, next, CRITERIA_OPTIONS);

    expect([...before.marks]).toEqual([['criteria[a]', 'changed']]);
    expect([...after.marks]).toEqual([['criteria[a]', 'changed']]);
    expect(after.changedLabels).toEqual(['指標:a']);
    expect(after.addedLabels).toEqual([]);
    expect(
      fields(next, CRITERIA_OPTIONS)
        .filter((field) => field.ignored === true)
        .map((field) => field.key),
    ).toEqual(['version', 'isDefault', 'updatedAt', 'updatedBy']);
  });

  it('判断基準: 指標が増えた・減った場合は、追加・なし', () => {
    const one = { criteria: [{ indicator: 'a', thresholds: { x: 1 } }] };
    const two = {
      criteria: [
        { indicator: 'a', thresholds: { x: 1 } },
        { indicator: 'b', thresholds: { x: 2 } },
      ],
    };

    const added = marksOf(one, two).after;
    const removed = marksOf(two, one).after;

    expect([...added.marks]).toEqual([['criteria[b]', 'added']]);
    expect(removed.vanished.map((field) => field.key)).toEqual(['criteria[b]']);
  });

  it('手動入力の項目（item:）と、計測日時・設備・カテゴリ・備考（meta:）を、項目単位で比べる', () => {
    const entry = (items: Record<string, number | string>, observedAt: string): AuditField[] => [
      ...Object.entries(items).map(([key, value]) => ({
        key: `item:${key}`,
        label: key,
        value,
        text: String(value),
      })),
      { key: 'meta:observedAt', label: '計測日時', value: observedAt, text: observedAt },
    ];

    const before = entry({ a: 1, b: 2 }, '2026-11-25T01:00:00.000Z');
    const after = entry({ a: 1, b: 3, c: 4 }, '2026-11-25T01:00:00Z');
    const result = diffFields('after', after, before);

    expect([...result.marks]).toEqual([
      ['item:b', 'changed'],
      ['item:c', 'added'],
    ]);
    expect(diffFields('after', before, after).vanished.map((field) => field.key)).toEqual([
      'item:c',
    ]);
  });
});
