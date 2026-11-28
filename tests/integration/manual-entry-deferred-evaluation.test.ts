/**
 * 手動入力の保存・修正・削除の応答の前に、評価を再計算するかの設定（`EVALUATION_ON_WRITE`。Issue #123。ADR-0014）の結合テスト。
 * `sync`（既定。ローカル・E2E）は、応答の前に、全期間を評価する。`deferred`（AWS の Lambda）は、応答の前に、「現在」（短期の評価）だけを
 * 評価し（Issue #591）、「期間の評価」（長期の評価）と、状態の変化の処理（通知・連携）は、定期の評価（JB-02）が行う。
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
  const evaluateCurrent = vi.spyOn(context.container.evaluationService, 'evaluateCurrent');
  return { context, evaluateAffected, evaluateCurrent };
}

function input(equipmentId: EquipmentId = ROBOT_ID) {
  return {
    equipmentId,
    category: 'FAILURE' as const,
    observedAt: new Date(TEST_NOW.getTime() - 3_600_000).toISOString(),
    items: { failureCount: 1, recoveryMinutes: 30 },
  };
}

/** 環境センサーへの入力（センサーに入力できるカテゴリは、環境情報だけ。Issue #360）。 */
function sensorInput() {
  return {
    equipmentId: SENSOR_ID,
    category: 'ENVIRONMENT' as const,
    observedAt: new Date(TEST_NOW.getTime() - 3_600_000).toISOString(),
    items: { temperatureCelsius: 25 },
  };
}

async function savedCount(context: Awaited<ReturnType<typeof setup>>['context']) {
  return (await context.container.repositories.evaluations.listLatest(ROBOT_ID)).length;
}

/** ロボットの評価結果のうち、指定した視点の数。 */
async function savedCountOf(
  context: Awaited<ReturnType<typeof setup>>['context'],
  horizon: 'SHORT' | 'LONG',
) {
  return (await context.container.repositories.evaluations.listLatest(ROBOT_ID)).filter(
    (result) => result.horizon === horizon,
  ).length;
}

describe('評価を、保存の応答の前に行う（EVALUATION_ON_WRITE=sync。既定）', () => {
  it('保存・修正・削除のたびに、影響する設備の評価を実行し、応答の評価の状態は DONE', async () => {
    const { context, evaluateAffected } = await setup();
    const service = context.container.manualEntryService;

    const created = await service.create(input(), ACTOR);
    const updated = await service.update(created.entry.entryId, sensorInput(), ACTOR);
    const deleted = await service.delete(created.entry.entryId, ACTOR);

    expect(context.config.evaluationOnWrite).toBe('sync');
    expect(created.evaluation).toBe('DONE');
    expect(updated.evaluation).toBe('DONE');
    expect(deleted.evaluation).toBe('DONE');
    // 設備を変更した修正は、変更前と変更後の設備を評価する。削除は、修正後の設備（センサー）を評価する
    expect(evaluateAffected.mock.calls.map(([, ids]) => ids)).toEqual([
      [ROBOT_ID],
      [ROBOT_ID, SENSOR_ID],
      [SENSOR_ID],
    ]);
    expect(await savedCount(context)).toBe(40);
  });

  it('「現在」だけの評価（evaluateCurrent）は、呼ばない（全期間を評価するため）', async () => {
    const { context, evaluateCurrent } = await setup();

    await context.container.manualEntryService.create(input(), ACTOR);

    expect(evaluateCurrent).not.toHaveBeenCalled();
  });
});

describe('「現在」（短期の評価）だけを、保存の応答の前に行う（EVALUATION_ON_WRITE=deferred。AWS。Issue #591）', () => {
  it('保存・修正・削除で、「現在」だけを評価する（全期間の評価は、しない）。応答の評価の状態は CURRENT。保存するのは、短期の結果だけ', async () => {
    const { context, evaluateAffected, evaluateCurrent } = await setup('deferred');
    const service = context.container.manualEntryService;

    const created = await service.create(input(), ACTOR);
    const afterCreate = {
      short: await savedCountOf(context, 'SHORT'),
      long: await savedCountOf(context, 'LONG'),
    };
    const updated = await service.update(created.entry.entryId, sensorInput(), ACTOR);
    const deleted = await service.delete(created.entry.entryId, ACTOR);

    expect(context.config.evaluationOnWrite).toBe('deferred');
    expect(created.evaluation).toBe('CURRENT');
    expect(updated.evaluation).toBe('CURRENT');
    expect(deleted.evaluation).toBe('CURRENT');
    expect(evaluateAffected).not.toHaveBeenCalled();
    // 設備を変更した修正は、変更前と変更後の設備。削除は、修正後の設備（センサー）
    expect(evaluateCurrent.mock.calls.map(([, ids]) => ids)).toEqual([
      [ROBOT_ID],
      [ROBOT_ID, SENSOR_ID],
      [SENSOR_ID],
    ]);
    // 短期の結果だけが保存され、長期の結果は、ない（定期の評価が作る）
    expect(afterCreate.short).toBeGreaterThan(0);
    expect(afterCreate.long).toBe(0);
    expect(await savedCountOf(context, 'LONG')).toBe(0);
  });

  it('「現在」の評価に失敗したときは、入力の保存の結果には影響させず、応答の評価の状態は DEFERRED（定期の評価に任せる）', async () => {
    const { context, evaluateCurrent } = await setup('deferred');
    evaluateCurrent.mockRejectedValueOnce(new Error('評価の失敗（テスト）'));

    const created = await context.container.manualEntryService.create(input(), ACTOR);

    expect(created.evaluation).toBe('DEFERRED');
    expect(
      (await context.container.repositories.manualEntries.get(created.entry.entryId))?.isDeleted,
    ).toBe(false);
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

  it('関連する観点のステータスは、「現在」（いま評価した）と「期間の評価」（前回の評価。まだなければ null）を、別々に返す', async () => {
    const { context } = await setup('deferred');
    const service = context.container.manualEntryService;

    const before = await service.create(input(), ACTOR);
    await context.container.evaluationService.evaluateAll('SCHEDULED');
    const after = await service.create(
      { ...input(), observedAt: new Date(TEST_NOW.getTime() - 7_200_000).toISOString() },
      ACTOR,
    );

    // 最初の保存: 「現在」は、いま評価した。「期間の評価」は、まだない（定期の評価が、まだ）
    expect(before.viewpointStatuses.length).toBeGreaterThan(0);
    expect(
      before.viewpointStatuses.every((item) => item.current !== null && item.period === null),
    ).toBe(true);
    // 定期の評価のあと: 両方ある。status は、短期・長期の悪い方（従来どおり）
    expect(after.viewpointStatuses.length).toBeGreaterThan(0);
    for (const item of after.viewpointStatuses) {
      expect(item.period).not.toBeNull();
    }
  });

  it('削除の応答（DELETE。200）にも、評価の状態（CURRENT）と、関連観点のステータスを含める。応答は、共有のスキーマで読める（Issue #150）', async () => {
    const { context } = await setup('deferred');
    const { entry } = await context.container.manualEntryService.create(input(), ACTOR);
    await context.container.evaluationService.evaluateAll('SCHEDULED');

    const response = await context.request(`/manual-entries/${entry.entryId}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    const body = ManualEntrySaveResponseSchema.parse(await response.json());
    expect(body.evaluation).toBe('CURRENT');
    expect(body.entry).toMatchObject({ entryId: entry.entryId, isDeleted: true });
    expect(body.viewpointStatuses.length).toBeGreaterThan(0);
  });

  it('定期の評価（JB-02。evaluateAll）が、「期間の評価」（長期）と、状態の変化の処理を行う。「現在」は、保存の応答の前に評価済み', async () => {
    const { context } = await setup('deferred');

    await context.container.manualEntryService.create(input(), ACTOR);
    expect(await savedCountOf(context, 'LONG')).toBe(0);
    expect(await savedCountOf(context, 'SHORT')).toBeGreaterThan(0);
    const summary = await context.container.evaluationService.evaluateAll('SCHEDULED');

    expect(summary.equipmentEvaluated).toBe(3);
    expect(await savedCount(context)).toBe(40);
    expect(
      (await context.container.repositories.evaluations.listLatest(FACILITY_ID)).length,
    ).toBeGreaterThan(0);
  });

  it('API の応答に、evaluation（CURRENT）が含まれる。応答は、共有のスキーマで読める', async () => {
    const { context } = await setup('deferred');

    const response = await context.request('/manual-entries', { method: 'POST', body: input() });

    expect(response.status).toBe(201);
    const body = ManualEntrySaveResponseSchema.parse(await response.json());
    expect(body.evaluation).toBe('CURRENT');
  });
});
