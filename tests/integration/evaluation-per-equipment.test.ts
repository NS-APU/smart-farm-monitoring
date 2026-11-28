/**
 * 評価の単位: 設備（ロボット・環境センサー）ごとに評価し、ハウスの結果は、配下の設備のうち最も悪い結果にする（D-19。FR-5.3）。
 * 運用面の観点（データ活用度合い・満足度）は、ハウス単位のまま。基本構成（ハウス 1・ロボット 1・センサー 1）では、結果は変わらない。
 * 複数台のロボット・センサーがある構成のテストは、合成データ（実データは使わない）。
 */

import { describe, expect, it } from 'vitest';
import { satisfactionItemKey } from '@smart-farm/shared/constants/items';
import { SATISFACTION_TARGET_VIEWPOINT_IDS } from '@smart-farm/shared/constants/viewpoints';
import { toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import { generateAutoObservations } from '../../src/backend/infrastructure/local/synthetic-data.ts';
import {
  equipmentSet,
  FACILITY_ID,
  observation,
  ROBOT_ID,
  SENSOR_ID,
} from '../support/builders.ts';
import { createTestContext, TEST_NOW, TEST_USER } from '../support/test-context.ts';

const ROBOT_B_ID = toEquipmentId('ROBOT-T1B');
const SENSOR_B_ID = toEquipmentId('SENSOR-T1B');
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const USER = toUserId(TEST_USER.userId);

const ROBOT_A_NAME = 'テストロボット';
const ROBOT_B_NAME = 'テストロボットB';
const SENSOR_A_NAME = 'テストセンサー';
const SENSOR_B_NAME = 'テストセンサーB';

/** ロボット 2 台・センサー 2 つを、同じハウスに置く（ハウスの登録が先。評価の順序を、登録順に頼らないことを確かめる）。 */
function multiEquipment(): Equipment[] {
  const [facility, robot, sensor] = equipmentSet();
  if (facility === undefined || robot === undefined || sensor === undefined) {
    throw new Error('テストの前提が成り立っていません');
  }
  return [
    facility,
    robot,
    sensor,
    { ...robot, equipmentId: ROBOT_B_ID, name: ROBOT_B_NAME, externalId: 'ROBOT-SAMPLE-01B' },
    { ...sensor, equipmentId: SENSOR_B_ID, name: SENSOR_B_NAME, externalId: 'SENSOR-SAMPLE-01B' },
  ];
}

async function setupMultiple() {
  const context = await createTestContext();
  for (const equipment of multiEquipment()) {
    await context.container.repositories.equipment.save(equipment);
  }
  return context;
}

type Context = Awaited<ReturnType<typeof setupMultiple>>;

const minutesBefore = (minutes: number): string =>
  new Date(TEST_NOW.getTime() - minutes * MINUTE_MS).toISOString();

/** メンテナンス性（短期は最新のステータス・故障回数・復旧時間）の入力を、ロボットごとに作る。 */
function maintainabilityInputs(
  equipmentId: typeof ROBOT_ID,
  statusCode: string,
  statusMinutesBefore: number,
) {
  return [
    observation({
      equipmentId,
      itemKey: 'statusCode',
      value: statusCode,
      observedAt: minutesBefore(statusMinutesBefore),
    }),
    observation({
      equipmentId,
      itemKey: 'failureCount',
      value: 1,
      source: 'MANUAL',
      observedAt: minutesBefore(120),
    }),
    observation({
      equipmentId,
      itemKey: 'recoveryMinutes',
      value: 30,
      source: 'MANUAL',
      observedAt: minutesBefore(120),
    }),
  ];
}

function temperature(equipmentId: typeof SENSOR_ID, value: number, minutes: number) {
  return observation({
    equipmentId,
    itemKey: 'temperatureCelsius',
    value,
    observedAt: minutesBefore(minutes),
  });
}

async function latest(
  context: Context,
  equipmentId: typeof ROBOT_ID,
  viewpointId: Parameters<Context['container']['repositories']['evaluations']['getLatest']>[1],
  horizon: 'SHORT' | 'LONG' = 'SHORT',
) {
  return context.container.repositories.evaluations.getLatest(
    equipmentId,
    viewpointId,
    horizon,
    horizon === 'SHORT' ? null : 7,
  );
}

describe('複数台のロボット: ハウスは、最も悪いロボットの結果', () => {
  it('ロボット B が 12:00 に転倒、A が 12:01 に稼働中 → ハウスの短期は「異常」（最新の A だけで、B の転倒を見逃さない）', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany([
      ...maintainabilityInputs(ROBOT_B_ID, 'FALLEN', 61),
      ...maintainabilityInputs(ROBOT_ID, 'RUNNING', 60),
    ]);

    await context.container.evaluationService.evaluateAll('DEV');

    expect((await latest(context, ROBOT_ID, 'maintainability'))?.status).toBe('NORMAL');
    expect((await latest(context, ROBOT_B_ID, 'maintainability'))?.status).toBe('ERROR');
    const house = await latest(context, FACILITY_ID, 'maintainability');
    expect(house?.status).toBe('ERROR');
    expect(house?.statusDetail).toMatchObject({ code: 'FALLEN', category: 'ERROR' });
    // どの設備が悪いかを、診断メッセージに示す
    expect(house?.diagnosticMessage).toContain(`（${ROBOT_B_NAME}）`);
    expect(house?.diagnosticMessage).not.toContain(`（${ROBOT_A_NAME}）`);
    expect(house?.diagnosticMessage).toContain('ステータス 転倒（姿勢異常）（異常）');
  });

  it('ハウスの結果は、最も悪いロボットの結果と同じ（メトリクス・判定・推奨アクション）。ほかの期間も、期間ごとに最悪を採る', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany([
      ...maintainabilityInputs(ROBOT_B_ID, 'FALLEN', 61),
      ...maintainabilityInputs(ROBOT_ID, 'RUNNING', 60),
    ]);

    await context.container.evaluationService.evaluateAll('DEV');

    const robotB = await latest(context, ROBOT_B_ID, 'maintainability', 'LONG');
    const house = await latest(context, FACILITY_ID, 'maintainability', 'LONG');
    expect(house).toMatchObject({
      status: robotB?.status,
      metrics: robotB?.metrics,
      indicatorStatuses: robotB?.indicatorStatuses,
      recommendedAction: robotB?.recommendedAction,
      evaluatedFrom: robotB?.evaluatedFrom,
      evaluatedTo: robotB?.evaluatedTo,
    });
    expect(house?.status).toBe('ERROR');
  });

  it('悪いロボットがなければ、診断メッセージの設備名は、正常の判定でも先頭のロボット（複数台のときだけ付く）', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany([
      ...maintainabilityInputs(ROBOT_B_ID, 'RUNNING', 61),
      ...maintainabilityInputs(ROBOT_ID, 'RUNNING', 60),
    ]);

    await context.container.evaluationService.evaluateAll('DEV');

    const house = await latest(context, FACILITY_ID, 'maintainability');
    expect(house?.status).toBe('NORMAL');
    expect(house?.diagnosticMessage).toContain(`（${ROBOT_A_NAME}）`);
  });

  it('1 台がデータなし（不明）でも、判定できた台の悪化を、ハウスの結果にする', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany(
      maintainabilityInputs(ROBOT_B_ID, 'FALLEN', 61),
    );

    await context.container.evaluationService.evaluateAll('DEV');

    expect((await latest(context, ROBOT_ID, 'maintainability'))?.status).toBe('UNKNOWN');
    const house = await latest(context, FACILITY_ID, 'maintainability');
    expect(house?.status).toBe('ERROR');
    expect(house?.diagnosticMessage).toContain(`（${ROBOT_B_NAME}）`);
  });

  it('すべてのロボットがデータなしなら、ハウスも「不明」（設備名は付けない）', async () => {
    const context = await setupMultiple();

    await context.container.evaluationService.evaluateAll('DEV');

    const house = await latest(context, FACILITY_ID, 'maintainability');
    expect(house?.status).toBe('UNKNOWN');
    expect(house?.diagnosticMessage).not.toContain('（テストロボット');
  });
});

describe('複数のセンサー: ハウスの環境適応性は、最も悪いセンサーの結果', () => {
  it('センサー 1 が 40℃、1 分後にセンサー 2 が 22℃ → ハウスは「異常」。短期も、長期の平均も、混ぜない', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany([
      temperature(SENSOR_ID, 40, 61),
      temperature(SENSOR_B_ID, 22, 60),
    ]);

    await context.container.evaluationService.evaluateAll('DEV');

    expect((await latest(context, SENSOR_ID, 'environmentalAdaptability'))?.status).toBe('ERROR');
    expect((await latest(context, SENSOR_B_ID, 'environmentalAdaptability'))?.status).toBe(
      'NORMAL',
    );
    const shortTerm = await latest(context, FACILITY_ID, 'environmentalAdaptability');
    expect(shortTerm).toMatchObject({ status: 'ERROR', metrics: { temperatureCelsius: 40 } });
    expect(shortTerm?.diagnosticMessage).toContain(`（${SENSOR_A_NAME}）`);
    // 長期（7 日）: 平均 (40 + 22) ÷ 2 = 31℃（注意）にならず、センサー 1 の平均 40℃（異常）
    const longTerm = await latest(context, FACILITY_ID, 'environmentalAdaptability', 'LONG');
    expect(longTerm).toMatchObject({ status: 'ERROR', metrics: { temperatureCelsius: 40 } });
  });

  it('センサーごとの結果は、そのセンサーの観測値だけで評価する（ほかのセンサーの値を混ぜない）', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany([
      temperature(SENSOR_ID, 40, 61),
      temperature(SENSOR_B_ID, 22, 60),
    ]);

    await context.container.evaluationService.evaluateAll('DEV');

    expect(
      (await latest(context, SENSOR_B_ID, 'environmentalAdaptability', 'LONG'))?.metrics,
    ).toMatchObject({
      temperatureCelsius: 22,
    });
  });
});

describe('運用面の観点は、ハウス単位のまま', () => {
  it('データ活用度合いは、ハウスの結果だけ（ロボット・センサーにはない）。配下の設備のデータを、まとめて数える', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany([
      ...maintainabilityInputs(ROBOT_B_ID, 'RUNNING', 61),
      temperature(SENSOR_ID, 22, 60),
    ]);

    await context.container.evaluationService.evaluateAll('DEV');

    const house = await latest(context, FACILITY_ID, 'dataUtilization', 'LONG');
    expect(house?.metrics.robotDataCount).toBeGreaterThan(0);
    expect(house?.metrics.sensorDataCount).toBeGreaterThan(0);
    expect(house?.diagnosticMessage).not.toContain('（テスト');
    expect(await latest(context, ROBOT_ID, 'dataUtilization', 'LONG')).toBeUndefined();
    expect(await latest(context, SENSOR_ID, 'dataUtilization', 'LONG')).toBeUndefined();
  });

  it('満足度は、ハウスの入力だけから評価する（設備の結果の最悪にはしない）', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany(
      SATISFACTION_TARGET_VIEWPOINT_IDS.map((viewpointId) =>
        observation({
          equipmentId: FACILITY_ID,
          itemKey: satisfactionItemKey(viewpointId),
          value: 5,
          source: 'MANUAL',
          observedAt: minutesBefore(60),
        }),
      ),
    );

    await context.container.evaluationService.evaluateAll('DEV');

    const house = await context.container.repositories.evaluations.getLatest(
      FACILITY_ID,
      'satisfaction',
      'LONG',
      30,
    );
    expect(house?.status).toBe('NORMAL');
    expect(house?.diagnosticMessage).not.toContain('（テスト');
  });
});

describe('基本構成（ハウス 1・ロボット 1・センサー 1）では、結果は変わらない', () => {
  it('ハウスの結果は、ロボット・センサーの結果と同じ（診断メッセージに設備名を付けない）', async () => {
    const context = await createTestContext();
    for (const equipment of equipmentSet()) {
      await context.container.repositories.equipment.save(equipment);
    }
    await context.container.repositories.observations.saveMany(
      generateAutoObservations({
        robotId: ROBOT_ID,
        sensorId: SENSOR_ID,
        from: new Date(TEST_NOW.getTime() - 2 * HOUR_MS),
        to: TEST_NOW,
        intervalMinutes: 15,
        seed: 1,
      }),
    );

    await context.container.evaluationService.evaluateAll('DEV');

    const { evaluations } = context.container.repositories;
    const facilityResults = await evaluations.listLatest(FACILITY_ID);
    const memberResults = [
      ...(await evaluations.listLatest(ROBOT_ID)),
      ...(await evaluations.listLatest(SENSOR_ID)),
    ];
    // ロボットの 7 観点と環境適応性は、ハウスの結果が、設備の結果と同じ（短期 + 長期 5 期間）
    expect(memberResults.length).toBeGreaterThan(0);
    for (const member of memberResults) {
      const house = facilityResults.find(
        (item) =>
          item.viewpointId === member.viewpointId &&
          item.horizon === member.horizon &&
          item.periodDays === member.periodDays,
      );
      expect(house, `${member.viewpointId}/${member.horizon}/${String(member.periodDays)}`).toEqual(
        {
          ...member,
          equipmentId: FACILITY_ID,
        },
      );
    }
    // 運用面の観点（データ活用度合い・満足度）は、ハウスだけ
    expect(facilityResults.length).toBe(56);
  });
});

describe('評価の実行順と、一部の設備だけの評価', () => {
  it('一部の設備だけを評価するとき、ハウスは、評価しない設備の保存済みの最新の結果も使う', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany([
      ...maintainabilityInputs(ROBOT_B_ID, 'FALLEN', 61),
      ...maintainabilityInputs(ROBOT_ID, 'RUNNING', 60),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');
    // ロボット A のデータだけが更新される（B は評価しない）
    context.clock.advance(10 * MINUTE_MS);
    await context.container.repositories.observations.saveMany([
      observation({
        equipmentId: ROBOT_ID,
        itemKey: 'statusCode',
        value: 'STANDBY',
        observedAt: minutesBefore(-5),
      }),
    ]);

    const summary = await context.container.evaluationService.evaluateAffected('INGESTION', [
      ROBOT_ID,
    ]);

    expect(summary.equipmentEvaluated).toBe(2);
    const house = await latest(context, FACILITY_ID, 'maintainability');
    expect(house?.status).toBe('ERROR');
    expect(house?.diagnosticMessage).toContain(`（${ROBOT_B_NAME}）`);
  });

  it('保存済みの結果がまだない設備（評価の前）しかないハウスは、ハウス自身の観測値で評価する（従来と同じ）', async () => {
    const context = await setupMultiple();

    await context.container.evaluationService.evaluateAffected('INGESTION', [FACILITY_ID]);

    const house = await latest(context, FACILITY_ID, 'maintainability');
    expect(house?.status).toBe('UNKNOWN');
    expect(await context.container.repositories.evaluations.listLatest(FACILITY_ID)).toHaveLength(
      56,
    );
  });

  it('ハウスの状態の変化は、集約した結果で検知し、履歴に記録する。通知は、ハウスには出さず、悪い設備（ロボット B）に出す（D-19 の論点 3）', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany([
      ...maintainabilityInputs(ROBOT_B_ID, 'FALLEN', 61),
      ...maintainabilityInputs(ROBOT_ID, 'RUNNING', 60),
    ]);

    await context.container.evaluationService.evaluateAll('DEV');

    const { evaluations, notifications } = context.container.repositories;
    expect((await evaluations.getLastStatusChange(FACILITY_ID, 'maintainability'))?.status).toBe(
      'ERROR',
    );
    expect((await evaluations.getLastStatusChange(ROBOT_ID, 'maintainability'))?.status).toBe(
      'NORMAL',
    );
    const items = (await notifications.list(USER, {}, { limit: 100 })).items.map(
      (entry) => entry.notification,
    );
    const maintainability = items.filter((item) => item.viewpointId === 'maintainability');
    // 通知は、悪い設備（ロボット B）の 1 件だけ。ハウスの通知は出さない（同じ事象の二重の通知をなくす）
    expect(maintainability.map((item) => item.equipmentId)).toEqual([ROBOT_B_ID]);
    expect(maintainability[0]?.message).toContain(`メンテナンス性（${ROBOT_B_NAME}）`);
  });
});

describe('通知の単位は、設備（D-19 の論点 3）', () => {
  async function notificationItems(context: Context) {
    const { items } = await context.container.repositories.notifications.list(
      USER,
      {},
      { limit: 100 },
    );
    return items.map((entry) => entry.notification);
  }

  it('複数台で、ロボット B だけが異常のとき、通知はロボット B の 1 件。本文に、設備名と観点名が、1 回ずつ入る', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany([
      ...maintainabilityInputs(ROBOT_B_ID, 'FALLEN', 30),
      ...maintainabilityInputs(ROBOT_ID, 'RUNNING', 30),
    ]);

    await context.container.evaluationService.evaluateAll('DEV');

    const items = (await notificationItems(context)).filter(
      (item) => item.viewpointId === 'maintainability',
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ equipmentId: ROBOT_B_ID, status: 'ERROR' });
    expect(items[0]?.message).toContain(`【異常】メンテナンス性（${ROBOT_B_NAME}）:`);
    // ハウスの集約の診断メッセージ（先頭に「（設備名）」が付く）は、通知に使わない
    expect(items[0]?.message).not.toContain(`: （${ROBOT_B_NAME}）`);
  });

  it('複数のセンサーで、センサー B だけが 40℃（異常）のとき、環境適応性の通知は、センサー B の 1 件（ハウスの通知は出ない）', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany([
      temperature(SENSOR_B_ID, 40, 30),
      temperature(SENSOR_ID, 22, 29),
    ]);

    await context.container.evaluationService.evaluateAll('DEV');

    const items = (await notificationItems(context)).filter(
      (item) => item.viewpointId === 'environmentalAdaptability',
    );
    expect(items.map((item) => item.equipmentId)).toEqual([SENSOR_B_ID]);
    expect(items[0]?.message).toContain(`環境適応性（${SENSOR_B_NAME}）`);
  });

  it('基本構成（1:1:1）で、センサーが異常のとき、環境適応性の通知は、センサーの 1 件（ハウスの通知は出ない。以前は 2 件）', async () => {
    const context = await createTestContext();
    for (const equipment of equipmentSet()) {
      await context.container.repositories.equipment.save(equipment);
    }
    await context.container.repositories.observations.saveMany([temperature(SENSOR_ID, 45, 30)]);

    await context.container.evaluationService.evaluateAll('DEV');

    const items = (await notificationItems(context)).filter(
      (item) => item.viewpointId === 'environmentalAdaptability',
    );
    expect(items.map((item) => item.equipmentId)).toEqual([SENSOR_ID]);
  });

  it('運用面の観点（データ活用度合い・満足度）は、ハウスの結果そのものを通知する', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany(
      SATISFACTION_TARGET_VIEWPOINT_IDS.map((viewpointId) =>
        observation({
          equipmentId: FACILITY_ID,
          itemKey: satisfactionItemKey(viewpointId),
          value: 1,
          observedAt: minutesBefore(60),
          source: 'MANUAL',
        }),
      ),
    );

    await context.container.evaluationService.evaluateAll('DEV');

    const items = await notificationItems(context);
    const satisfaction = items.filter((item) => item.viewpointId === 'satisfaction');
    expect(satisfaction).toHaveLength(1);
    expect(satisfaction[0]).toMatchObject({ equipmentId: FACILITY_ID, status: 'ERROR' });
    // ロボットのデータがなく取得の割合が低いため、データ活用度合い（ハウス単位）も通知される
    const utilization = items.filter((item) => item.viewpointId === 'dataUtilization');
    expect(utilization.map((item) => item.equipmentId)).toEqual([FACILITY_ID]);
  });

  it('通知しないハウスの変化も、状態の変化の履歴と連携キューには、ハウスの分を積む', async () => {
    const context = await setupMultiple();
    await context.container.repositories.observations.saveMany([temperature(SENSOR_B_ID, 40, 30)]);

    await context.container.evaluationService.evaluateAll('DEV');

    const { evaluations, federation } = context.container.repositories;
    const houseHistory = await evaluations.listStatusChanges(
      FACILITY_ID,
      'environmentalAdaptability',
    );
    expect(houseHistory.map((entry) => entry.status)).toEqual(['ERROR']);
    const queued = await federation.listDue(new Date(TEST_NOW.getTime() + HOUR_MS), 1000);
    expect(
      queued.find((item) => item.targetRef === `${FACILITY_ID}#environmentalAdaptability`)?.payload,
    ).toMatchObject({ status: 'ERROR' });
    expect(
      queued.find((item) => item.targetRef === `${SENSOR_B_ID}#environmentalAdaptability`)?.payload,
    ).toMatchObject({ status: 'ERROR' });
  });

  it('D-38 の抑制は、設備ごとに動く: 短い行き来（正常が 15 分未満）は通知せず、正常が 15 分以上続いたあとの悪化は、ロボット B の 2 件目の通知になる', async () => {
    const context = await setupMultiple();
    // 故障回数・復旧時間（手動入力）を、先に入れておく（ステータスは、同じ日時の値を上書きして切り替える）
    await context.container.repositories.observations.saveMany(
      maintainabilityInputs(ROBOT_B_ID, 'RUNNING', 120),
    );
    const evaluateAfter = async (minutes: number, statusCode: string) => {
      context.clock.advance(minutes * MINUTE_MS);
      await context.container.repositories.observations.saveMany([
        observation({
          equipmentId: ROBOT_B_ID,
          itemKey: 'statusCode',
          value: statusCode,
          observedAt: minutesBefore(60),
        }),
      ]);
      await context.container.evaluationService.evaluateAll('DEV');
    };
    const maintainabilityNotifications = async (equipmentId: typeof ROBOT_ID) =>
      (await notificationItems(context)).filter(
        (item) => item.viewpointId === 'maintainability' && item.equipmentId === equipmentId,
      );

    await evaluateAfter(0, 'FALLEN');
    await evaluateAfter(5, 'RUNNING');
    await evaluateAfter(5, 'FALLEN');
    // 正常は 5 分だけ続いた（短い行き来）。同じ出来事として、通知しない
    expect(await maintainabilityNotifications(ROBOT_B_ID)).toHaveLength(1);

    await evaluateAfter(5, 'RUNNING');
    await evaluateAfter(20, 'FALLEN');
    // 正常が 20 分続いたあとの悪化は、新しい出来事
    expect(await maintainabilityNotifications(ROBOT_B_ID)).toHaveLength(2);
    expect(await maintainabilityNotifications(FACILITY_ID)).toHaveLength(0);
  });
});
