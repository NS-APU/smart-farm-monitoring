/**
 * 手動入力の保存・修正・削除の応答の前に、評価を再計算するかの設定（`EVALUATION_ON_WRITE`。Issue #123。ADR-0014）の結合テスト。
 * `sync`（既定。ローカル・E2E）は、応答の前に評価する。`deferred`（AWS の Lambda）は、評価せず、定期の評価（JB-02）が更新する。
 */

import { describe, expect, it, vi } from 'vitest';
import { toUserId, type EquipmentId } from '@smart-farm/shared/schemas/common';
import { ManualEntrySaveResponseSchema } from '@smart-farm/shared/schemas/manual-entry';
import { equipmentSet, FACILITY_ID, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import { createTestContext, TEST_NOW } from '../support/test-context.ts';

const ACTOR = toUserId('test-actor');

async function setup(mode?: 'sync' | 'deferred') {
  const context = await createTestContext(
    mode === undefined ? {} : { env: { EVALUATION_ON_WRITE: mode } },
  );
  for (const equipment of equipmentSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  const evaluateAffected = vi.spyOn(context.container.evaluationService, 'evaluateAffected');
  return { context, evaluateAffected };
}

function input(equipmentId: EquipmentId = ROBOT_ID) {
  return {
    equipmentId,
    category: 'FAILURE' as const,
    observedAt: new Date(TEST_NOW.getTime() - 3_600_000).toISOString(),
    items: { failureCount: 1, recoveryMinutes: 30 },
  };
}

async function savedCount(context: Awaited<ReturnType<typeof setup>>['context']) {
  return (await context.container.repositories.evaluations.listLatest(ROBOT_ID)).length;
}

describe('評価を、保存の応答の前に行う（EVALUATION_ON_WRITE=sync。既定）', () => {
  it('保存・修正・削除のたびに、影響する設備の評価を実行し、応答の評価の状態は DONE', async () => {
    const { context, evaluateAffected } = await setup();
    const service = context.container.manualEntryService;

    const created = await service.create(input(), ACTOR);
    const updated = await service.update(
      created.entry.entryId,
      { ...input(), equipmentId: SENSOR_ID },
      ACTOR,
    );
    await service.delete(created.entry.entryId, ACTOR);

    expect(context.config.evaluationOnWrite).toBe('sync');
    expect(created.evaluation).toBe('DONE');
    expect(updated.evaluation).toBe('DONE');
    // 設備を変更した修正は、変更前と変更後の設備を評価する。削除は、修正後の設備（センサー）を評価する
    expect(evaluateAffected.mock.calls.map(([, ids]) => ids)).toEqual([
      [ROBOT_ID],
      [ROBOT_ID, SENSOR_ID],
      [SENSOR_ID],
    ]);
    expect(await savedCount(context)).toBe(40);
  });
});

describe('評価を、保存の応答の前に行わない（EVALUATION_ON_WRITE=deferred。AWS）', () => {
  it('保存・修正・削除で、評価を実行しない。応答の評価の状態は DEFERRED。評価の結果は、増えない', async () => {
    const { context, evaluateAffected } = await setup('deferred');
    const service = context.container.manualEntryService;

    const created = await service.create(input(), ACTOR);
    const updated = await service.update(
      created.entry.entryId,
      { ...input(), equipmentId: SENSOR_ID },
      ACTOR,
    );
    await service.delete(created.entry.entryId, ACTOR);

    expect(context.config.evaluationOnWrite).toBe('deferred');
    expect(created.evaluation).toBe('DEFERRED');
    expect(updated.evaluation).toBe('DEFERRED');
    expect(evaluateAffected).not.toHaveBeenCalled();
    expect(await savedCount(context)).toBe(0);
  });

  it('入力そのもの（手動入力・観測値・変更履歴）は、これまでどおり、保存される。保存・削除は、評価の有無に影響されない', async () => {
    const { context } = await setup('deferred');
    const service = context.container.manualEntryService;

    const { entry } = await service.create(input(), ACTOR);

    expect((await context.container.repositories.manualEntries.get(entry.entryId))?.isDeleted).toBe(
      false,
    );
    const observations = await context.container.repositories.observations.findForEvaluation(
      [ROBOT_ID],
      new Date(TEST_NOW.getTime() - 86_400_000),
      TEST_NOW,
    );
    expect(observations.map((item) => item.itemKey).sort()).toEqual([
      'failureCount',
      'recoveryMinutes',
    ]);
    await service.delete(entry.entryId, ACTOR);
    expect((await context.container.repositories.manualEntries.get(entry.entryId))?.isDeleted).toBe(
      true,
    );
  });

  it('関連する観点のステータスは、前回の評価の値。評価がまだなければ、空', async () => {
    const { context } = await setup('deferred');
    const service = context.container.manualEntryService;

    const before = await service.create(input(), ACTOR);
    await context.container.evaluationService.evaluateAll('SCHEDULED');
    const after = await service.create(
      { ...input(), observedAt: new Date(TEST_NOW.getTime() - 7_200_000).toISOString() },
      ACTOR,
    );

    expect(before.viewpointStatuses).toEqual([]);
    expect(after.viewpointStatuses.length).toBeGreaterThan(0);
  });

  it('定期の評価（JB-02。evaluateAll）が、保存した入力を、評価に反映する', async () => {
    const { context } = await setup('deferred');

    await context.container.manualEntryService.create(input(), ACTOR);
    expect(await savedCount(context)).toBe(0);
    const summary = await context.container.evaluationService.evaluateAll('SCHEDULED');

    expect(summary.equipmentEvaluated).toBe(3);
    expect(await savedCount(context)).toBe(40);
    expect(
      (await context.container.repositories.evaluations.listLatest(FACILITY_ID)).length,
    ).toBeGreaterThan(0);
  });

  it('API の応答に、evaluation（DEFERRED）が含まれる。応答は、共有のスキーマで読める', async () => {
    const { context } = await setup('deferred');

    const response = await context.request('/manual-entries', { method: 'POST', body: input() });

    expect(response.status).toBe(201);
    const body = ManualEntrySaveResponseSchema.parse(await response.json());
    expect(body.evaluation).toBe('DEFERRED');
  });
});
