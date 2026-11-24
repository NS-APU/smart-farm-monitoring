/**
 * 計測データの一覧の「評価に使われていません」の印のための、行ごとの `usage`（D-26。Issue #162 の SC-09-4）の結合テスト。
 * 合計（累積）の項目の手動入力の行に、評価に使われるか（`used`・自動優先の期間 `autoPriorityPeriods`）を付ける（クエリ `includeUsage=true` のときだけ）。
 * 判定は、評価の結果ではなく、観測値で行う（保存の応答の `usage` と同じ規則）。読み取りは、行の数ではなく、
 * 手動入力の行の設備・項目の組の数だけ増える（組ごとに、自動取り込みの観測値を最新の 1 件）。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MeasurementListResponseSchema,
  ObservationListResponseSchema,
  type Observation,
} from '@smart-farm/shared/schemas/observation';
import { observation, SENSOR_ID } from '../support/builders.ts';
import { TEST_NOW, errorOf, withEquipment, type TestContext } from '../support/test-context.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const hoursAgo = (hours: number): string =>
  new Date(TEST_NOW.getTime() - hours * HOUR_MS).toISOString();

const ALL_PERIODS = [
  { horizon: 'SHORT', periodDays: null },
  { horizon: 'LONG', periodDays: 1 },
  { horizon: 'LONG', periodDays: 7 },
  { horizon: 'LONG', periodDays: 30 },
  { horizon: 'LONG', periodDays: 60 },
  { horizon: 'LONG', periodDays: 90 },
];

function manual(
  itemKey: string,
  observedAt: string,
  overrides: Partial<Observation> = {},
): Observation {
  return {
    ...observation({ itemKey, value: 1700, observedAt, source: 'MANUAL' }),
    manualEntryId: `entry-${itemKey}-${observedAt}`,
    ...overrides,
  };
}

function auto(itemKey: string, observedAt: string, overrides: Partial<Observation> = {}) {
  return { ...observation({ itemKey, value: 1800, observedAt }), ...overrides };
}

async function save(context: TestContext, items: readonly Observation[]): Promise<void> {
  await context.container.repositories.observations.saveMany(items);
}

/** 項目ごとの一覧（日時の新しい順）の行。 */
async function itemRows(context: TestContext, query = '') {
  const response = await context.request(`/observations?limit=50${query}`);
  expect(response.status).toBe(200);
  return ObservationListResponseSchema.parse(await response.json()).items;
}

describe('項目ごとの一覧（GET /observations）の usage', () => {
  it('合計の項目の手動入力に、評価の期間に自動取り込みの値があれば、すべての期間で使われない旨を付ける', async () => {
    const context = await withEquipment();
    await save(context, [auto('harvestCount', hoursAgo(2)), manual('harvestCount', hoursAgo(1))]);

    const items = await itemRows(context, '&includeUsage=true');

    expect(items.find((item) => item.source === 'MANUAL')?.usage).toEqual({
      used: false,
      autoPriorityPeriods: ALL_PERIODS,
    });
    expect(items.find((item) => item.source === 'AUTO_IMPORT')?.usage).toBeUndefined();
  });

  it('自動取り込みの値がなければ、使われる（自動優先の期間はない）', async () => {
    const context = await withEquipment();
    await save(context, [manual('harvestCount', hoursAgo(1))]);

    const [row] = await itemRows(context, '&includeUsage=true');

    expect(row?.usage).toEqual({ used: true, autoPriorityPeriods: [] });
  });

  it('自動取り込みの値が 3 日前にしかなければ、短期・長期の当日は使われ、7 日以上では使われない（一部の期間だけ）', async () => {
    const context = await withEquipment();
    await save(context, [auto('harvestCount', hoursAgo(72)), manual('harvestCount', hoursAgo(1))]);

    const items = await itemRows(context, '&includeUsage=true');

    expect(items.find((item) => item.source === 'MANUAL')?.usage).toEqual({
      used: true,
      autoPriorityPeriods: ALL_PERIODS.slice(2),
    });
  });

  it('合計でない項目（温度・手動専用の件数）の手動入力には、usage を付けない（自動があっても使われるため）', async () => {
    const context = await withEquipment();
    await save(context, [
      auto('temperatureCelsius', hoursAgo(2), { equipmentId: SENSOR_ID, value: 24 }),
      manual('temperatureCelsius', hoursAgo(1), { equipmentId: SENSOR_ID, value: 25 }),
      auto('failureCount', hoursAgo(2), { value: 3 }),
      manual('failureCount', hoursAgo(1), { value: 1 }),
    ]);

    const items = await itemRows(context, '&includeUsage=true');

    expect(items).toHaveLength(4);
    expect(items.every((item) => item.usage === undefined)).toBe(true);
  });

  it('自動取り込みは、同じ設備・同じ項目のものだけが対象（ほかの項目・ほかの設備の自動は、影響しない）', async () => {
    const context = await withEquipment();
    await save(context, [
      auto('operatingHours', hoursAgo(2), { value: 5 }),
      auto('harvestCount', hoursAgo(2), { equipmentId: SENSOR_ID }),
      manual('harvestCount', hoursAgo(1)),
    ]);

    const items = await itemRows(context, '&includeUsage=true');

    expect(items.find((item) => item.source === 'MANUAL')?.usage).toEqual({
      used: true,
      autoPriorityPeriods: [],
    });
  });

  it('使えない自動の値（品質が有効でない・論理削除）は、数えない', async () => {
    const context = await withEquipment();
    await save(context, [
      auto('harvestCount', hoursAgo(2), { quality: 'INVALID' }),
      auto('harvestCount', hoursAgo(3), { isDeleted: true }),
      manual('harvestCount', hoursAgo(1)),
    ]);

    const items = await itemRows(context, '&includeUsage=true');

    expect(items.find((item) => item.source === 'MANUAL')?.usage).toEqual({
      used: true,
      autoPriorityPeriods: [],
    });
  });

  it('90 日より前の手動入力には、usage を付けない（どの評価の期間にも入らないため）', async () => {
    const context = await withEquipment();
    await save(context, [
      auto('harvestCount', hoursAgo(2)),
      manual('harvestCount', new Date(TEST_NOW.getTime() - 100 * DAY_MS).toISOString()),
    ]);

    const items = await itemRows(context, '&includeUsage=true');

    expect(items.find((item) => item.source === 'MANUAL')?.usage).toBeUndefined();
  });

  it('includeUsage がなければ（既定）、usage を付けず、自動取り込みの観測値も読まない。指定したときは、設備・項目の組ごとに 1 回だけ多く読む', async () => {
    const context = await withEquipment();
    await save(context, [auto('harvestCount', hoursAgo(2)), manual('harvestCount', hoursAgo(1))]);
    const spy = vi.spyOn(context.container.repositories.observations, 'query');

    const plain = await itemRows(context);
    const plainCalls = spy.mock.calls.length;
    spy.mockClear();
    const withUsage = await itemRows(context, '&includeUsage=true');

    expect(plain.every((item) => item.usage === undefined)).toBe(true);
    expect(plainCalls).toBe(1);
    expect(withUsage.some((item) => item.usage !== undefined)).toBe(true);
    expect(spy.mock.calls.length).toBe(plainCalls + 1);
  });

  it('includeUsage の指定が正しくなければ、400', async () => {
    const context = await withEquipment();

    const response = await context.request('/observations?includeUsage=maybe');

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('VALIDATION_ERROR');
  });
});

describe('計測ごとの一覧（GET /observations/measurements）の usage', () => {
  it('計測の項目ごとに usage を付ける（合計の項目の手動入力だけ。自動取り込みの計測・合計でない項目は付けない）', async () => {
    const context = await withEquipment();
    // 1 回の入力（同じ計測日時）の 3 項目
    const sameEntry = ['harvestCount', 'operatingHours', 'failureCount'].map((itemKey) =>
      manual(itemKey, hoursAgo(1), { manualEntryId: 'entry-1' }),
    );
    await save(context, [auto('harvestCount', hoursAgo(5)), ...sameEntry]);

    const response = await context.request('/observations/measurements?includeUsage=true');
    expect(response.status).toBe(200);
    const { items } = MeasurementListResponseSchema.parse(await response.json());

    const manualMeasurement = items.find((item) => item.source === 'MANUAL');
    const usageOf = (itemKey: string) =>
      manualMeasurement?.items.find((item) => item.itemKey === itemKey)?.usage;
    expect(usageOf('harvestCount')).toEqual({ used: false, autoPriorityPeriods: ALL_PERIODS });
    // 自動取り込みの値のない項目（稼働時間）は、使われる
    expect(usageOf('operatingHours')).toEqual({ used: true, autoPriorityPeriods: [] });
    expect(usageOf('failureCount')).toBeUndefined();
    const autoMeasurement = items.find((item) => item.source === 'AUTO_IMPORT');
    expect(autoMeasurement?.items.every((item) => item.usage === undefined)).toBe(true);
  });

  it('includeUsage がなければ、usage を付けない', async () => {
    const context = await withEquipment();
    await save(context, [auto('harvestCount', hoursAgo(2)), manual('harvestCount', hoursAgo(1))]);

    const response = await context.request('/observations/measurements');
    const { items } = MeasurementListResponseSchema.parse(await response.json());

    const rows = items.flatMap((measurement) => measurement.items);
    expect(rows).toHaveLength(2);
    expect(rows.every((item) => item.usage === undefined)).toBe(true);
  });

  it('読み取りは、手動入力の行の数ではなく、設備・項目の組の数だけ増える（15 回の入力・1 組 → 1 回）', async () => {
    const context = await withEquipment();
    await save(context, [
      auto('harvestCount', hoursAgo(30)),
      ...Array.from({ length: 15 }, (_, index) =>
        manual('harvestCount', hoursAgo(1 + index), { manualEntryId: `entry-${String(index)}` }),
      ),
    ]);
    const spy = vi.spyOn(context.container.repositories.observations, 'query');

    await context.request('/observations/measurements?limit=20');
    const base = spy.mock.calls.length;
    spy.mockClear();
    const response = await context.request('/observations/measurements?limit=20&includeUsage=true');
    const { items } = MeasurementListResponseSchema.parse(await response.json());

    expect(items.filter((item) => item.source === 'MANUAL')).toHaveLength(15);
    expect(spy.mock.calls.length - base).toBe(1);
  });

  it('設備・項目の組ごとに 1 回（ロボットの収穫数・稼働時間とセンサーの収穫数の 3 組 → 3 回。同じ組の複数の入力は 1 回）', async () => {
    const context = await withEquipment();
    await save(context, [
      manual('harvestCount', hoursAgo(1)),
      manual('operatingHours', hoursAgo(2), { value: 6 }),
      manual('harvestCount', hoursAgo(3), { equipmentId: SENSOR_ID }),
      manual('harvestCount', hoursAgo(4)),
    ]);
    const spy = vi.spyOn(context.container.repositories.observations, 'query');

    await context.request('/observations/measurements');
    const base = spy.mock.calls.length;
    spy.mockClear();
    await context.request('/observations/measurements?includeUsage=true');

    expect(spy.mock.calls.length - base).toBe(3);
  });
});
