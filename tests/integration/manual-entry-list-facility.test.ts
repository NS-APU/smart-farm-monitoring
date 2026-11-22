/**
 * 手動入力の一覧（GET /manual-entries）で、ハウスを指定したときの配下の扱いの結合テスト（Issue #152 の PR1。SC-07-8）。
 * 取り込み済みデータ（SC-09）と同じく、ハウスを指定すると、そのハウスの配下のロボット・センサーの入力も含める。
 * ロボット・センサーを指定したときは、その設備の入力だけ。ほかのハウスの入力は、含めない。
 */

import { describe, expect, it } from 'vitest';
import { ManualEntryListResponseSchema } from '@smart-farm/shared/schemas/manual-entry';
import {
  FACILITY_2_ID,
  FACILITY_ID,
  ROBOT_2_ID,
  ROBOT_ID,
  SENSOR_ID,
  secondHouseSet,
} from '../support/builders.ts';
import { TEST_NOW, withEquipment, type TestContext } from '../support/test-context.ts';

const OBSERVED_AT = new Date(TEST_NOW.getTime() - 3_600_000).toISOString();

/** 設備ごとに、その種別に合うカテゴリの入力を、1 件ずつ登録する（ハウス 1: ハウス・ロボット・センサー。ハウス 2: ロボット）。 */
async function setup(): Promise<TestContext> {
  const context = await withEquipment();
  for (const equipment of secondHouseSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  const bodies = [
    { equipmentId: ROBOT_ID, category: 'FAILURE', items: { failureCount: 1 } },
    { equipmentId: SENSOR_ID, category: 'ENVIRONMENT', items: { temperatureCelsius: 25 } },
    { equipmentId: ROBOT_2_ID, category: 'FAILURE', items: { failureCount: 2 } },
  ];
  for (const body of bodies) {
    const response = await context.request('/manual-entries', {
      method: 'POST',
      body: { ...body, observedAt: OBSERVED_AT },
    });
    expect(response.status).toBe(201);
  }
  return context;
}

async function equipmentIdsOf(context: TestContext, query: string): Promise<string[]> {
  const response = await context.request(`/manual-entries${query}`);
  expect(response.status).toBe(200);
  return ManualEntryListResponseSchema.parse(await response.json())
    .items.map((item) => item.equipmentId)
    .sort();
}

describe('手動入力の一覧: 設備の絞り込み（SC-07-8）', () => {
  it('ハウスを指定すると、そのハウスの配下のロボット・センサーの入力も含める。ほかのハウスの入力は含めない', async () => {
    const context = await setup();

    expect(await equipmentIdsOf(context, `?equipmentId=${FACILITY_ID}`)).toEqual(
      [ROBOT_ID, SENSOR_ID].sort(),
    );
    expect(await equipmentIdsOf(context, `?equipmentId=${FACILITY_2_ID}`)).toEqual([ROBOT_2_ID]);
  });

  it('ロボット・センサーを指定すると、その設備の入力だけ', async () => {
    const context = await setup();

    expect(await equipmentIdsOf(context, `?equipmentId=${ROBOT_ID}`)).toEqual([ROBOT_ID]);
    expect(await equipmentIdsOf(context, `?equipmentId=${SENSOR_ID}`)).toEqual([SENSOR_ID]);
  });

  it('ハウスの指定は、カテゴリ・キーワードの絞り込みと、あわせて使える', async () => {
    const context = await setup();

    expect(await equipmentIdsOf(context, `?equipmentId=${FACILITY_ID}&category=FAILURE`)).toEqual([
      ROBOT_ID,
    ]);
    expect(
      await equipmentIdsOf(
        context,
        `?equipmentId=${FACILITY_ID}&q=${encodeURIComponent('センサー')}`,
      ),
    ).toEqual([SENSOR_ID]);
  });

  it('設備の指定がなければ、全設備の入力', async () => {
    const context = await setup();

    expect(await equipmentIdsOf(context, '')).toEqual([ROBOT_ID, ROBOT_2_ID, SENSOR_ID].sort());
  });
});
