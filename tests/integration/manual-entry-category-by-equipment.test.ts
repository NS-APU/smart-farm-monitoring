/**
 * 手動入力の、対象の設備の種別ごとのカテゴリの制限の結合テスト（Issue #360）。
 * - ハウス: 満足度情報だけ／ロボット: 環境情報・満足度情報以外／環境センサー: 環境情報だけ
 * - 新しい入力と、対象かカテゴリを変える修正は、合わない組み合わせを 400（フィールド: category）で拒否する
 * - 既存の入力（合わない組み合わせ）は、対象・カテゴリを変えない修正（備考だけの変更など）で、そのまま扱える
 */

import { describe, expect, it } from 'vitest';
import { satisfactionItemKey } from '@smart-farm/shared/constants/items';
import { SATISFACTION_TARGET_VIEWPOINT_IDS } from '@smart-farm/shared/constants/viewpoints';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { FACILITY_ID, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import { errorOf, TEST_NOW, withEquipment, type TestContext } from '../support/test-context.ts';

const OBSERVED_AT = new Date(TEST_NOW.getTime() - 3_600_000).toISOString();

const SATISFACTION_ITEMS = Object.fromEntries(
  SATISFACTION_TARGET_VIEWPOINT_IDS.map((id) => [satisfactionItemKey(id), 4]),
);

/** 種別ごとの、合う入力と、合わない入力。 */
const FAILURE_ITEMS = { failureCount: 1 };
const ENVIRONMENT_ITEMS = { temperatureCelsius: 25 };

function post(context: TestContext, body: Record<string, unknown>) {
  return context.request('/manual-entries', { method: 'POST', body });
}

function put(context: TestContext, entryId: string, body: Record<string, unknown>) {
  return context.request(`/manual-entries/${entryId}`, { method: 'PUT', body });
}

describe('新しい入力: 対象の設備の種別に合うカテゴリだけ保存できる', () => {
  it.each([
    ['ハウス', FACILITY_ID, 'SATISFACTION', SATISFACTION_ITEMS],
    ['ロボット', ROBOT_ID, 'FAILURE', FAILURE_ITEMS],
    ['環境センサー', SENSOR_ID, 'ENVIRONMENT', ENVIRONMENT_ITEMS],
  ] as const)(
    '%s: 合うカテゴリは、保存できる（201）',
    async (_name, equipmentId, category, items) => {
      const context = await withEquipment();

      const response = await post(context, {
        equipmentId,
        category,
        observedAt: OBSERVED_AT,
        items,
      });

      expect(response.status).toBe(201);
    },
  );

  it.each([
    ['ハウス', FACILITY_ID, 'FAILURE', FAILURE_ITEMS],
    ['ハウス', FACILITY_ID, 'ENVIRONMENT', ENVIRONMENT_ITEMS],
    ['ロボット', ROBOT_ID, 'ENVIRONMENT', ENVIRONMENT_ITEMS],
    ['ロボット', ROBOT_ID, 'SATISFACTION', SATISFACTION_ITEMS],
    ['環境センサー', SENSOR_ID, 'FAILURE', FAILURE_ITEMS],
    ['環境センサー', SENSOR_ID, 'SATISFACTION', SATISFACTION_ITEMS],
  ] as const)(
    '%s（%s）に、合わないカテゴリ %s は、400（category）で拒否し、保存しない',
    async (_name, equipmentId, category, items) => {
      const context = await withEquipment();

      const response = await post(context, {
        equipmentId,
        category,
        observedAt: OBSERVED_AT,
        items,
      });

      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.fields?.map((field) => field.name)).toEqual(['category']);
      expect(error.fields?.[0]?.message).toContain('には入力できません');
      expect(
        (await context.container.repositories.manualEntries.list({}, { limit: 10 })).items,
      ).toHaveLength(0);
    },
  );
});

describe('修正: 既存の組み合わせは、そのまま修正できる', () => {
  async function saveLegacy(context: TestContext) {
    // 以前は、ハウスにも、故障情報を入力できた（既存のデータ）
    await context.container.repositories.manualEntries.save({
      entryId: 'legacy-house-failure',
      equipmentId: FACILITY_ID,
      category: 'FAILURE',
      observedAt: OBSERVED_AT,
      items: FAILURE_ITEMS,
      enteredBy: toUserId('test-user'),
      createdAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT,
      isDeleted: false,
    });
  }

  it('対象・カテゴリを変えない修正（値・備考の変更）は、合わない組み合わせでも、保存できる', async () => {
    const context = await withEquipment();
    await saveLegacy(context);

    const response = await put(context, 'legacy-house-failure', {
      equipmentId: FACILITY_ID,
      category: 'FAILURE',
      observedAt: OBSERVED_AT,
      items: { failureCount: 3 },
      note: '備考だけ直した',
    });

    expect(response.status).toBe(200);
  });

  it('カテゴリを、合わないものへ変える修正は、400（category）。対象を、合わないものへ変える修正も、400', async () => {
    const context = await withEquipment();
    await saveLegacy(context);

    const toEnvironment = await put(context, 'legacy-house-failure', {
      equipmentId: FACILITY_ID,
      category: 'ENVIRONMENT',
      observedAt: OBSERVED_AT,
      items: ENVIRONMENT_ITEMS,
    });
    const toSensor = await put(context, 'legacy-house-failure', {
      equipmentId: SENSOR_ID,
      category: 'FAILURE',
      observedAt: OBSERVED_AT,
      items: FAILURE_ITEMS,
    });

    expect(toEnvironment.status).toBe(400);
    expect(toSensor.status).toBe(400);
    expect((await errorOf(toSensor)).fields?.map((field) => field.name)).toEqual(['category']);
  });

  it('対象とカテゴリを、合う組み合わせへ変える修正は、保存できる', async () => {
    const context = await withEquipment();
    await saveLegacy(context);

    const response = await put(context, 'legacy-house-failure', {
      equipmentId: ROBOT_ID,
      category: 'FAILURE',
      observedAt: OBSERVED_AT,
      items: FAILURE_ITEMS,
    });

    expect(response.status).toBe(200);
  });
});
