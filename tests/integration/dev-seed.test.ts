/**
 * 開発用 API の、E2E 用のデータ投入（POST /dev/observations、POST /dev/reset の EQUIPMENT）の結合テスト。
 * E2E は、この API で、状態ごと（正常・注意・異常・不明）の値を用意する。
 */

import { describe, expect, it } from 'vitest';
import { toEquipmentId } from '../../src/shared/schemas/common.ts';
import { DashboardResponseSchema } from '../../src/shared/schemas/evaluation.ts';
import { ErrorResponseSchema } from '../../src/shared/schemas/api.ts';
import { MAX_EXPANDED_OBSERVATIONS } from '../../src/backend/infrastructure/local/synthetic-data.ts';
import { createTestContext, TEST_NOW } from '../support/test-context.ts';

const HOUR_ISO = (hours: number): string =>
  new Date(TEST_NOW.getTime() - hours * 3_600_000).toISOString();

async function post(
  context: Awaited<ReturnType<typeof createTestContext>>,
  path: string,
  body: unknown,
) {
  return context.request(path, { method: 'POST', body });
}

describe('POST /dev/reset（seed: EQUIPMENT）', () => {
  it('デモの設備（ハウス・ロボット・センサー）だけを入れ、観測値は入れない', async () => {
    const context = await createTestContext();

    const reset = await post(context, '/dev/reset', { seed: 'EQUIPMENT' });
    const token = await context.login();
    const tree = (await (await context.request('/equipment', { token })).json()) as {
      facilities: { facility: { equipmentId: string }; children: { equipmentId: string }[] }[];
    };
    const observations = await context.container.repositories.observations.query({}, { limit: 10 });

    expect(reset.status).toBe(204);
    expect(tree.facilities[0]?.facility.equipmentId).toBe('HOUSE-01');
    expect(tree.facilities[0]?.children.map((child) => child.equipmentId)).toEqual([
      'ROBOT-01',
      'SENSOR-01',
    ]);
    expect(observations.items).toHaveLength(0);
  });
});

describe('POST /dev/reset（スケジューラの状態）', () => {
  it('リセットすると、スケジューラの「前回の実行」も消し、同じ時刻でも、次の tick で全ジョブを実行する', async () => {
    const context = await createTestContext();
    const token = await context.login();
    const freezeAt = async () => {
      await context.request('/dev/clock', {
        method: 'PUT',
        token,
        body: { at: TEST_NOW.toISOString(), mode: 'FREEZE' },
      });
    };
    await freezeAt();
    const first = await context.request('/dev/scheduler/tick', { method: 'POST', token });
    const second = await context.request('/dev/scheduler/tick', { method: 'POST', token });
    expect(await first.json()).toEqual({ executed: ['JB-01', 'JB-02', 'JB-03', 'JB-04'] });
    expect(await second.json()).toEqual({ executed: [] });

    await post(context, '/dev/reset', { seed: 'NONE' });
    const afterReset = await context.login();
    await context.request('/dev/clock', {
      method: 'PUT',
      token: afterReset,
      body: { at: TEST_NOW.toISOString(), mode: 'FREEZE' },
    });
    const third = await context.request('/dev/scheduler/tick', {
      method: 'POST',
      token: afterReset,
    });

    expect(await third.json()).toEqual({ executed: ['JB-01', 'JB-02', 'JB-03', 'JB-04'] });
  });
});

describe('POST /dev/observations', () => {
  async function withEquipment() {
    const context = await createTestContext();
    await post(context, '/dev/reset', { seed: 'EQUIPMENT' });
    return context;
  }

  it('観測値（個別）と系列（一定の間隔の同じ値）を保存し、評価を更新する', async () => {
    const context = await withEquipment();

    const response = await post(context, '/dev/observations', {
      observations: [
        {
          equipmentId: 'SENSOR-01',
          itemKey: 'temperatureCelsius',
          observedAt: HOUR_ISO(1),
          value: 27,
        },
        {
          equipmentId: 'ROBOT-01',
          itemKey: 'damagedFruitCount',
          observedAt: HOUR_ISO(2),
          value: 3,
          source: 'MANUAL',
          quality: 'LATE',
          receivedAt: HOUR_ISO(1),
        },
      ],
      series: [
        {
          equipmentId: 'SENSOR-01',
          itemKey: 'humidityPercent',
          from: HOUR_ISO(3),
          to: HOUR_ISO(1),
          intervalMinutes: 60,
          value: 60,
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: 5 });
    const rows = (await context.container.repositories.observations.query({}, { limit: 20 })).items;
    const manual = rows.find((row) => row.itemKey === 'damagedFruitCount');
    expect(manual).toMatchObject({
      category: 'HARVEST',
      source: 'MANUAL',
      quality: 'LATE',
      receivedAt: HOUR_ISO(1),
    });
    expect(rows.filter((row) => row.itemKey === 'humidityPercent')).toHaveLength(3);
    // 評価を更新した（環境適応性が注意）
    const dashboard = DashboardResponseSchema.parse(
      await (await context.request('/dashboard')).json(),
    );
    expect(
      dashboard.viewpoints.find((card) => card.viewpointId === 'environmentalAdaptability')?.status,
    ).toBe('CAUTION');
  });

  it('evaluate=false なら、保存だけで、評価しない', async () => {
    const context = await withEquipment();

    await post(context, '/dev/observations', {
      evaluate: false,
      observations: [
        {
          equipmentId: 'SENSOR-01',
          itemKey: 'temperatureCelsius',
          observedAt: HOUR_ISO(1),
          value: 20,
        },
      ],
    });

    expect(
      await context.container.repositories.evaluations.listLatest(toEquipmentId('HOUSE-01')),
    ).toEqual([]);
  });

  it('値の欠損（null）と文字列（ステータスコード）も保存できる', async () => {
    const context = await withEquipment();

    const response = await post(context, '/dev/observations', {
      observations: [
        {
          equipmentId: 'ROBOT-01',
          itemKey: 'statusCode',
          observedAt: HOUR_ISO(1),
          value: 'HARVESTING',
        },
        {
          equipmentId: 'ROBOT-01',
          itemKey: 'harvestCount',
          observedAt: HOUR_ISO(1),
          value: null,
          quality: 'MISSING',
        },
      ],
    });

    expect(response.status).toBe(200);
  });

  it.each([
    [
      '項目カタログにない項目',
      {
        observations: [
          { equipmentId: 'ROBOT-01', itemKey: 'unknownItem', observedAt: HOUR_ISO(1), value: 1 },
        ],
      },
    ],
    [
      '不正な日時',
      {
        observations: [
          { equipmentId: 'ROBOT-01', itemKey: 'harvestCount', observedAt: 'yesterday', value: 1 },
        ],
      },
    ],
    [
      '不正な間隔',
      {
        series: [
          {
            equipmentId: 'ROBOT-01',
            itemKey: 'harvestCount',
            from: HOUR_ISO(2),
            to: HOUR_ISO(1),
            intervalMinutes: 0,
            value: 1,
          },
        ],
      },
    ],
    [
      '展開すると多すぎる系列',
      {
        series: [
          {
            equipmentId: 'ROBOT-01',
            itemKey: 'harvestCount',
            from: new Date(
              TEST_NOW.getTime() - (MAX_EXPANDED_OBSERVATIONS + 10) * 60_000,
            ).toISOString(),
            to: TEST_NOW.toISOString(),
            intervalMinutes: 1,
            value: 1,
          },
        ],
      },
    ],
  ])('%s は 400', async (_name, body) => {
    const context = await withEquipment();

    const response = await post(context, '/dev/observations', body);

    expect(response.status).toBe(400);
    expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('複数の系列を合わせて上限を超える場合は 400', async () => {
    const context = await withEquipment();
    const series = Array.from({ length: 3 }, () => ({
      equipmentId: 'ROBOT-01',
      itemKey: 'harvestCount',
      from: new Date(TEST_NOW.getTime() - 100_000 * 60_000).toISOString(),
      to: TEST_NOW.toISOString(),
      intervalMinutes: 1,
      value: 1,
    }));

    const response = await post(context, '/dev/observations', { series });

    expect(response.status).toBe(400);
  });

  it('認証なしでは使えない', async () => {
    const context = await withEquipment();

    const response = await context.app.request('/api/v1/dev/observations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
  });
});
