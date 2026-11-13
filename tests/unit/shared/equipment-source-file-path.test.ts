/**
 * 設備のファイルパス（Issue #119。ADR-0023）のスキーマの単体テスト。
 * 設備ごとに、ファイルサーバー（HTTP）の、取得するファイルのパスを持つ（ロボット・センサーだけ。ハウスは持てない）。
 */

import { describe, expect, it } from 'vitest';
import {
  EquipmentCreateRequestSchema,
  EquipmentSchema,
  EquipmentUpdateRequestSchema,
} from '../../../src/shared/schemas/equipment.ts';
import { FilePathSchema } from '../../../src/shared/schemas/file-path.ts';

const ROBOT = {
  equipmentId: 'ROBOT-1',
  equipmentType: 'ROBOT',
  name: 'ロボット 1',
  facilityId: 'HOUSE-1',
} as const;

describe('ファイルパスのスキーマ（共有）', () => {
  it.each([
    '/a.json',
    '/data/robot/latest.json',
    '/data/env.json',
    '/data/env.csv',
    "/a/b'c(d).json",
  ])('%s は、有効', (path) => {
    expect(FilePathSchema.safeParse(path).success).toBe(true);
  });

  it.each([
    ['空', ''],
    ['/ で始まらない', 'data/a.json'],
    ['/ だけ', '/'],
    ['/ で終わる', '/data/'],
    ['上の階層への移動', '/data/../a.json'],
    ['クエリ', '/a.json?x=1'],
    ['フラグメント', '/a.json#x'],
    ['空白', '/data/a b.json'],
    ['% のエスケープ', '/data/%2e%2e/a.json'],
    ['制御文字', '/data/a\nb.json'],
    ['バックスラッシュ', '/data\\a.json'],
    ['500 文字を超える', `/${'a'.repeat(500)}`],
  ])('%s は、無効', (_name, path) => {
    expect(FilePathSchema.safeParse(path).success).toBe(false);
  });
});

describe('設備の登録・修正のファイルパス', () => {
  it('ロボット・センサーは、ファイルパスを持てる（任意）', () => {
    expect(
      EquipmentCreateRequestSchema.parse({ ...ROBOT, sourceFilePath: '/data/robot-1.json' }),
    ).toMatchObject({ sourceFilePath: '/data/robot-1.json' });
    expect(
      EquipmentCreateRequestSchema.parse({ ...ROBOT, equipmentType: 'SENSOR' }).sourceFilePath,
    ).toBeUndefined();
    expect(
      EquipmentUpdateRequestSchema.parse({ name: 'x', sourceFilePath: '/data/a.json' }),
    ).toMatchObject({ sourceFilePath: '/data/a.json' });
  });

  it('ハウスは、ファイルパスを持てない（登録）', () => {
    const result = EquipmentCreateRequestSchema.safeParse({
      equipmentId: 'HOUSE-1',
      equipmentType: 'FACILITY',
      name: 'ハウス',
      sourceFilePath: '/data/house.json',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('sourceFilePath');
  });

  it('不正なファイルパスは、拒否する（登録・修正）', () => {
    expect(
      EquipmentCreateRequestSchema.safeParse({ ...ROBOT, sourceFilePath: 'a.json' }).success,
    ).toBe(false);
    expect(
      EquipmentUpdateRequestSchema.safeParse({ name: 'x', sourceFilePath: '/../a.json' }).success,
    ).toBe(false);
  });

  it('保存済みの設備: ファイルパスは任意。ハウスは持てない', () => {
    const base = { name: 'x', isDeleted: false, createdAt: '2026-11-09T02:00:00.000Z' };

    expect(
      EquipmentSchema.safeParse({
        ...base,
        equipmentId: 'ROBOT-1',
        equipmentType: 'ROBOT',
        facilityId: 'HOUSE-1',
        sourceFilePath: '/a.json',
      }).success,
    ).toBe(true);
    expect(
      EquipmentSchema.safeParse({
        ...base,
        equipmentId: 'HOUSE-1',
        equipmentType: 'FACILITY',
        sourceFilePath: '/a.json',
      }).success,
    ).toBe(false);
  });
});
