/**
 * 設備のファイルパス（Issue #119。ADR-0023）の結合テスト。
 * 設備（ロボット・センサー）ごとに、ファイルサーバー（HTTP）の、取得するファイルのパスを持つ。
 * ハウスは持てない。同じ種別の設備の中で、重複を登録できない。変更履歴に残す。
 */

import { describe, expect, it } from 'vitest';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import { EquipmentSchema } from '@smart-farm/shared/schemas/equipment';
import { createTestContext, errorOf, type TestContext } from '../support/test-context.ts';

function send(context: TestContext, method: string, path: string, body?: unknown) {
  return context.request(path, { method, ...(body === undefined ? {} : { body }) });
}

const HOUSE = { equipmentId: 'HOUSE-F1', equipmentType: 'FACILITY', name: 'ハウス' };

async function setup(): Promise<TestContext> {
  const context = await createTestContext();
  expect((await send(context, 'POST', '/equipment', HOUSE)).status).toBe(201);
  return context;
}

function child(equipmentType: 'ROBOT' | 'SENSOR', id: string, extra: Record<string, unknown> = {}) {
  return { equipmentId: id, equipmentType, name: id, facilityId: 'HOUSE-F1', ...extra };
}

describe('登録', () => {
  it('ロボット・センサーに、ファイルパスを指定して登録できる。応答・一覧に含まれる。ファイルパスは、任意', async () => {
    const context = await setup();

    const robot = await send(
      context,
      'POST',
      '/equipment',
      child('ROBOT', 'ROBOT-F1', { sourceFilePath: '/data/robot-f1.json', externalId: 'R-F1' }),
    );
    const sensor = await send(context, 'POST', '/equipment', child('SENSOR', 'SENSOR-F1'));

    expect([robot.status, sensor.status]).toEqual([201, 201]);
    expect(EquipmentSchema.parse(await robot.json()).sourceFilePath).toBe('/data/robot-f1.json');
    const tree = (await (await send(context, 'GET', '/equipment')).json()) as {
      facilities: { children: { equipmentId: string; sourceFilePath?: string }[] }[];
    };
    const children = tree.facilities[0]?.children ?? [];
    expect(children.find((item) => item.equipmentId === 'ROBOT-F1')?.sourceFilePath).toBe(
      '/data/robot-f1.json',
    );
    expect(
      children.find((item) => item.equipmentId === 'SENSOR-F1')?.sourceFilePath,
    ).toBeUndefined();
  });

  it('変更履歴に、ファイルパスを残す', async () => {
    const context = await setup();

    await send(
      context,
      'POST',
      '/equipment',
      child('ROBOT', 'ROBOT-F1', { sourceFilePath: '/data/robot-f1.json' }),
    );

    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?targetType=equipment')).json(),
    );
    expect(JSON.stringify(audit.items[0]?.after)).toContain('/data/robot-f1.json');
  });

  it.each([
    ['/ で始まらない', 'data/a.json'],
    ['上の階層への移動', '/data/../a.json'],
    ['クエリを含む', '/a.json?x=1'],
    ['空白を含む', '/data/a b.json'],
    ['500 文字を超える', `/${'a'.repeat(500)}`],
  ])('不正なファイルパス（%s）は、400。登録しない', async (_name, path) => {
    const context = await setup();

    const response = await send(
      context,
      'POST',
      '/equipment',
      child('ROBOT', 'ROBOT-F1', { sourceFilePath: path }),
    );

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((field) => field.name)).toContain(
      'sourceFilePath',
    );
    const tree = (await (await send(context, 'GET', '/equipment')).json()) as {
      facilities: { children: unknown[] }[];
    };
    expect(tree.facilities[0]?.children).toHaveLength(0);
  });

  it('ハウスには、指定できない（400）', async () => {
    const context = await createTestContext();

    const response = await send(context, 'POST', '/equipment', {
      ...HOUSE,
      sourceFilePath: '/data/house.json',
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((field) => field.name)).toContain(
      'sourceFilePath',
    );
  });

  it('同じ種別の設備の中で、同じファイルパスは、重複して登録できない（409）。種別が違えば、登録できる。削除した設備の分は、重複としない', async () => {
    const context = await setup();
    await send(
      context,
      'POST',
      '/equipment',
      child('ROBOT', 'ROBOT-F1', { sourceFilePath: '/data/shared.json' }),
    );

    const duplicated = await send(
      context,
      'POST',
      '/equipment',
      child('ROBOT', 'ROBOT-F2', { sourceFilePath: '/data/shared.json' }),
    );
    const otherType = await send(
      context,
      'POST',
      '/equipment',
      child('SENSOR', 'SENSOR-F1', { sourceFilePath: '/data/shared.json' }),
    );
    await send(context, 'DELETE', '/equipment/ROBOT-F1');
    const afterDelete = await send(
      context,
      'POST',
      '/equipment',
      child('ROBOT', 'ROBOT-F3', { sourceFilePath: '/data/shared.json' }),
    );

    expect(duplicated.status).toBe(409);
    expect((await errorOf(duplicated)).fields?.map((field) => field.name)).toContain(
      'sourceFilePath',
    );
    expect(otherType.status).toBe(201);
    expect(afterDelete.status).toBe(201);
  });
});

describe('修正', () => {
  it('ファイルパスを、設定・変更・解除できる（省略は、解除）。自分自身と同じ値は、重複としない', async () => {
    const context = await setup();
    await send(context, 'POST', '/equipment', child('ROBOT', 'ROBOT-F1'));
    const update = (extra: Record<string, unknown>, name = 'ロボット 2') =>
      send(context, 'PUT', '/equipment/ROBOT-F1', { name, facilityId: 'HOUSE-F1', ...extra });

    const set = await update({ sourceFilePath: '/data/a.json' }, 'ロボット');
    const same = await update({ sourceFilePath: '/data/a.json' });
    const changed = await update({ sourceFilePath: '/data/b.json' });
    const cleared = await update({});

    expect([set.status, same.status, changed.status, cleared.status]).toEqual([200, 200, 200, 200]);
    expect(EquipmentSchema.parse(await changed.json()).sourceFilePath).toBe('/data/b.json');
    expect(EquipmentSchema.parse(await cleared.json()).sourceFilePath).toBeUndefined();
  });

  it('ほかの設備と重複するファイルパス（同じ種別）は、409', async () => {
    const context = await setup();
    await send(
      context,
      'POST',
      '/equipment',
      child('ROBOT', 'ROBOT-F1', { sourceFilePath: '/data/a.json' }),
    );
    await send(context, 'POST', '/equipment', child('ROBOT', 'ROBOT-F2'));

    const response = await send(context, 'PUT', '/equipment/ROBOT-F2', {
      name: 'ロボット',
      facilityId: 'HOUSE-F1',
      sourceFilePath: '/data/a.json',
    });

    expect(response.status).toBe(409);
  });

  it('ハウスには、指定できない（400）。不正なファイルパスも、400', async () => {
    const context = await setup();
    await send(context, 'POST', '/equipment', child('ROBOT', 'ROBOT-F1'));

    const house = await send(context, 'PUT', '/equipment/HOUSE-F1', {
      name: 'ハウス',
      sourceFilePath: '/data/house.json',
    });
    const invalid = await send(context, 'PUT', '/equipment/ROBOT-F1', {
      name: 'ロボット',
      facilityId: 'HOUSE-F1',
      sourceFilePath: 'bad',
    });

    expect(house.status).toBe(400);
    expect((await errorOf(house)).fields?.map((field) => field.name)).toContain('sourceFilePath');
    expect(invalid.status).toBe(400);
  });
});
