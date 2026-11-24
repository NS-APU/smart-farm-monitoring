/**
 * 判断基準の「影響のプレビュー」の結合テスト（Issue #165 の SC-13-2。UC-19。ADR-0017 の D-24。POST /viewpoints/{id}/criteria/preview）。
 * 入力途中の閾値を、保存済みの評価結果（メトリクス・ステータスコードのカテゴリ）に当てて再判定し、状態が変わる設備・観点を返す
 * （観測値は読まない。保存しない）。ハウスは、配下の設備の再判定した結果を、最も悪いものに再集計する。
 */

import { describe, expect, it } from 'vitest';
import { combineHorizonStatuses } from '../../src/backend/domain/evaluation/grading.ts';
import { getDefaultCriteria } from '../../src/shared/constants/default-criteria.ts';
import { defaultPeriodDays, type ViewpointId } from '../../src/shared/constants/viewpoints.ts';
import type { EvaluationStatus } from '../../src/shared/constants/status.ts';
import { toEquipmentId, toUserId } from '../../src/shared/schemas/common.ts';
import {
  CriteriaPreviewResponseSchema,
  type Criterion,
} from '../../src/shared/schemas/criteria.ts';
import type { Equipment } from '../../src/shared/schemas/equipment.ts';
import {
  FACILITY_2_ID,
  FACILITY_ID,
  equipmentSet,
  observation,
  ROBOT_ID,
  SENSOR_2_ID,
  SENSOR_ID,
  secondHouseSet,
} from '../support/builders.ts';
import {
  addUserAndLogin,
  createTestContext,
  errorOf,
  markPasswordChanged,
  TEST_NOW,
  THREE_ROLES_JSON,
  withEquipment,
  type TestContext,
} from '../support/test-context.ts';

const ENVIRONMENT = 'environmentalAdaptability';
const PREVIEW_URL = `/viewpoints/${ENVIRONMENT}/criteria/preview`;
const SENSOR_3_ID = toEquipmentId('SENSOR-T1B');
const AT = new Date(TEST_NOW.getTime() - 60_000).toISOString();

/** 環境適応性の判断基準（温度の正常上限だけを変える）。 */
function environmentCriteria(normalUpper = 25): { criteria: Criterion[] } {
  const defaults = getDefaultCriteria(ENVIRONMENT).criteria;
  return {
    criteria: defaults.map((criterion) =>
      criterion.indicator === 'temperatureCelsius' && criterion.kind === 'RANGE'
        ? { ...criterion, thresholds: { ...criterion.thresholds, normalUpper } }
        : criterion,
    ),
  };
}

function sensor(equipmentId: typeof SENSOR_3_ID, facilityId: typeof FACILITY_ID): Equipment {
  return {
    equipmentId,
    equipmentType: 'SENSOR',
    name: `環境センサー（${equipmentId}）`,
    facilityId,
    isDeleted: false,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

async function preview(
  context: TestContext,
  body: unknown,
  token?: string,
  viewpoint = ENVIRONMENT,
) {
  return context.request(`/viewpoints/${viewpoint}/criteria/preview`, {
    method: 'POST',
    body,
    ...(token === undefined ? {} : { token }),
  });
}

async function previewOf(context: TestContext, body: unknown, token?: string) {
  const response = await preview(context, body, token);
  expect(response.status).toBe(200);
  return CriteriaPreviewResponseSchema.parse(await response.json());
}

/** ハウスに、環境センサーが 2 台（SENSOR-T1: 20℃、SENSOR-T1B: 27℃）ある状態で、全設備を評価する。 */
async function withTwoSensors() {
  const context = await withEquipment();
  await context.container.repositories.equipment.save(sensor(SENSOR_3_ID, FACILITY_ID));
  await context.container.repositories.observations.saveMany([
    observation({
      equipmentId: SENSOR_ID,
      itemKey: 'temperatureCelsius',
      value: 20,
      observedAt: AT,
    }),
    observation({
      equipmentId: SENSOR_3_ID,
      itemKey: 'temperatureCelsius',
      value: 27,
      observedAt: AT,
    }),
  ]);
  await context.container.evaluationService.evaluateAll('DEV');
  return context;
}

/** 保存済みの評価結果から、観点の状態（短期・長期の既定の期間のうち「不明」を除いた悪い方）を求める。 */
async function savedStatusOf(
  context: TestContext,
  equipmentId: Equipment['equipmentId'],
  viewpointId: ViewpointId,
): Promise<EvaluationStatus | undefined> {
  const results = await context.container.repositories.evaluations.listLatest(equipmentId);
  const long = results.find(
    (result) =>
      result.viewpointId === viewpointId &&
      result.horizon === 'LONG' &&
      result.periodDays === defaultPeriodDays(viewpointId),
  );
  const short = results.find(
    (result) => result.viewpointId === viewpointId && result.horizon === 'SHORT',
  );
  return long === undefined
    ? undefined
    : combineHorizonStatuses(short?.status ?? null, long.status);
}

describe('影響のプレビュー（POST /viewpoints/{id}/criteria/preview）: 状態が変わる設備・観点', () => {
  it('入力途中の閾値で、状態が変わる設備だけを「現在 → 変更後」で返す。ハウスは、配下の設備の結果を再集計する（複数台）', async () => {
    const context = await withTwoSensors();

    // 温度の正常上限を 25℃ → 30℃: 27℃ のセンサーは、注意 → 正常。20℃ のセンサーは、変わらない
    const result = await previewOf(context, environmentCriteria(30));

    expect(result.viewpointId).toBe(ENVIRONMENT);
    expect(result.changes).toEqual([
      {
        equipmentId: FACILITY_ID,
        equipmentName: 'テストハウス',
        equipmentType: 'FACILITY',
        current: 'CAUTION',
        after: 'NORMAL',
      },
      {
        equipmentId: SENSOR_3_ID,
        equipmentName: `環境センサー（${SENSOR_3_ID}）`,
        equipmentType: 'SENSOR',
        current: 'CAUTION',
        after: 'NORMAL',
      },
    ]);
    expect(result.unevaluated).toEqual([]);
    expect(result.unknownCount).toBe(0);
    // この観点の対象: ハウス 1・センサー 2（ロボットは、環境適応性の対象外）
    expect(result.targetCount).toBe(3);
    expect(result.evaluatedAt).toBe(TEST_NOW.toISOString());
  });

  it('悪化する変更（正常上限を 20℃ 未満にする）も出す。ハウスは、最も悪い設備に合わせて再集計する（20℃ のセンサーも、正常 → 注意）', async () => {
    const context = await withTwoSensors();

    const result = await previewOf(context, environmentCriteria(20));

    const byId = Object.fromEntries(result.changes.map((item) => [item.equipmentId, item]));
    expect(byId[SENSOR_ID]).toMatchObject({ current: 'NORMAL', after: 'CAUTION' });
    // 27℃ のセンサーは、すでに注意（正常上限が上がっても下がっても注意）。ハウスも、注意のまま
    expect(byId[SENSOR_3_ID]).toBeUndefined();
    expect(byId[FACILITY_ID]).toBeUndefined();
  });

  it('変わらないとき（現在と同じ閾値）は、変わる設備を返さない（対象の数は返す）', async () => {
    const context = await withTwoSensors();

    const result = await previewOf(context, environmentCriteria(25));

    expect(result.changes).toEqual([]);
    expect(result.targetCount).toBe(3);
  });

  it('プレビューは、保存しない: 判断基準・変更履歴・保存済みの評価結果は、変わらない（何度押しても同じ）', async () => {
    const context = await withTwoSensors();
    const before = await context.container.repositories.evaluations.listLatest(FACILITY_ID);

    const first = await previewOf(context, environmentCriteria(30));
    const second = await previewOf(context, environmentCriteria(30));

    expect(second).toEqual(first);
    const criteria = (await (
      await context.request(`/viewpoints/${ENVIRONMENT}/criteria`)
    ).json()) as {
      isDefault: boolean;
      version: string;
    };
    expect(criteria).toMatchObject({ isDefault: true, version: 'DEFAULT' });
    const audit = (await (await context.request('/audit-logs?targetType=criteria')).json()) as {
      items: unknown[];
    };
    expect(audit.items).toHaveLength(0);
    expect(await context.container.repositories.evaluations.listLatest(FACILITY_ID)).toEqual(
      before,
    );
  });

  it('実際の評価との一致: プレビューの「変更後」は、同じ閾値を保存して評価し直した後の、設備・ハウスの状態と一致する', async () => {
    const context = await withTwoSensors();
    const draft = environmentCriteria(28);
    const preview1 = await previewOf(context, draft);
    const currentOf = (equipmentId: Equipment['equipmentId']) =>
      preview1.changes.find((item) => item.equipmentId === equipmentId);

    const saved = await context.request(`/viewpoints/${ENVIRONMENT}/criteria`, {
      method: 'PUT',
      body: draft,
      headers: {
        'if-match':
          (await context.request(`/viewpoints/${ENVIRONMENT}/criteria`)).headers.get('etag') ?? '',
      },
    });
    expect(saved.status).toBe(200);

    for (const equipmentId of [FACILITY_ID, SENSOR_ID, SENSOR_3_ID]) {
      const actual = await savedStatusOf(context, equipmentId, ENVIRONMENT);
      const predicted = currentOf(equipmentId)?.after;
      // 変わる設備は「変更後」と一致する。変わらない設備は、プレビューに出ず、評価の後も同じ状態のまま
      expect(predicted ?? actual).toBe(actual);
    }
    expect(await savedStatusOf(context, SENSOR_3_ID, ENVIRONMENT)).toBe('NORMAL');
    expect(await savedStatusOf(context, FACILITY_ID, ENVIRONMENT)).toBe('NORMAL');
  });
});

describe('影響のプレビュー: 未評価・「不明」・削除済み・「現在」の決め方', () => {
  it('一度も評価されていない設備（保存済みの結果がない）は、変わる設備に含めず、未評価として、区別して返す', async () => {
    const context = await withTwoSensors();
    await context.container.repositories.equipment.save({
      ...sensor(toEquipmentId('SENSOR-NEW'), FACILITY_ID),
      name: '新しいセンサー',
    });

    const result = await previewOf(context, environmentCriteria(30));

    expect(result.unevaluated).toEqual([
      { equipmentId: 'SENSOR-NEW', equipmentName: '新しいセンサー', equipmentType: 'SENSOR' },
    ]);
    expect(result.changes.map((item) => item.equipmentId)).not.toContain('SENSOR-NEW');
    expect(result.targetCount).toBe(4);
  });

  it('状態が「不明」の設備（観測値がない）は、閾値を変えても「不明」のまま。変わる設備に含めず、数だけ返す', async () => {
    const context = await withEquipment();
    // 観測値のないまま評価する（センサー・ハウスの環境適応性は「不明」）
    await context.container.evaluationService.evaluateAll('DEV');

    const result = await previewOf(context, environmentCriteria(30));

    expect(result.changes).toEqual([]);
    expect(result.unevaluated).toEqual([]);
    // ハウスとセンサーの 2 件
    expect(result.unknownCount).toBe(2);
  });

  it('削除済みの設備は、対象に含めない（ハウスの再集計にも使わない）', async () => {
    const context = await withTwoSensors();
    // 27℃ のセンサーを削除する。ハウスの再集計の対象から外れ、現在のハウスの結果（保存済み）は、まだ古い（注意）
    await context.container.repositories.equipment.save({
      ...sensor(SENSOR_3_ID, FACILITY_ID),
      isDeleted: true,
    });

    const result = await previewOf(context, environmentCriteria(30));

    expect(result.targetCount).toBe(2);
    expect(result.changes.map((item) => item.equipmentId)).not.toContain(SENSOR_3_ID);
    // 現在: 20℃ のセンサーだけの再集計は、正常（保存済みのハウスの注意ではなく、同じ保存済みの結果に、現在・変更後の両方を当てる）。変更なし
    expect(result.changes).toEqual([]);
  });

  it('「現在」は、保存済みのステータスではなく、現在の判断基準を保存済みの結果に当てた判定。評価の前に、判断基準が変わっていても、閾値と無関係な差を出さない', async () => {
    const context = await withTwoSensors();
    // 判断基準を、保存だけして（評価し直さない）、保存済みの結果が、変更前の判断基準の結果のままの状態にする
    await context.container.repositories.criteria.save({
      ...getDefaultCriteria(ENVIRONMENT),
      criteria: environmentCriteria(30).criteria,
      version: 'CUSTOM-1',
      isDefault: false,
      updatedAt: TEST_NOW.toISOString(),
      updatedBy: toUserId('test-user'),
    });
    expect(await savedStatusOf(context, SENSOR_3_ID, ENVIRONMENT)).toBe('CAUTION');

    // 現在の判断基準（正常上限 30℃）と同じ内容を、入力途中の閾値にした: 差はない
    const same = await previewOf(context, environmentCriteria(30));
    expect(same.changes).toEqual([]);

    // 現在の判断基準から、25℃ に戻す: 27℃ のセンサーは、「現在」が正常（30℃ で再判定）、「変更後」が注意
    const tightened = await previewOf(context, environmentCriteria(25));
    expect(tightened.changes).toContainEqual(
      expect.objectContaining({ equipmentId: SENSOR_3_ID, current: 'NORMAL', after: 'CAUTION' }),
    );
  });

  it('ロボットの観点（操作性）: ロボットと、ハウス（配下の最悪）の状態が変わる設備として返す。センサーは、対象外', async () => {
    const context = await withEquipment();
    await context.container.repositories.observations.saveMany([
      observation({ itemKey: 'operationStepCount', value: 6, observedAt: AT }),
      observation({ itemKey: 'operationMinutes', value: 8, observedAt: AT }),
      observation({ itemKey: 'operationErrorCount', value: 0, observedAt: AT }),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');
    // 操作ステップ数: 既定は 5 以上で注意（6 は注意）。注意開始値を 8 にすると、正常
    const defaults = getDefaultCriteria('operability').criteria.map((criterion) =>
      criterion.indicator === 'operationStepCount' && criterion.kind === 'UPPER'
        ? { ...criterion, thresholds: { cautionFrom: 8, errorFrom: 12 } }
        : criterion,
    );

    const response = await preview(context, { criteria: defaults }, undefined, 'operability');

    expect(response.status).toBe(200);
    const result = CriteriaPreviewResponseSchema.parse(await response.json());
    expect(result.changes.map((item) => [item.equipmentId, item.current, item.after])).toEqual([
      [FACILITY_ID, 'CAUTION', 'NORMAL'],
      [ROBOT_ID, 'CAUTION', 'NORMAL'],
    ]);
    // ハウス 1・ロボット 1（センサーは、操作性の対象外）
    expect(result.targetCount).toBe(2);
  });
});

describe('影響のプレビュー: 検証・権限・閲覧範囲', () => {
  it('入力が不正なときは、保存と同じ検証で 400（VALIDATION_ERROR）。メッセージも、保存と同じ', async () => {
    const context = await withTwoSensors();
    // 大小関係が成り立たない（正常下限 > 正常上限）
    const invalid = environmentCriteria(5);

    const previewResponse = await preview(context, invalid);
    const saveResponse = await context.request(`/viewpoints/${ENVIRONMENT}/criteria`, {
      method: 'PUT',
      body: invalid,
      headers: {
        'if-match':
          (await context.request(`/viewpoints/${ENVIRONMENT}/criteria`)).headers.get('etag') ?? '',
      },
    });

    expect(previewResponse.status).toBe(400);
    expect(saveResponse.status).toBe(400);
    const previewError = await errorOf(previewResponse);
    expect(previewError.code).toBe('VALIDATION_ERROR');
    expect(previewError).toEqual(await errorOf(saveResponse));
  });

  it('この観点で編集できない指標・重複・不足は、保存と同じく 400', async () => {
    const context = await withTwoSensors();
    const { criteria } = environmentCriteria();
    const first = criteria[0];
    if (first === undefined) {
      throw new Error('テストの前提: 判断基準がある');
    }
    const bodies = [
      { criteria: [...criteria, { ...first, indicator: 'statusCode' }] },
      { criteria: [...criteria, first] },
      { criteria: criteria.slice(1) },
    ];

    for (const body of bodies) {
      const response = await preview(context, body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('VALIDATION_ERROR');
    }
  });

  it('存在しない観点は 404。本文が JSON でないときは 400', async () => {
    const context = await withTwoSensors();

    expect((await preview(context, environmentCriteria(), undefined, 'nothing')).status).toBe(404);
    const broken = await context.request(PREVIEW_URL, { method: 'POST', body: undefined });
    expect(broken.status).toBe(400);
  });

  it('権限は、判断基準の変更（criteria:edit）と同じ: 権限のない利用者は 403、未認証は 401', async () => {
    const context = await createTestContext({ env: { ROLE_DEFINITIONS_JSON: THREE_ROLES_JSON } });
    const viewer = await addUserAndLogin(context, { userId: 'viewer-1', role: 'viewer' });
    const evaluator = await addUserAndLogin(context, { userId: 'evaluator-1', role: 'evaluator' });
    await markPasswordChanged(context, 'viewer-1');
    await markPasswordChanged(context, 'evaluator-1');

    const denied = await preview(context, environmentCriteria(), viewer);
    const allowed = await preview(context, environmentCriteria(), evaluator);
    const anonymous = await context.app.request(`/api/v1${PREVIEW_URL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(environmentCriteria()),
    });

    expect(denied.status).toBe(403);
    expect((await errorOf(denied)).code).toBe('FORBIDDEN');
    expect(allowed.status).toBe(200);
    expect(anonymous.status).toBe(401);
  });

  it('閲覧範囲: 全設備を閲覧できない利用者には、割り当てたハウス（と配下）だけを対象にする。範囲外の設備・ハウスは、含めない', async () => {
    const context = await createTestContext({ env: { ROLE_DEFINITIONS_JSON: THREE_ROLES_JSON } });
    for (const equipment of [...equipmentSet(), ...secondHouseSet()]) {
      await context.container.repositories.equipment.save(equipment);
    }
    await context.container.repositories.observations.saveMany([
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 27,
        observedAt: AT,
      }),
      observation({
        equipmentId: SENSOR_2_ID,
        itemKey: 'temperatureCelsius',
        value: 27,
        observedAt: AT,
      }),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');
    const evaluator = await addUserAndLogin(context, { userId: 'evaluator-1', role: 'evaluator' });
    const nobody = await addUserAndLogin(context, { userId: 'evaluator-2', role: 'evaluator' });
    await markPasswordChanged(context, 'evaluator-1');
    await markPasswordChanged(context, 'evaluator-2');
    await context.container.repositories.facilityAccess.save({
      facilityId: FACILITY_ID,
      userIds: [toUserId('evaluator-1')],
    });

    const scoped = await previewOf(context, environmentCriteria(30), evaluator);
    const none = await previewOf(context, environmentCriteria(30), nobody);
    const admin = await previewOf(context, environmentCriteria(30));

    // 割り当てたハウス 1 のハウスとセンサーだけ（ハウス 2 とその配下は、含めない）
    expect(scoped.changes.map((item) => item.equipmentId).sort()).toEqual(
      [FACILITY_ID, SENSOR_ID].sort(),
    );
    expect(scoped.targetCount).toBe(2);
    // 割り当てがなければ、何もない（安全側）
    expect(none).toMatchObject({ changes: [], unevaluated: [], targetCount: 0, evaluatedAt: null });
    // 全設備を閲覧できる管理者は、両方のハウス
    expect(admin.changes.map((item) => item.equipmentId)).toEqual(
      expect.arrayContaining([FACILITY_ID, SENSOR_ID, FACILITY_2_ID, SENSOR_2_ID]),
    );
  });
});
