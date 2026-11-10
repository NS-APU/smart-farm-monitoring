/**
 * 設備ごとの取得間隔（Issue #197。ADR-0016 の D-11）の結合テスト。
 * 設備（ロボット・センサー）ごとに、取り込みの取得間隔（分）を持つ。選べる値は、1・5・10・15・30・60 分。
 * 未設定は、種別ごとの既定（ロボット 1 分・センサー 5 分）。ハウスは持てない。変更履歴に残す。
 */

import { describe, expect, it } from 'vitest';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import { EquipmentSchema } from '@smart-farm/shared/schemas/equipment';
import { createTestContext, errorOf, type TestContext } from '../support/test-context.ts';

function send(context: TestContext, method: string, path: string, body?: unknown) {
  return context.request(path, { method, ...(body === undefined ? {} : { body }) });
}

const HOUSE = { equipmentId: 'HOUSE-I1', equipmentType: 'FACILITY', name: 'ハウス' };

async function setup(): Promise<TestContext> {
  const context = await createTestContext();
  expect((await send(context, 'POST', '/equipment', HOUSE)).status).toBe(201);
  return context;
}

function child(equipmentType: 'ROBOT' | 'SENSOR', id: string, extra: Record<string, unknown> = {}) {
  return { equipmentId: id, equipmentType, name: id, facilityId: 'HOUSE-I1', ...extra };
}

describe('登録', () => {
  it.each([1, 5, 10, 15, 30, 60])(
    '取得間隔 %i 分を指定して、ロボット・センサーを登録できる。応答・一覧に含まれる',
    async (minutes) => {
      const context = await setup();

      const robot = await send(
        context,
        'POST',
        '/equipment',
        child('ROBOT', 'ROBOT-I1', { intervalMinutes: minutes }),
      );
      const sensor = await send(
        context,
        'POST',
        '/equipment',
        child('SENSOR', 'SENSOR-I1', { intervalMinutes: minutes }),
      );

      expect([robot.status, sensor.status]).toEqual([201, 201]);
      expect(EquipmentSchema.parse(await robot.json()).intervalMinutes).toBe(minutes);
      const tree = (await (await send(context, 'GET', '/equipment')).json()) as {
        facilities: { children: { equipmentId: string; intervalMinutes?: number }[] }[];
      };
      const children = tree.facilities[0]?.children ?? [];
      expect(children.find((item) => item.equipmentId === 'SENSOR-I1')?.intervalMinutes).toBe(
        minutes,
      );
    },
  );

  it('取得間隔は、任意。省略すると、持たない（種別ごとの既定として扱う）', async () => {
    const context = await setup();

    const robot = await send(context, 'POST', '/equipment', child('ROBOT', 'ROBOT-I1'));

    expect(robot.status).toBe(201);
    expect(EquipmentSchema.parse(await robot.json()).intervalMinutes).toBeUndefined();
  });

  it('変更履歴に、取得間隔を残す', async () => {
    const context = await setup();

    await send(context, 'POST', '/equipment', child('ROBOT', 'ROBOT-I1', { intervalMinutes: 15 }));

    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?targetType=equipment')).json(),
    );
    expect(JSON.stringify(audit.items[0]?.after)).toContain('"intervalMinutes":15');
  });

  it.each([
    ['0 分', 0],
    ['2 分（候補にない）', 2],
    ['61 分', 61],
    ['6 時間（以前の候補。外した）', 360],
    ['日次（以前の候補。外した）', 1440],
    ['小数', 1.5],
    ['負の値', -5],
    ['文字列', '5'],
  ])('候補にない取得間隔（%s）は、400。登録しない', async (_name, value) => {
    const context = await setup();

    const response = await send(
      context,
      'POST',
      '/equipment',
      child('ROBOT', 'ROBOT-I1', { intervalMinutes: value }),
    );

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((field) => field.name)).toContain(
      'intervalMinutes',
    );
    const tree = (await (await send(context, 'GET', '/equipment')).json()) as {
      facilities: { children: unknown[] }[];
    };
    expect(tree.facilities[0]?.children).toHaveLength(0);
  });

  it('ハウスには、指定できない（400）', async () => {
    const context = await createTestContext();

    const response = await send(context, 'POST', '/equipment', { ...HOUSE, intervalMinutes: 5 });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((field) => field.name)).toContain(
      'intervalMinutes',
    );
  });
});

describe('修正', () => {
  it('取得間隔を、設定・変更・解除できる（省略は、既定に戻す）', async () => {
    const context = await setup();
    await send(context, 'POST', '/equipment', child('ROBOT', 'ROBOT-I1'));
    const update = (extra: Record<string, unknown>) =>
      send(context, 'PUT', '/equipment/ROBOT-I1', {
        name: 'ロボット',
        facilityId: 'HOUSE-I1',
        ...extra,
      });

    const set = await update({ intervalMinutes: 30 });
    const changed = await update({ intervalMinutes: 10 });
    const cleared = await update({});

    expect([set.status, changed.status, cleared.status]).toEqual([200, 200, 200]);
    expect(EquipmentSchema.parse(await changed.json()).intervalMinutes).toBe(10);
    expect(EquipmentSchema.parse(await cleared.json()).intervalMinutes).toBeUndefined();
  });

  it('修正の変更履歴に、変更前後の取得間隔を残す', async () => {
    const context = await setup();
    await send(context, 'POST', '/equipment', child('ROBOT', 'ROBOT-I1', { intervalMinutes: 15 }));

    await send(context, 'PUT', '/equipment/ROBOT-I1', {
      name: 'ロボット',
      facilityId: 'HOUSE-I1',
      intervalMinutes: 60,
    });

    const audit = AuditLogListResponseSchema.parse(
      await (
        await send(context, 'GET', '/audit-logs?targetType=equipment&operation=UPDATE')
      ).json(),
    );
    expect(JSON.stringify(audit.items[0]?.before)).toContain('"intervalMinutes":15');
    expect(JSON.stringify(audit.items[0]?.after)).toContain('"intervalMinutes":60');
  });

  it('ハウスには、指定できない（400）。候補にない取得間隔も、400', async () => {
    const context = await setup();
    await send(context, 'POST', '/equipment', child('ROBOT', 'ROBOT-I1'));

    const house = await send(context, 'PUT', '/equipment/HOUSE-I1', {
      name: 'ハウス',
      intervalMinutes: 5,
    });
    const invalid = await send(context, 'PUT', '/equipment/ROBOT-I1', {
      name: 'ロボット',
      facilityId: 'HOUSE-I1',
      intervalMinutes: 360,
    });

    expect(house.status).toBe(400);
    expect((await errorOf(house)).fields?.map((field) => field.name)).toContain('intervalMinutes');
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).fields?.map((field) => field.name)).toContain(
      'intervalMinutes',
    );
  });
});
