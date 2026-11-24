/**
 * 設備・ステータスコード・判断基準の登録・修正・削除の応答の前に、評価を再計算するかの設定
 * （`EVALUATION_ON_WRITE`。Issue #404。ADR-0014 の対象の拡張）の結合テスト。
 * `sync`（既定。ローカル・E2E）は、応答の前に全設備の評価を実行する。`deferred`（AWS の Lambda）は、評価せず、定期の評価（JB-02）が更新する。
 */

import { describe, expect, it, vi } from 'vitest';
import { EvaluationWriteResponseSchema } from '@smart-farm/shared/schemas/common';
import { CriteriaSaveResponseSchema } from '@smart-farm/shared/schemas/criteria';
import { EquipmentSaveResponseSchema } from '@smart-farm/shared/schemas/equipment';
import { StatusCodeSaveResponseSchema } from '@smart-farm/shared/schemas/status-code';
import { ROBOT_ID } from '../support/builders.ts';
import { withEquipment, type TestContext } from '../support/test-context.ts';

type Mode = 'sync' | 'deferred';

async function setup(mode?: Mode) {
  const context = await withEquipment(
    mode === undefined ? {} : { env: { EVALUATION_ON_WRITE: mode } },
  );
  const evaluateAll = vi.spyOn(context.container.evaluationService, 'evaluateAll');
  const evaluateAffected = vi.spyOn(context.container.evaluationService, 'evaluateAffected');
  return { context, evaluateAll, evaluateAffected };
}

async function savedCount(context: TestContext): Promise<number> {
  return (await context.container.repositories.evaluations.listLatest(ROBOT_ID)).length;
}

const NEW_ROBOT = {
  equipmentId: 'ROBOT-N1',
  equipmentType: 'ROBOT',
  name: '新しいロボット',
  facilityId: 'HOUSE-T1',
};
const NEW_CODE = { code: 'TEST_CODE', name: 'テスト用のコード', category: 'NORMAL' };

const CRITERIA_URL = '/viewpoints/environmentalAdaptability/criteria';
const environmentCriteria = (label: string) => [
  {
    indicator: 'temperatureCelsius',
    kind: 'RANGE',
    thresholds: { errorLower: 0, normalLower: 10, normalUpper: 25, errorUpper: 35 },
    label,
  },
  {
    indicator: 'humidityPercent',
    kind: 'RANGE',
    thresholds: { errorLower: 30, normalLower: 40, normalUpper: 80, errorUpper: 90 },
    label: '湿度',
  },
  {
    indicator: 'illuminanceLux',
    kind: 'RANGE',
    thresholds: { errorLower: 10000, normalLower: 20000, normalUpper: 40000, errorUpper: 50000 },
    label: '照度',
  },
  {
    indicator: 'co2Ppm',
    kind: 'RANGE',
    thresholds: { errorLower: 200, normalLower: 800, normalUpper: 1000, errorUpper: 3000 },
    label: 'CO2濃度',
  },
];

/** 現在の版（ETag）を If-Match に付けて、判断基準を更新する・既定値へ戻す。 */
async function criteriaRequest(context: TestContext, path: string, method: string, body?: unknown) {
  const etag = (await context.request(CRITERIA_URL)).headers.get('etag') ?? '';
  return context.request(path, {
    method,
    ...(body === undefined ? {} : { body }),
    headers: { 'if-match': etag },
  });
}

/** 設備・ステータスコード・判断基準の変更を、順に行う。応答の評価の状態を返す。 */
async function changeAll(context: TestContext) {
  const equipmentCreated = EquipmentSaveResponseSchema.parse(
    await (await context.request('/equipment', { method: 'POST', body: NEW_ROBOT })).json(),
  );
  const equipmentUpdated = EquipmentSaveResponseSchema.parse(
    await (
      await context.request('/equipment/ROBOT-N1', {
        method: 'PUT',
        body: { name: '改名したロボット', facilityId: 'HOUSE-T1' },
      })
    ).json(),
  );
  const equipmentDeleted = await context.request('/equipment/ROBOT-N1', { method: 'DELETE' });
  const codeCreated = StatusCodeSaveResponseSchema.parse(
    await (await context.request('/status-codes', { method: 'POST', body: NEW_CODE })).json(),
  );
  const codeUpdated = StatusCodeSaveResponseSchema.parse(
    await (
      await context.request('/status-codes/TEST_CODE', {
        method: 'PUT',
        body: { name: '修正したコード', category: 'CAUTION' },
      })
    ).json(),
  );
  const codeDeleted = await context.request('/status-codes/TEST_CODE', { method: 'DELETE' });
  const criteriaUpdated = CriteriaSaveResponseSchema.parse(
    await (
      await criteriaRequest(context, CRITERIA_URL, 'PUT', {
        criteria: environmentCriteria('温度（変更後）'),
      })
    ).json(),
  );
  const criteriaReset = CriteriaSaveResponseSchema.parse(
    await (await criteriaRequest(context, `${CRITERIA_URL}/reset`, 'POST')).json(),
  );
  return {
    equipmentCreated,
    equipmentUpdated,
    equipmentDeleted,
    codeCreated,
    codeUpdated,
    codeDeleted,
    criteriaUpdated,
    criteriaReset,
  };
}

describe('評価を、保存の応答の前に行う（EVALUATION_ON_WRITE=sync。既定）', () => {
  it('設備・ステータスコード・判断基準の登録・修正・削除・既定値へ戻す操作のたびに、全設備の評価を実行し、応答の評価の状態は DONE', async () => {
    const { context, evaluateAll, evaluateAffected } = await setup();

    const result = await changeAll(context);

    expect(context.config.evaluationOnWrite).toBe('sync');
    expect(evaluateAll.mock.calls.map(([trigger]) => trigger)).toEqual([
      'EQUIPMENT_CHANGE',
      'EQUIPMENT_CHANGE',
      'EQUIPMENT_CHANGE',
      'STATUS_CODE_CHANGE',
      'STATUS_CODE_CHANGE',
      'STATUS_CODE_CHANGE',
      'CRITERIA_CHANGE',
      'CRITERIA_CHANGE',
    ]);
    expect(evaluateAffected).not.toHaveBeenCalled();
    expect(result.equipmentCreated.evaluation).toBe('DONE');
    expect(result.equipmentUpdated.evaluation).toBe('DONE');
    expect(result.equipmentDeleted.status).toBe(200);
    expect(EvaluationWriteResponseSchema.parse(await result.equipmentDeleted.json())).toEqual({
      evaluation: 'DONE',
    });
    expect(result.codeCreated.evaluation).toBe('DONE');
    expect(result.codeUpdated.evaluation).toBe('DONE');
    expect(result.codeDeleted.status).toBe(200);
    expect(EvaluationWriteResponseSchema.parse(await result.codeDeleted.json())).toEqual({
      evaluation: 'DONE',
    });
    expect(result.criteriaUpdated.evaluation).toBe('DONE');
    expect(result.criteriaReset.evaluation).toBe('DONE');
    expect(await savedCount(context)).toBeGreaterThan(0);
  });
});

describe('評価を、保存の応答の前に行わない（EVALUATION_ON_WRITE=deferred。AWS）', () => {
  it('設備・ステータスコード・判断基準の変更で、評価を実行しない。応答の評価の状態は DEFERRED。評価の結果は、増えない', async () => {
    const { context, evaluateAll, evaluateAffected } = await setup('deferred');

    const result = await changeAll(context);

    expect(context.config.evaluationOnWrite).toBe('deferred');
    expect(evaluateAll).not.toHaveBeenCalled();
    expect(evaluateAffected).not.toHaveBeenCalled();
    expect(result.equipmentCreated.evaluation).toBe('DEFERRED');
    expect(result.equipmentUpdated.evaluation).toBe('DEFERRED');
    expect(result.equipmentDeleted.status).toBe(200);
    expect(EvaluationWriteResponseSchema.parse(await result.equipmentDeleted.json())).toEqual({
      evaluation: 'DEFERRED',
    });
    expect(result.codeCreated.evaluation).toBe('DEFERRED');
    expect(result.codeUpdated.evaluation).toBe('DEFERRED');
    expect(EvaluationWriteResponseSchema.parse(await result.codeDeleted.json())).toEqual({
      evaluation: 'DEFERRED',
    });
    expect(result.criteriaUpdated.evaluation).toBe('DEFERRED');
    expect(result.criteriaReset.evaluation).toBe('DEFERRED');
    expect(await savedCount(context)).toBe(0);
  });

  it('変更そのもの（設備・ステータスコード・判断基準・変更履歴）は、これまでどおり、応答の前に保存される', async () => {
    const { context } = await setup('deferred');

    await context.request('/equipment', { method: 'POST', body: NEW_ROBOT });
    await context.request('/status-codes', { method: 'POST', body: NEW_CODE });
    await criteriaRequest(context, CRITERIA_URL, 'PUT', {
      criteria: environmentCriteria('温度（変更後）'),
    });

    const { repositories } = context.container;
    expect((await repositories.equipment.list()).map((item) => item.equipmentId)).toContain(
      'ROBOT-N1',
    );
    expect((await repositories.statusCodes.get('TEST_CODE'))?.name).toBe('テスト用のコード');
    expect((await repositories.criteria.get('environmentalAdaptability'))?.version).toBe(
      'CUSTOM-1',
    );
    const audit = await repositories.auditLogs.list({}, { limit: 50 });
    expect(audit.items.map((item) => item.targetType).sort()).toEqual([
      'criteria',
      'equipment',
      'status-code',
    ]);
  });

  it('定期の評価（JB-02。evaluateAll）が、変更を、評価に反映する', async () => {
    const { context } = await setup('deferred');

    await context.request('/equipment', { method: 'POST', body: NEW_ROBOT });
    const before = await context.container.repositories.evaluations.listLatest(
      NEW_ROBOT.equipmentId as never,
    );
    const summary = await context.container.evaluationService.evaluateAll('SCHEDULED');
    const after = await context.container.repositories.evaluations.listLatest(
      NEW_ROBOT.equipmentId as never,
    );

    expect(before).toEqual([]);
    expect(summary.equipmentEvaluated).toBe(4);
    expect(after.length).toBeGreaterThan(0);
  });

  it('保存の検証に失敗したとき（重複など）は、従来どおりのエラーで、評価の状態は返さない', async () => {
    const { context, evaluateAll } = await setup('deferred');

    const response = await context.request('/equipment', {
      method: 'POST',
      body: { ...NEW_ROBOT, equipmentId: 'ROBOT-T1' },
    });

    expect(response.status).toBe(409);
    expect(evaluateAll).not.toHaveBeenCalled();
  });
});
