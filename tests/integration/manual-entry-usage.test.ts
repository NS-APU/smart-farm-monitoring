/**
 * 手動入力の保存の応答の「評価に使われるか」（項目ごと。D-26。Issue #162 の SC-06-5）の結合テスト。
 * 合計（累積）の項目は、評価の期間に、同じ設備・項目の自動取り込みの値があれば、手動入力は使われない（保存はできる）。
 * 判定は、評価の結果ではなく、観測値で行う（`deferred`〔AWS〕でも、同じ判定ができる）。
 */

import { describe, expect, it } from 'vitest';
import { toUserId } from '@smart-farm/shared/schemas/common';
import {
  ManualEntrySaveResponseSchema,
  type ManualEntryInput,
} from '@smart-farm/shared/schemas/manual-entry';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import { equipmentSet, observation, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import { createTestContext, TEST_NOW } from '../support/test-context.ts';

const ACTOR = toUserId('test-actor');
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const hoursAgo = (hours: number): string =>
  new Date(TEST_NOW.getTime() - hours * HOUR_MS).toISOString();

async function setup(mode: 'sync' | 'deferred') {
  const context = await createTestContext({ env: { EVALUATION_ON_WRITE: mode } });
  for (const equipment of equipmentSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  return context;
}

type Context = Awaited<ReturnType<typeof setup>>;

function harvestInput(observedAt: string, harvestCount = 1700): ManualEntryInput {
  return { equipmentId: ROBOT_ID, category: 'HARVEST', observedAt, items: { harvestCount } };
}

async function saveAuto(
  context: Context,
  itemKey: string,
  value: number,
  observedAt: string,
  quality?: Observation['quality'],
): Promise<void> {
  await context.container.repositories.observations.saveMany([
    observation({
      itemKey,
      value,
      observedAt,
      source: 'AUTO_IMPORT',
      ...(quality === undefined ? {} : { quality }),
    }),
  ]);
}

const ALL_PERIODS = [
  { horizon: 'SHORT', periodDays: null },
  { horizon: 'LONG', periodDays: 1 },
  { horizon: 'LONG', periodDays: 7 },
  { horizon: 'LONG', periodDays: 30 },
  { horizon: 'LONG', periodDays: 60 },
  { horizon: 'LONG', periodDays: 90 },
];

describe.each(['sync', 'deferred'] as const)(
  '保存の応答の「評価に使われるか」（EVALUATION_ON_WRITE=%s）',
  (mode) => {
    it('合計の項目で、直近 24 時間に自動取り込みの値があれば、すべての評価の期間で、使われない（保存はできる）', async () => {
      const context = await setup(mode);
      await saveAuto(context, 'harvestCount', 1800, hoursAgo(2));

      const saved = await context.container.manualEntryService.create(
        harvestInput(hoursAgo(1)),
        ACTOR,
      );

      expect(saved.usage).toEqual([
        { itemKey: 'harvestCount', used: false, autoPriorityPeriods: ALL_PERIODS },
      ]);
      const stored = await context.container.repositories.manualEntries.get(saved.entry.entryId);
      expect(stored?.isDeleted).toBe(false);
      expect(ManualEntrySaveResponseSchema.safeParse(saved).success).toBe(true);
    });

    it('自動取り込みの値がなければ、使われる（自動優先の期間はない）', async () => {
      const context = await setup(mode);

      const saved = await context.container.manualEntryService.create(
        harvestInput(hoursAgo(1)),
        ACTOR,
      );

      expect(saved.usage).toEqual([
        { itemKey: 'harvestCount', used: true, autoPriorityPeriods: [] },
      ]);
    });

    it('自動取り込みの値が 3 日前にしかなければ、短期視点・長期の当日では、手動が使われ、長期の 7 日以上では、使われない（期間ごとに取得元が変わる）', async () => {
      const context = await setup(mode);
      await saveAuto(context, 'harvestCount', 900, hoursAgo(72));

      const saved = await context.container.manualEntryService.create(
        harvestInput(hoursAgo(1)),
        ACTOR,
      );

      expect(saved.usage).toEqual([
        {
          itemKey: 'harvestCount',
          used: true,
          autoPriorityPeriods: [
            { horizon: 'LONG', periodDays: 7 },
            { horizon: 'LONG', periodDays: 30 },
            { horizon: 'LONG', periodDays: 60 },
            { horizon: 'LONG', periodDays: 90 },
          ],
        },
      ]);
    });

    it('自動取り込みの値は、同じ設備・同じ項目のものだけが対象（ほかの項目・ほかの設備の自動は、影響しない）', async () => {
      const context = await setup(mode);
      await saveAuto(context, 'operatingHours', 5, hoursAgo(2));
      await context.container.repositories.observations.saveMany([
        observation({
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: 25,
          observedAt: hoursAgo(2),
        }),
      ]);

      const saved = await context.container.manualEntryService.create(
        harvestInput(hoursAgo(1)),
        ACTOR,
      );

      expect(saved.usage).toEqual([
        { itemKey: 'harvestCount', used: true, autoPriorityPeriods: [] },
      ]);
    });

    it('使えない自動の値（品質が有効でない・論理削除・評価時刻より後の計測日時）は、数えない', async () => {
      const context = await setup(mode);
      await saveAuto(context, 'harvestCount', 1800, hoursAgo(2), 'INVALID');
      await context.container.repositories.observations.saveMany([
        observation({
          itemKey: 'harvestCount',
          value: 1900,
          observedAt: hoursAgo(3),
          isDeleted: true,
        }),
        observation({
          itemKey: 'harvestCount',
          value: 2000,
          observedAt: new Date(TEST_NOW.getTime() + 2 * HOUR_MS).toISOString(),
        }),
      ]);

      const saved = await context.container.manualEntryService.create(
        harvestInput(hoursAgo(1)),
        ACTOR,
      );

      expect(saved.usage).toEqual([
        { itemKey: 'harvestCount', used: true, autoPriorityPeriods: [] },
      ]);
    });

    it('合計でない項目（温度など）と、手動専用の件数の項目は、自動があっても、使われる', async () => {
      const context = await setup(mode);
      await context.container.repositories.observations.saveMany([
        observation({
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: 24,
          observedAt: hoursAgo(2),
        }),
      ]);
      await saveAuto(context, 'failureCount', 3, hoursAgo(2));

      const sensor = await context.container.manualEntryService.create(
        {
          equipmentId: SENSOR_ID,
          category: 'ENVIRONMENT',
          observedAt: hoursAgo(1),
          items: { temperatureCelsius: 25 },
        },
        ACTOR,
      );
      const failure = await context.container.manualEntryService.create(
        {
          equipmentId: ROBOT_ID,
          category: 'FAILURE',
          observedAt: hoursAgo(1),
          items: { failureCount: 1 },
        },
        ACTOR,
      );

      expect(sensor.usage).toEqual([
        { itemKey: 'temperatureCelsius', used: true, autoPriorityPeriods: [] },
      ]);
      expect(failure.usage).toEqual([
        { itemKey: 'failureCount', used: true, autoPriorityPeriods: [] },
      ]);
    });

    it('複数の項目を入力したときは、項目ごとに判定する（自動のある項目だけ、使われない）', async () => {
      const context = await setup(mode);
      await saveAuto(context, 'operatingHours', 5, hoursAgo(2));

      const saved = await context.container.manualEntryService.create(
        {
          equipmentId: ROBOT_ID,
          category: 'OPERATION',
          observedAt: hoursAgo(1),
          items: { operatingHours: 6, standbyHours: 1 },
        },
        ACTOR,
      );

      expect(saved.usage).toEqual([
        { itemKey: 'operatingHours', used: false, autoPriorityPeriods: ALL_PERIODS },
        { itemKey: 'standbyHours', used: true, autoPriorityPeriods: [] },
      ]);
    });

    it('計測日時が、現在より少し未来（許容の範囲内）でも、自動優先の判定ができる', async () => {
      const context = await setup(mode);
      await saveAuto(context, 'harvestCount', 1800, hoursAgo(2));

      const saved = await context.container.manualEntryService.create(
        harvestInput(new Date(TEST_NOW.getTime() + 2 * 60_000).toISOString()),
        ACTOR,
      );

      expect(saved.usage?.[0]).toMatchObject({ itemKey: 'harvestCount', used: false });
    });

    it('計測日時が 90 日より前なら、どの評価の期間にも入らないため、自動優先とは示さない', async () => {
      const context = await setup(mode);
      await saveAuto(context, 'harvestCount', 1800, hoursAgo(2));

      const saved = await context.container.manualEntryService.create(
        harvestInput(new Date(TEST_NOW.getTime() - 100 * DAY_MS).toISOString()),
        ACTOR,
      );

      expect(saved.usage).toEqual([
        { itemKey: 'harvestCount', used: false, autoPriorityPeriods: [] },
      ]);
    });

    it('修正の応答にも、同じ判定を含める。削除の応答には、含めない', async () => {
      const context = await setup(mode);
      const service = context.container.manualEntryService;
      const created = await service.create(harvestInput(hoursAgo(1)), ACTOR);
      expect(created.usage?.[0]?.used).toBe(true);
      await saveAuto(context, 'harvestCount', 1800, hoursAgo(2));

      const updated = await service.update(
        created.entry.entryId,
        harvestInput(hoursAgo(1), 1750),
        ACTOR,
      );
      const deleted = await service.delete(created.entry.entryId, ACTOR);

      expect(updated.usage).toEqual([
        { itemKey: 'harvestCount', used: false, autoPriorityPeriods: ALL_PERIODS },
      ]);
      expect(deleted.usage).toBeUndefined();
    });
  },
);
