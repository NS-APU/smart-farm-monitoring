/**
 * 評価の観測値の読み取りの共有（Issue #165 の PR 3。負荷テストの同時の保存の応答時間）の結合テスト。
 * ハウスの評価は、配下の設備の観測値も読む（運用面の観点。D-19）。評価の対象が 1 つのハウス（と配下）だけの回は、配下の設備を先に評価した
 * ときの読み取りを使い、同じ観測値（最長 90 日）を読み直さない。複数のハウスをまたぐ回は、共有しない（保持する量を抑えるため）。
 * 共有しても、評価の結果（ステータス・メトリクス・診断メッセージ）は、変わらない。
 */

import { describe, expect, it, vi } from 'vitest';
import type { EquipmentId } from '../../src/shared/schemas/common.ts';
import {
  equipmentSet,
  FACILITY_2_ID,
  FACILITY_ID,
  observation,
  ROBOT_2_ID,
  ROBOT_ID,
  SENSOR_2_ID,
  SENSOR_ID,
  secondHouseSet,
} from '../support/builders.ts';
import { createTestContext, TEST_NOW, type TestContext } from '../support/test-context.ts';

const AT = (minutesAgo: number) => new Date(TEST_NOW.getTime() - minutesAgo * 60_000).toISOString();

/** ハウス 1（ロボット・センサー）に、複数の項目（累積・状態値・ステータス・満足度）の観測値を置く。手動入力・自動取り込み・基準の値を含む。 */
async function seedHouse1(context: TestContext): Promise<void> {
  const rows = [
    // ロボット: 累積の項目（期間より前の基準・期間内の増分・手動入力）
    observation({
      equipmentId: ROBOT_ID,
      itemKey: 'harvestCount',
      value: 100,
      observedAt: AT(60 * 24 * 100),
    }),
    observation({
      equipmentId: ROBOT_ID,
      itemKey: 'harvestCount',
      value: 130,
      observedAt: AT(60 * 24 * 3),
    }),
    observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 190, observedAt: AT(90) }),
    observation({
      equipmentId: ROBOT_ID,
      itemKey: 'harvestOperatingHours',
      value: 4,
      observedAt: AT(90),
    }),
    observation({
      equipmentId: ROBOT_ID,
      itemKey: 'travelStoppedHours',
      value: 1,
      observedAt: AT(90),
    }),
    observation({
      equipmentId: ROBOT_ID,
      itemKey: 'damagedFruitCount',
      value: 5,
      observedAt: AT(80),
      source: 'MANUAL',
    }),
    observation({
      equipmentId: ROBOT_ID,
      itemKey: 'wrongHarvestCount',
      value: 2,
      observedAt: AT(80),
      source: 'MANUAL',
    }),
    observation({
      equipmentId: ROBOT_ID,
      itemKey: 'missedFruitCount',
      value: 3,
      observedAt: AT(80),
      source: 'MANUAL',
    }),
    observation({
      equipmentId: ROBOT_ID,
      itemKey: 'statusCode',
      value: 'STOPPED',
      observedAt: AT(30),
    }),
    // センサー: 環境
    observation({
      equipmentId: SENSOR_ID,
      itemKey: 'temperatureCelsius',
      value: 27,
      observedAt: AT(20),
    }),
    observation({
      equipmentId: SENSOR_ID,
      itemKey: 'humidityPercent',
      value: 60,
      observedAt: AT(20),
    }),
    // ハウス: 満足度（手動入力）
    ...[
      'harvestAccuracy',
      'harvestSpeed',
      'environmentalAdaptability',
      'operability',
      'maintainability',
      'costEfficiency',
      'safety',
      'dataUtilization',
      'durability',
    ].map((id) =>
      observation({
        equipmentId: FACILITY_ID,
        itemKey: `satisfaction.${id}`,
        value: 3,
        observedAt: AT(10),
        source: 'MANUAL',
      }),
    ),
  ];
  await context.container.repositories.observations.saveMany(rows);
}

async function withHouse1(options: { secondHouse: boolean }): Promise<TestContext> {
  const context = await createTestContext();
  for (const equipment of equipmentSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  if (options.secondHouse) {
    for (const equipment of secondHouseSet()) {
      await context.container.repositories.equipment.save(equipment);
    }
  }
  await seedHouse1(context);
  return context;
}

/** 設備ごとの、保存済みの評価結果（ハウス 1 と配下）。 */
async function resultsOf(context: TestContext, ids: readonly EquipmentId[]) {
  return Promise.all(
    ids.map(
      async (id) => [id, await context.container.repositories.evaluations.listLatest(id)] as const,
    ),
  );
}

function spyReads(context: TestContext) {
  const read = vi.spyOn(context.container.repositories.observations, 'findForEvaluation');
  const baseline = vi.spyOn(context.container.repositories.observations, 'findLatestBefore');
  return {
    /** 読み取りの呼び出しごとの、設備の識別子（呼び出した順）。 */
    reads: () => read.mock.calls.map((call) => [...call[0]]),
    baselines: () => baseline.mock.calls.map((call) => [...call[0]]),
    reset: () => {
      read.mockClear();
      baseline.mockClear();
    },
  };
}

describe('評価の観測値の読み取りの共有（1 つのハウスだけの回）', () => {
  it('手動入力の保存後の評価（ロボットと、それを含むハウス）は、各設備の観測値を、1 回ずつだけ読む（ハウスが、ロボットの観測値を読み直さない）', async () => {
    const context = await withHouse1({ secondHouse: false });
    const spy = spyReads(context);

    await context.container.evaluationService.evaluateAffected('MANUAL_ENTRY', [ROBOT_ID]);

    const ids = spy.reads().flat();
    expect([...ids].sort()).toEqual([FACILITY_ID, ROBOT_ID, SENSOR_ID].sort());
    expect(new Set(ids).size).toBe(ids.length);
    // 累積の項目の基準の読み取りも、同じ
    const baselineIds = spy.baselines().flat();
    expect(new Set(baselineIds).size).toBe(baselineIds.length);
  });

  it('全設備の評価も、ハウスが 1 つだけなら、各設備の観測値を 1 回ずつだけ読む', async () => {
    const context = await withHouse1({ secondHouse: false });
    const spy = spyReads(context);

    await context.container.evaluationService.evaluateAll('DEV');

    const ids = spy.reads().flat();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
  });

  it('複数のハウスをまたぐ回（全設備の評価）は、共有しない（保持する量を抑える）。ハウスの評価は、配下の設備を含めて、読む', async () => {
    const context = await withHouse1({ secondHouse: true });
    const spy = spyReads(context);

    await context.container.evaluationService.evaluateAll('DEV');

    const readSets = spy.reads();
    // ハウス 1 の評価の読み取りは、ハウスと配下の設備をまとめて 1 回で読む（従来どおり）
    expect(readSets.some((ids) => ids.includes(FACILITY_ID) && ids.includes(ROBOT_ID))).toBe(true);
    expect(
      readSets.some(
        (ids) =>
          ids.includes(FACILITY_2_ID) && ids.includes(ROBOT_2_ID) && ids.includes(SENSOR_2_ID),
      ),
    ).toBe(true);
  });

  it('共有しても、評価の結果は変わらない: 共有する回（ハウス 1 つ）と、共有しない回（ハウスが 2 つ）の、ハウス 1 と配下の評価結果（診断メッセージ・メトリクスを含む）が一致する', async () => {
    const shared = await withHouse1({ secondHouse: false });
    const separate = await withHouse1({ secondHouse: true });

    await shared.container.evaluationService.evaluateAll('DEV');
    await separate.container.evaluationService.evaluateAll('DEV');

    const ids = [FACILITY_ID, ROBOT_ID, SENSOR_ID];
    const sharedResults = await resultsOf(shared, ids);
    const separateResults = await resultsOf(separate, ids);
    expect(sharedResults).toEqual(separateResults);
    // 比べている結果に、判定された状態がある（「不明」だけではない）
    const statuses = new Set(
      sharedResults.flatMap(([, results]) => results.map((result) => result.status)),
    );
    expect(statuses.size).toBeGreaterThanOrEqual(2);
    // 手動入力の保存後の評価（ロボットとハウスだけ）も、同じ結果になる
    await shared.container.evaluationService.evaluateAffected('MANUAL_ENTRY', [ROBOT_ID]);
    await separate.container.evaluationService.evaluateAffected('MANUAL_ENTRY', [ROBOT_ID]);
    expect(await resultsOf(shared, ids)).toEqual(await resultsOf(separate, ids));
  });
});
