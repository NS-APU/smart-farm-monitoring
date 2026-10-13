/**
 * 評価の対象を絞る実行（evaluateAffected）の結合テスト。手動入力・取り込みの保存後に、データが変わった設備と、それを含むハウスだけを評価する。
 * 実行中に重なった要求は、設備をまとめて1回にする（全設備の要求が重なったら、全設備）。
 */

import { describe, expect, it } from 'vitest';
import { toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
import { equipmentSet, FACILITY_ID, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import { createTestContext, TEST_NOW, untilEvaluationStarted } from '../support/test-context.ts';

async function setup() {
  const context = await createTestContext();
  for (const equipment of equipmentSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  return context;
}

async function savedCount(
  context: Awaited<ReturnType<typeof setup>>,
  equipmentId: typeof ROBOT_ID,
): Promise<number> {
  return (await context.container.repositories.evaluations.listLatest(equipmentId)).length;
}

describe('評価の対象を絞る実行（evaluateAffected）', () => {
  it('ロボットを指定すると、そのロボットと、それを含むハウスだけを評価する（ほかのセンサーは評価しない）', async () => {
    const context = await setup();

    const summary = await context.container.evaluationService.evaluateAffected('MANUAL_ENTRY', [
      ROBOT_ID,
    ]);

    expect(summary.equipmentEvaluated).toBe(2);
    expect(await savedCount(context, ROBOT_ID)).toBe(40);
    expect(await savedCount(context, FACILITY_ID)).toBe(56);
    expect(await savedCount(context, SENSOR_ID)).toBe(0);
  });

  it('ハウスを指定すると、そのハウスだけを評価する（配下のロボット・センサーのデータは、ハウスの評価に含まれる）', async () => {
    const context = await setup();

    const summary = await context.container.evaluationService.evaluateAffected('INGESTION', [
      FACILITY_ID,
    ]);

    expect(summary.equipmentEvaluated).toBe(1);
    expect(await savedCount(context, FACILITY_ID)).toBe(56);
    expect(await savedCount(context, ROBOT_ID)).toBe(0);
  });

  it('登録にない設備だけを指定したら、何も評価しない', async () => {
    const context = await setup();

    const summary = await context.container.evaluationService.evaluateAffected('INGESTION', [
      toEquipmentId('NOT-REGISTERED'),
    ]);

    expect(summary.equipmentEvaluated).toBe(0);
  });

  it('実行中に重なった要求は、設備をまとめて1回にする', async () => {
    const context = await setup();
    const service = context.container.evaluationService;

    const first = service.evaluateAffected('MANUAL_ENTRY', [ROBOT_ID]);
    await untilEvaluationStarted();
    // 最初の評価が始まってから、重なった要求を出す
    const second = service.evaluateAffected('MANUAL_ENTRY', [SENSOR_ID]);
    const third = service.evaluateAffected('INGESTION', [ROBOT_ID]);
    const results = await Promise.all([first, second, third]);

    expect(second).toBe(third);
    expect(results.map((summary) => summary.equipmentEvaluated)).toEqual([2, 3, 3]);
  });

  it('待機中の要求に、全設備の要求が重なったら、全設備を評価する。その後の絞った要求は、全設備のまま', async () => {
    const context = await setup();
    const service = context.container.evaluationService;

    const first = service.evaluateAffected('MANUAL_ENTRY', [ROBOT_ID]);
    await untilEvaluationStarted();
    const second = service.evaluateAffected('MANUAL_ENTRY', [SENSOR_ID]);
    const third = service.evaluateAll('SCHEDULED');
    const fourth = service.evaluateAffected('INGESTION', [ROBOT_ID]);
    const results = await Promise.all([first, second, third, fourth]);

    expect(second).toBe(third);
    expect(third).toBe(fourth);
    expect(results.map((summary) => summary.equipmentEvaluated)).toEqual([2, 3, 3, 3]);
  });
});

describe('保存後の評価の対象', () => {
  const ACTOR = toUserId('test-actor');
  const input = (equipmentId: typeof ROBOT_ID) => ({
    equipmentId,
    category: 'FAILURE' as const,
    observedAt: new Date(TEST_NOW.getTime() - 3_600_000).toISOString(),
    items: { failureCount: 1, recoveryMinutes: 30 },
  });

  it('手動入力の登録は、入力した設備とハウスだけを評価する', async () => {
    const context = await setup();

    await context.container.manualEntryService.create(input(ROBOT_ID), ACTOR);

    expect(await savedCount(context, ROBOT_ID)).toBe(40);
    expect(await savedCount(context, FACILITY_ID)).toBe(56);
    expect(await savedCount(context, SENSOR_ID)).toBe(0);
  });

  it('設備を変更した修正は、変更前と変更後の設備を評価し、削除は、その設備を評価する', async () => {
    const context = await setup();
    const { entry } = await context.container.manualEntryService.create(input(ROBOT_ID), ACTOR);

    await context.container.manualEntryService.update(
      entry.entryId,
      { ...input(ROBOT_ID), equipmentId: FACILITY_ID },
      ACTOR,
    );
    await context.container.manualEntryService.delete(entry.entryId, ACTOR);

    expect(await savedCount(context, ROBOT_ID)).toBe(40);
    expect(await savedCount(context, SENSOR_ID)).toBe(0);
  });
});
