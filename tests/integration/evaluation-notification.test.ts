/**
 * 評価（JB-02）・異常検知と通知（UC-05, UC-10, UC-22。JB-04）・連携（UC-11。JB-03）・ダッシュボード（UC-01）の結合テスト。
 */

import { describe, expect, it, vi } from 'vitest';
import { satisfactionItemKey } from '@smart-farm/shared/constants/items';
import { SATISFACTION_TARGET_VIEWPOINT_IDS } from '@smart-farm/shared/constants/viewpoints';
import { NotificationIdSchema, toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
import { getDefaultCriteria } from '../../src/backend/domain/evaluation/default-criteria.ts';
import { CUSTOM_CRITERIA_NOTE } from '../../src/backend/domain/evaluation/messages.ts';
import { createEvaluationService } from '../../src/backend/application/evaluation/evaluation-service.ts';
import {
  createJobRunner,
  isJobId,
  JOB_IDS,
  type JobId,
  type JobResult,
} from '../../src/backend/application/jobs/job-runner.ts';
import { createScheduler, DEFAULT_SCHEDULE } from '../../src/backend/application/jobs/scheduler.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { DEFAULT_APP_SETTINGS } from '../../src/backend/application/settings.ts';
import {
  generateAutoObservations,
  generateManualObservations,
} from '../../src/backend/infrastructure/local/synthetic-data.ts';
import {
  equipmentSet,
  FACILITY_ID,
  must,
  observation,
  ROBOT_ID,
  SENSOR_ID,
} from '../support/builders.ts';
import { createTestContext, TEST_NOW, TEST_USER } from '../support/test-context.ts';

const USER = toUserId(TEST_USER.userId);
const JOB_OK: JobResult = {
  jobId: 'JB-04',
  summary: { notificationsProcessed: 0, delivered: 0, failed: 0 },
};
const HOUR_MS = 3_600_000;

async function setup() {
  const context = await createTestContext();
  for (const equipment of equipmentSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  return context;
}

type Context = Awaited<ReturnType<typeof setup>>;

function temperature(value: number, observedAt: string) {
  return observation({ equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value, observedAt });
}

async function notificationsOf(context: Context) {
  return (
    await context.container.repositories.notifications.list(USER, {}, { limit: 100 })
  ).items.map((entry) => entry.notification);
}

describe('評価（JB-02）', () => {
  it('設備ごと・観点ごとに、短期と長期（当日・7・30・60・90日）の結果を保存する', async () => {
    const context = await setup();

    const summary = await context.container.evaluationService.evaluateAll('DEV');

    // ハウス: 短期6 + 長期 10×5、ロボット: 短期5 + 長期 7×5、センサー: 短期1 + 長期 1×5
    expect(summary).toMatchObject({ equipmentEvaluated: 3, resultsSaved: 56 + 40 + 6 });
    expect(await context.container.repositories.evaluations.listLatest(FACILITY_ID)).toHaveLength(
      56,
    );
    expect(await context.container.repositories.evaluations.listLatest(ROBOT_ID)).toHaveLength(40);
    expect(await context.container.repositories.evaluations.listLatest(SENSOR_ID)).toHaveLength(6);
  });

  it('データがない観点は、不明として評価し、取得・入力を確認する推奨アクションを付ける', async () => {
    const context = await setup();

    await context.container.evaluationService.evaluateAll('DEV');

    const result = await context.container.repositories.evaluations.getLatest(
      FACILITY_ID,
      'harvestAccuracy',
      'LONG',
      7,
    );
    expect(result).toMatchObject({
      status: 'UNKNOWN',
      criteriaVersion: 'DEFAULT',
      isCustomCriteria: false,
    });
    expect(result?.recommendedAction).toContain('データの取得・入力を確認');
  });

  it('ハウスの評価は、配下のロボット・センサーの観測値をまとめて使う', async () => {
    const context = await setup();
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

    const facility = await context.container.repositories.evaluations.getLatest(
      FACILITY_ID,
      'environmentalAdaptability',
      'SHORT',
      null,
    );
    const sensor = await context.container.repositories.evaluations.getLatest(
      SENSOR_ID,
      'environmentalAdaptability',
      'SHORT',
      null,
    );
    const robotOnlyEnvironment = await context.container.repositories.evaluations.getLatest(
      ROBOT_ID,
      'environmentalAdaptability',
      'SHORT',
      null,
    );
    expect(facility?.status).toBe('NORMAL');
    expect(sensor?.status).toBe('NORMAL');
    // ロボットには環境適応性の評価がない
    expect(robotOnlyEnvironment).toBeUndefined();
    const speed = await context.container.repositories.evaluations.getLatest(
      ROBOT_ID,
      'harvestSpeed',
      'SHORT',
      null,
    );
    expect(speed?.statusDetail).not.toBeNull();
  });

  it('手動入力の値が自動取り込みと同じ項目・時刻で重なる場合は、手動入力を使う', async () => {
    const context = await setup();
    const observedAt = new Date(TEST_NOW.getTime() - HOUR_MS).toISOString();
    await context.container.repositories.observations.saveMany([
      temperature(20, observedAt),
      { ...temperature(40, observedAt), source: 'MANUAL' },
    ]);

    await context.container.evaluationService.evaluateAll('DEV');

    const result = await context.container.repositories.evaluations.getLatest(
      SENSOR_ID,
      'environmentalAdaptability',
      'SHORT',
      null,
    );
    expect(result?.metrics.temperatureCelsius).toBe(40);
    expect(result?.status).toBe('ERROR');
  });

  it('変更した判断基準があれば、それで判定し、判断基準の版と変更済みの識別を結果に残す', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(20, new Date(TEST_NOW.getTime() - HOUR_MS).toISOString()),
    ]);
    const base = getDefaultCriteria('environmentalAdaptability');
    await context.container.repositories.criteria.save({
      ...base,
      isDefault: false,
      version: 'v2',
      criteria: base.criteria.map((criterion) =>
        criterion.indicator === 'temperatureCelsius' && criterion.kind === 'RANGE'
          ? {
              ...criterion,
              thresholds: { errorLower: 0, normalLower: 22, normalUpper: 25, errorUpper: 35 },
            }
          : criterion,
      ),
    });

    await context.container.evaluationService.evaluateAll('DEV');

    const result = await context.container.repositories.evaluations.getLatest(
      SENSOR_ID,
      'environmentalAdaptability',
      'SHORT',
      null,
    );
    expect(result).toMatchObject({
      status: 'CAUTION',
      criteriaVersion: 'v2',
      isCustomCriteria: true,
    });
    expect(result?.diagnosticMessage).toContain(CUSTOM_CRITERIA_NOTE);
  });

  it('判断基準が見つからない観点があれば、評価を失敗させる（設定の不整合を握りつぶさない）', async () => {
    const context = await setup();
    const service = createEvaluationService({
      repositories: context.container.repositories,
      criteria: { getEffective: vi.fn(), getAllEffective: () => Promise.resolve(new Map()) },
      notifications: context.container.notificationService,
      federation: { enqueue: vi.fn(), runPending: vi.fn() },
      clock: context.clock,
      settings: {
        defaultIngestionIntervalMinutes: 15,
        notification: DEFAULT_APP_SETTINGS.notification,
      },
      logger: NULL_LOGGER,
    });

    await expect(service.evaluateAll('DEV')).rejects.toThrow('判断基準が見つかりません');
  });
});

describe('満足度の最終ステータス（通知・連携の基準）は、30 日で評価する（D-18）', () => {
  it('20 日前の満足度（すべて 1）でも、30 日の期間の中のため、「異常」になり、通知する', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany(
      SATISFACTION_TARGET_VIEWPOINT_IDS.map((viewpointId) =>
        observation({
          equipmentId: FACILITY_ID,
          itemKey: satisfactionItemKey(viewpointId),
          value: 1,
          observedAt: new Date(TEST_NOW.getTime() - 20 * 24 * HOUR_MS).toISOString(),
          source: 'MANUAL',
        }),
      ),
    );

    await context.container.evaluationService.evaluateAll('DEV');

    const last = await context.container.repositories.evaluations.getLastStatusChange(
      FACILITY_ID,
      'satisfaction',
    );
    expect(last?.status).toBe('ERROR');
    const notifications = await notificationsOf(context);
    expect(notifications.find((item) => item.viewpointId === 'satisfaction')).toMatchObject({
      kind: 'STATUS_CHANGE',
      status: 'ERROR',
      equipmentId: FACILITY_ID,
    });
  });

  it('7 日より前の入力は、ほかの観点の最終ステータスには使わない（従来どおり 7 日）', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(40, new Date(TEST_NOW.getTime() - 20 * 24 * HOUR_MS).toISOString()),
    ]);

    await context.container.evaluationService.evaluateAll('DEV');

    const last = await context.container.repositories.evaluations.getLastStatusChange(
      SENSOR_ID,
      'environmentalAdaptability',
    );
    expect(last?.status).toBe('UNKNOWN');
  });
});

describe('異常検知と通知（UC-10）', () => {
  it('観点が「注意」に変わったら、ステータス・観点名・設備・診断メッセージを含む通知を作る', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(30, new Date(TEST_NOW.getTime() - HOUR_MS).toISOString()),
    ]);

    const summary = await context.container.evaluationService.evaluateAll('DEV');

    // 環境適応性は、ハウスとセンサーの両方で評価される。ロボットのデータがなく取得の割合が低いため、
    // データ活用度合い（ハウス）も「異常」になる
    expect(summary.notificationsCreated).toBe(3);
    const notifications = await notificationsOf(context);
    const forSensor = notifications.find((item) => item.equipmentId === SENSOR_ID);
    expect(forSensor).toMatchObject({
      kind: 'STATUS_CHANGE',
      viewpointId: 'environmentalAdaptability',
      status: 'CAUTION',
    });
    expect(forSensor?.message).toContain('【注意】環境適応性（テストセンサー）');
    expect(forSensor?.message).toContain('温度 30.0℃（注意）');
    expect(forSensor?.deliveries.map((delivery) => [delivery.channel, delivery.result])).toEqual([
      ['IN_APP', 'SUCCESS'],
      ['WEB_PUSH', 'PENDING'],
    ]);
  });

  it('同じ状態が続く間は、通知を繰り返さない', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(30, new Date(TEST_NOW.getTime() - HOUR_MS).toISOString()),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');

    const again = await context.container.evaluationService.evaluateAll('DEV');
    context.clock.advance(3 * HOUR_MS);
    const later = await context.container.evaluationService.evaluateAll('DEV');

    expect(again).toMatchObject({ statusChanges: 0, notificationsCreated: 0 });
    expect(later.notificationsCreated).toBe(0);
    expect(await notificationsOf(context)).toHaveLength(3);
  });

  it('「注意」から「異常」に悪化したら、新しい通知を作る', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(30, new Date(TEST_NOW.getTime() - 2 * HOUR_MS).toISOString()),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');

    await context.container.repositories.observations.saveMany([
      temperature(45, new Date(TEST_NOW.getTime() - HOUR_MS).toISOString()),
    ]);
    const summary = await context.container.evaluationService.evaluateAll('DEV');

    expect(summary.notificationsCreated).toBe(2);
    expect(
      (await notificationsOf(context)).filter(
        (item) => item.status === 'ERROR' && item.viewpointId === 'environmentalAdaptability',
      ),
    ).toHaveLength(2);
  });

  describe('通知の条件（Issue #236。D-37・D-38・D-42）', () => {
    /** 観測の日時は固定（同じ日時の値を上書きして、状態を切り替える。直近 24 時間・7 日の窓に入る）。 */
    const OBSERVED_AT = new Date(TEST_NOW.getTime() - HOUR_MS).toISOString();

    /** 指定した分だけ時計を進め、センサーの温度を上書きして、評価する。 */
    async function evaluateAfter(context: Context, minutes: number, celsius: number) {
      context.clock.advance(minutes * 60_000);
      await context.container.repositories.observations.saveMany([
        temperature(celsius, OBSERVED_AT),
      ]);
      return context.container.evaluationService.evaluateAll('DEV');
    }

    /** 環境適応性（ハウス・センサーの 2 設備）の通知。 */
    const environmentNotifications = async (context: Context) =>
      (await notificationsOf(context)).filter(
        (item) => item.viewpointId === 'environmentalAdaptability',
      );

    it('再発: 異常 → 正常が 15 分以上続く → 異常 は、新しい出来事として通知する（60 分以内でも抑制しない）', async () => {
      const context = await setup();

      await evaluateAfter(context, 0, 45);
      await evaluateAfter(context, 5, 15);
      const recurred = await evaluateAfter(context, 20, 45);

      // 正常は、5 分後から 20 分続いた。2 設備で、「異常」を再び通知する（直前の通知から 25 分）
      expect(recurred.notificationsCreated).toBe(2);
      expect(await environmentNotifications(context)).toHaveLength(4);
    });

    it('短い行き来: 異常 → 正常が 15 分未満 → 異常 は、同じ出来事として通知しない', async () => {
      const context = await setup();

      await evaluateAfter(context, 0, 45);
      await evaluateAfter(context, 5, 15);
      const again = await evaluateAfter(context, 10, 45);

      expect(again.notificationsCreated).toBe(0);
      expect(await environmentNotifications(context)).toHaveLength(2);
    });

    it('改善（異常 → 注意）は、通知しない', async () => {
      const context = await setup();

      await evaluateAfter(context, 0, 45);
      const improved = await evaluateAfter(context, 5, 30);

      expect(improved.statusChanges).toBeGreaterThan(0);
      expect(improved.notificationsCreated).toBe(0);
      const notifications = await environmentNotifications(context);
      expect(notifications).toHaveLength(2);
      expect(notifications.every((item) => item.status === 'ERROR')).toBe(true);
    });

    it('注意 → 異常 → 注意 → 異常: 悪化（注意 → 異常）は通知し、同じ出来事で、異常を繰り返さない', async () => {
      const context = await setup();

      const caution = await evaluateAfter(context, 0, 30);
      const error = await evaluateAfter(context, 5, 45);
      const improved = await evaluateAfter(context, 5, 30);
      const errorAgain = await evaluateAfter(context, 5, 45);

      expect(caution.notificationsCreated).toBe(3);
      expect(error.notificationsCreated).toBe(2);
      expect(improved.notificationsCreated).toBe(0);
      expect(errorAgain.notificationsCreated).toBe(0);
      expect(await environmentNotifications(context)).toHaveLength(4);
    });

    it('不明を挟んだ再通知はしない: 注意 → 不明（データなし）→ 注意 は、継続とみなす', async () => {
      const context = await setup();
      await evaluateAfter(context, 0, 30);

      // 8 日後には、観測値が、短期・長期（7 日）の窓から外れ、「不明」になる
      context.clock.advance(8 * 24 * HOUR_MS);
      const unknown = await context.container.evaluationService.evaluateAll('DEV');
      await context.container.repositories.observations.saveMany([
        temperature(30, new Date(context.clock.now().getTime() - HOUR_MS).toISOString()),
      ]);
      const cautionAgain = await context.container.evaluationService.evaluateAll('DEV');

      expect(unknown.notificationsCreated).toBe(0);
      const last = await context.container.repositories.evaluations.getLastStatusChange(
        SENSOR_ID,
        'environmentalAdaptability',
      );
      expect(last?.status).toBe('CAUTION');
      expect(cautionAgain.notificationsCreated).toBe(0);
      expect(await environmentNotifications(context)).toHaveLength(2);
    });

    it('不明の記録は、状態の変化の履歴に残る（ステータスの推移・経過のため）', async () => {
      const context = await setup();
      await evaluateAfter(context, 0, 30);

      context.clock.advance(8 * 24 * HOUR_MS);
      await context.container.evaluationService.evaluateAll('DEV');

      const history = await context.container.repositories.evaluations.listStatusChanges(
        SENSOR_ID,
        'environmentalAdaptability',
      );
      expect(history.map((entry) => entry.status)).toEqual(['CAUTION', 'UNKNOWN']);
    });
  });

  it('正常・不明の評価では、通知を作らない（不明の通知は不要とする暫定）', async () => {
    const context = await setup();

    const summary = await context.container.evaluationService.evaluateAll('DEV');

    expect(summary.statusChanges).toBeGreaterThan(0);
    expect(summary.notificationsCreated).toBe(0);
    expect(await notificationsOf(context)).toEqual([]);
  });

  it('状態の変化を記録し、評価結果（派生データ）を連携キューに積む', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(30, new Date(TEST_NOW.getTime() - HOUR_MS).toISOString()),
    ]);

    await context.container.evaluationService.evaluateAll('DEV');

    const change = await context.container.repositories.evaluations.getLastStatusChange(
      SENSOR_ID,
      'environmentalAdaptability',
    );
    expect(change).toMatchObject({ status: 'CAUTION', changedAt: TEST_NOW.toISOString() });
    const queued = await context.container.repositories.federation.listDue(
      new Date(TEST_NOW.getTime() + 1000),
      1000,
    );
    expect(queued.every((item) => item.targetType === 'EVALUATION')).toBe(true);
    // ハウス: 10観点、ロボット: 7観点、センサー: 1観点（初回の評価はすべて状態の変化）
    expect(queued).toHaveLength(18);
    expect(
      queued.find((item) => item.targetRef === `${SENSOR_ID}#environmentalAdaptability`)?.payload,
    ).toMatchObject({ status: 'CAUTION' });
  });
});

describe('通知の一覧・既読（UC-05, UC-22）', () => {
  async function withNotifications() {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(30, new Date(TEST_NOW.getTime() - HOUR_MS).toISOString()),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');
    context.container.dev?.faults.fileServer.set({ mode: 'DOWN' });
    await context.container.ingestionService.runSource('robot');
    return context;
  }

  it('一覧を、種別・既読／未読で絞り込める。既読の状態は利用者ごと', async () => {
    const context = await withNotifications();
    const service = context.container.notificationService;
    const items = (await service.list(USER, { limit: 20 })).items;
    await service.markRead(must(items[0]).notificationId, USER);

    const unread = await service.list(USER, { readState: 'UNREAD', limit: 20 });
    const read = await service.list(USER, { readState: 'READ', limit: 20 });
    const failures = await service.list(USER, { kind: 'INGESTION_FAILURE', limit: 20 });
    const other = await service.list(toUserId('someone-else'), { readState: 'UNREAD', limit: 20 });

    expect(items).toHaveLength(4);
    expect(unread.items).toHaveLength(3);
    expect(read.items).toHaveLength(1);
    expect(failures.items.map((item) => item.sourceId)).toEqual(['robot']);
    expect(failures.items[0]?.equipmentId).toBeUndefined();
    expect(other.items).toHaveLength(4);
  });

  it('未読の件数を数え、一括で既読にする（絞り込みの範囲または全件）', async () => {
    const context = await withNotifications();
    const service = context.container.notificationService;

    expect(await service.unreadCount(USER)).toBe(4);
    expect(await service.markAllRead(USER, { kind: 'INGESTION_FAILURE' })).toBe(1);
    expect(await service.unreadCount(USER)).toBe(3);
    expect(await service.markAllRead(USER, {})).toBe(3);
    expect(await service.unreadCount(USER)).toBe(0);
  });

  it('ページ分割し、カーソルで次のページを取得できる', async () => {
    const context = await withNotifications();
    const service = context.container.notificationService;

    const first = await service.list(USER, { limit: 2 });
    const second = await service.list(USER, { limit: 2, cursor: first.nextCursor ?? undefined });

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });
});

describe('Web Push の配信と再送（FR-7.2, FR-7.7。JB-04。Issue #237。ADR-0019 の D-38）', () => {
  const MINUTE_MS = 60_000;

  async function withSubscriptions(subscriptionIds: readonly string[] = ['s-1']) {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(30, new Date(TEST_NOW.getTime() - HOUR_MS).toISOString()),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');
    for (const subscriptionId of subscriptionIds) {
      await context.container.repositories.pushSubscriptions.save({
        subscriptionId,
        userId: USER,
        endpoint: `https://push.invalid/${subscriptionId}`,
        isActive: true,
        createdAt: TEST_NOW.toISOString(),
      });
    }
    return context;
  }

  const webPushOf = (notification: Awaited<ReturnType<typeof notificationsOf>>[number]) =>
    notification.deliveries.find((delivery) => delivery.channel === 'WEB_PUSH');

  /** 最初の通知（古い順）。 */
  async function firstNotification(context: Context) {
    const notifications = await notificationsOf(context);
    const first = notifications.toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    )[0];
    if (first === undefined) {
      throw new Error('テストの前提');
    }
    return first;
  }

  const deliver = (context: Context) => context.container.notificationService.deliverPending();
  const failWith = (context: Context, mode: 'UP' | 'DOWN' | 'REJECT') =>
    context.container.dev?.faults.webPush.set({ mode });

  it('購読している端末へ配信し、購読ごとの配信の状態と、まとめの状態を記録する。配信済みの通知は、再び配信しない', async () => {
    const context = await withSubscriptions();

    const summary = await deliver(context);

    expect(summary).toEqual({ notificationsProcessed: 3, delivered: 3, failed: 0 });
    expect(context.container.dev?.mocks.webPush.delivered()).toHaveLength(3);
    const notification = await firstNotification(context);
    expect(webPushOf(notification)).toMatchObject({ result: 'SUCCESS', attempts: 1 });
    expect(notification.webPushDeliveries).toMatchObject([
      { subscriptionId: 's-1', result: 'SUCCESS', attempts: 1 },
    ]);
    expect(await deliver(context)).toMatchObject({ notificationsProcessed: 0 });
  });

  it('購読がなければ、配信する相手がなく、配信は完了とする（画面内の通知のみ）', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(30, new Date(TEST_NOW.getTime() - HOUR_MS).toISOString()),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');

    const summary = await deliver(context);

    expect(summary).toEqual({ notificationsProcessed: 3, delivered: 0, failed: 0 });
    expect(context.container.dev?.mocks.webPush.delivered()).toEqual([]);
    expect(webPushOf(await firstNotification(context))).toMatchObject({
      result: 'SUCCESS',
      attempts: 0,
    });
    expect(await deliver(context)).toMatchObject({ notificationsProcessed: 0 });
  });

  it('配信の対象は、最初の配信の実行時点の購読。そのあとに購読した端末には、過去の通知を配信しない（I-07）', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(30, new Date(TEST_NOW.getTime() - HOUR_MS).toISOString()),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');
    await deliver(context);

    await context.container.repositories.pushSubscriptions.save({
      subscriptionId: 's-late',
      userId: USER,
      endpoint: 'https://push.invalid/late',
      isActive: true,
      createdAt: context.clock.now().toISOString(),
    });
    const summary = await deliver(context);

    expect(summary).toMatchObject({ notificationsProcessed: 0, delivered: 0 });
    expect(context.container.dev?.mocks.webPush.delivered()).toEqual([]);
  });

  it('配信に失敗したら、購読ごとに記録して、1 分後に再送する。次の試行の日時の前は、再送しない。画面内の通知には影響しない', async () => {
    const context = await withSubscriptions();
    failWith(context, 'DOWN');

    const first = await deliver(context);
    const afterFailure = await firstNotification(context);
    const tooSoon = await deliver(context);
    context.clock.advance(MINUTE_MS);
    const retry = await deliver(context);

    expect(first).toMatchObject({ failed: 3, delivered: 0 });
    expect(afterFailure.webPushDeliveries).toEqual([
      {
        subscriptionId: 's-1',
        result: 'FAILURE',
        attempts: 1,
        nextAttemptAt: new Date(TEST_NOW.getTime() + MINUTE_MS).toISOString(),
        updatedAt: TEST_NOW.toISOString(),
        errorMessage: 'Web Push の配信サービスに接続できません',
      },
    ]);
    expect(webPushOf(afterFailure)).toMatchObject({ result: 'PENDING', attempts: 1 });
    // 次の試行の日時の前は、再送しない
    expect(tooSoon).toMatchObject({ delivered: 0, failed: 0 });
    expect(retry).toMatchObject({ failed: 3 });
    expect((await firstNotification(context)).webPushDeliveries?.[0]).toMatchObject({
      attempts: 2,
    });
    expect(await context.container.notificationService.unreadCount(USER)).toBe(3);
  });

  it('再送の間隔は、1 分から倍々（1・2・4・8・16・32 分）。通知を作ってから 1 時間（60 分）で、断念する。断念した通知は、画面内の通知として残る', async () => {
    const context = await withSubscriptions();
    failWith(context, 'DOWN');
    const nextAttempts: number[] = [];

    // 失敗のたびに、次の試行の日時まで、時計を進めて、再送する
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await deliver(context);
      const entry = (await firstNotification(context)).webPushDeliveries?.[0];
      const nextAt = Date.parse(entry?.nextAttemptAt ?? '');
      nextAttempts.push((nextAt - context.clock.now().getTime()) / MINUTE_MS);
      context.clock.advance(nextAt - context.clock.now().getTime());
    }

    expect(nextAttempts).toEqual([1, 2, 4, 8, 16, 32]);
    // 6 回目の失敗（31 分後）のあと、次の試行は 63 分後。作成から 60 分を過ぎているため、再送せずに、断念する
    expect(context.clock.now().getTime() - TEST_NOW.getTime()).toBe(63 * MINUTE_MS);
    const abandoned = await deliver(context);
    expect(abandoned).toMatchObject({ delivered: 0, failed: 0 });
    const notification = await firstNotification(context);
    expect(notification.webPushDeliveries?.[0]).toMatchObject({
      result: 'ABANDONED',
      attempts: 6,
    });
    expect(webPushOf(notification)).toMatchObject({ result: 'FAILURE', attempts: 6 });
    expect(await deliver(context)).toMatchObject({ notificationsProcessed: 0 });
    expect(await context.container.notificationService.unreadCount(USER)).toBe(3);
  });

  it('失敗した購読にだけ、再送する。届いた購読には、再配信しない（二重配信がない）', async () => {
    const context = await withSubscriptions(['s-ok', 's-ng']);
    const webPush = context.container.dev?.mocks.webPush;
    if (webPush === undefined) {
      throw new Error('テストの前提');
    }
    const calls: string[] = [];
    let recovered = false;
    vi.spyOn(webPush, 'deliver').mockImplementation((_notification, subscription) => {
      calls.push(subscription.subscriptionId);
      return subscription.subscriptionId === 's-ng' && !recovered
        ? Promise.reject(new Error('想定外'))
        : Promise.resolve('DELIVERED');
    });

    await deliver(context);
    context.clock.advance(MINUTE_MS);
    recovered = true;
    await deliver(context);

    // 通知 3 件 × 購読 2 件 = 6 回、そのあと、失敗した購読への再送が 3 回。届いた購読へは、1 通知につき 1 回だけ
    expect(calls.filter((id) => id === 's-ok')).toHaveLength(3);
    expect(calls.filter((id) => id === 's-ng')).toHaveLength(6);
    const notification = await firstNotification(context);
    expect(notification.webPushDeliveries).toMatchObject([
      { subscriptionId: 's-ok', result: 'SUCCESS', attempts: 1 },
      { subscriptionId: 's-ng', result: 'SUCCESS', attempts: 2 },
    ]);
    expect(webPushOf(notification)).toMatchObject({ result: 'SUCCESS', attempts: 3 });
  });

  it('復旧後の再送で配信できる', async () => {
    const context = await withSubscriptions();
    failWith(context, 'DOWN');
    await deliver(context);
    failWith(context, 'UP');
    context.clock.advance(MINUTE_MS);

    const retry = await deliver(context);

    expect(retry).toMatchObject({ delivered: 3, failed: 0 });
    expect(webPushOf(await firstNotification(context))).toMatchObject({
      result: 'SUCCESS',
      attempts: 2,
    });
  });

  it('Web Push の有効期限（TTL）は、期限（通知を作ってから 1 時間）までの残りの秒数。再送が遅れると、短くなる', async () => {
    const context = await withSubscriptions();
    const webPush = context.container.dev?.mocks.webPush;
    if (webPush === undefined) {
      throw new Error('テストの前提');
    }
    const spy = vi.spyOn(webPush, 'deliver');
    failWith(context, 'DOWN');
    await deliver(context);
    context.clock.advance(10 * MINUTE_MS);
    await deliver(context);

    const ttls = spy.mock.calls.map((call) => call[2].ttlSeconds);

    expect(ttls.slice(0, 3)).toEqual([3600, 3600, 3600]);
    expect(ttls.slice(3)).toEqual([3000, 3000, 3000]);
  });

  it('購読が無効（解除・期限切れ）なら、購読を無効にして、その購読への配信は断念する', async () => {
    const context = await withSubscriptions();
    failWith(context, 'REJECT');

    await deliver(context);

    expect(await context.container.repositories.pushSubscriptions.listActive()).toEqual([]);
    // 購読は、最初に配信した通知で、無効と分かる（以降の通知は、有効な購読がないため、配信する相手がない）
    const abandoned = (await notificationsOf(context)).filter(
      (item) => item.webPushDeliveries?.[0]?.result === 'ABANDONED',
    );
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0] === undefined ? undefined : webPushOf(abandoned[0])).toMatchObject({
      result: 'FAILURE',
    });
  });

  it('再送待ちの間に、購読が解除（無効に）されたら、その購読への配信は断念する', async () => {
    const context = await withSubscriptions();
    failWith(context, 'DOWN');
    await deliver(context);
    await context.container.repositories.pushSubscriptions.deactivate('s-1');
    context.clock.advance(MINUTE_MS);

    const summary = await deliver(context);

    expect(summary).toMatchObject({ delivered: 0, failed: 0 });
    expect((await firstNotification(context)).webPushDeliveries?.[0]).toMatchObject({
      result: 'ABANDONED',
    });
  });

  it('配信の失敗が通知のエラー以外（想定外）でも、記録して再送の対象にする', async () => {
    const context = await withSubscriptions();
    const webPush = context.container.dev?.mocks.webPush;
    if (webPush === undefined) {
      throw new Error('テストの前提');
    }
    vi.spyOn(webPush, 'deliver').mockRejectedValue(new Error('想定外'));

    await deliver(context);

    expect((await firstNotification(context)).webPushDeliveries?.[0]).toMatchObject({
      result: 'FAILURE',
      errorMessage: '配信に失敗しました',
    });
  });

  it('購読ごとの状態を持たない、以前の形式の通知: 未完了なら、購読ごとの形式で配信する。失敗は、配信せずに終了させる', async () => {
    const context = await setup();
    const repository = context.container.repositories.notifications;
    await context.container.repositories.pushSubscriptions.save({
      subscriptionId: 's-1',
      userId: USER,
      endpoint: 'https://push.invalid/1',
      isActive: true,
      createdAt: TEST_NOW.toISOString(),
    });
    const legacy = (id: string, result: 'PENDING' | 'FAILURE') => ({
      notificationId: NotificationIdSchema.parse(id),
      kind: 'INGESTION_FAILURE' as const,
      sourceId: 'robot',
      message: '【データ取得失敗】ロボットデータ: 接続できません',
      createdAt: TEST_NOW.toISOString(),
      dedupKey: `INGESTION_FAILURE#${id}`,
      deliveries: [
        {
          channel: 'WEB_PUSH' as const,
          result,
          attempts: result === 'PENDING' ? 0 : 3,
          updatedAt: TEST_NOW.toISOString(),
        },
      ],
    });
    await repository.add(legacy('n-pending', 'PENDING'));
    await repository.add(legacy('n-failure', 'FAILURE'));

    const summary = await deliver(context);

    expect(summary).toMatchObject({ notificationsProcessed: 2, delivered: 1, failed: 0 });
    expect(context.container.dev?.mocks.webPush.delivered()).toMatchObject([
      { notificationId: 'n-pending', subscriptionId: 's-1' },
    ]);
    expect(await repository.listUndelivered()).toEqual([]);
  });
});

describe('農業情報基盤との連携（UC-11。JB-03）', () => {
  async function withQueue() {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(20, new Date(TEST_NOW.getTime() - HOUR_MS).toISOString()),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');
    return context;
  }

  it('連携キューの項目を送り、結果（成功）を記録する', async () => {
    const context = await withQueue();

    const summary = await context.container.jobRunner.run('JB-03');

    expect(summary).toMatchObject({ jobId: 'JB-03', summary: { sent: 18, failed: 0, held: 0 } });
    expect(context.container.dev?.mocks.federation.received()).toHaveLength(18);
    expect(
      (await context.container.repositories.federation.listLogs({ limit: 5 })).items[0],
    ).toMatchObject({ result: 'SENT', itemCount: 18 });
    expect(await context.container.repositories.federation.countByStatus()).toMatchObject({
      SENT: 18,
      PENDING: 0,
    });
    // 送信済みは、再び送らない。キューが空なら、記録も作らない
    expect(await context.container.jobRunner.run('JB-03')).toMatchObject({ summary: { sent: 0 } });
    expect(
      (await context.container.repositories.federation.listLogs({ limit: 5 })).items,
    ).toHaveLength(1);
  });

  it('農業情報基盤が停止していたら、連携を保留し、他の機能（取り込み・評価・通知）は継続する', async () => {
    const context = await withQueue();
    context.container.dev?.faults.federation.set({ mode: 'DOWN' });

    const held = await context.container.jobRunner.run('JB-03');
    const evaluation = await context.container.evaluationService.evaluateAll('DEV');

    expect(held).toMatchObject({ summary: { held: 18 } });
    expect(await context.container.repositories.federation.countByStatus()).toMatchObject({
      HELD: 18,
    });
    expect(
      (await context.container.repositories.federation.listLogs({ limit: 1 })).items[0],
    ).toMatchObject({ result: 'HELD', message: expect.stringContaining('保留') });
    expect(evaluation.equipmentEvaluated).toBe(3);
  });

  it('保留中は間隔を広げながら再試行し、復旧後に、保留していた項目をすべて送る', async () => {
    const context = await withQueue();
    context.container.dev?.faults.federation.set({ mode: 'DOWN' });
    await context.container.jobRunner.run('JB-03');

    // 次の試行の日時（5分後）が来るまでは、送らない
    const tooEarly = await context.container.jobRunner.run('JB-03');
    context.clock.advance(5 * 60_000);
    const stillDown = await context.container.jobRunner.run('JB-03');
    // 2回目の失敗では、間隔が10分に広がる
    context.clock.advance(5 * 60_000);
    const notYet = await context.container.jobRunner.run('JB-03');
    context.container.dev?.faults.federation.set({ mode: 'UP' });
    context.clock.advance(5 * 60_000);
    const recovered = await context.container.jobRunner.run('JB-03');

    expect(tooEarly).toMatchObject({ summary: { held: 0, sent: 0 } });
    expect(stillDown).toMatchObject({ summary: { held: 18 } });
    expect(notYet).toMatchObject({ summary: { held: 0, sent: 0 } });
    expect(recovered).toMatchObject({ summary: { sent: 18 } });
    expect(context.container.dev?.mocks.federation.received()).toHaveLength(18);
  });

  it('連携先が受け付けなかった場合は、失敗として記録し、再試行の間隔を上限まで広げる', async () => {
    const context = await withQueue();
    context.container.dev?.faults.federation.set({ mode: 'REJECT' });

    const rejected = await context.container.jobRunner.run('JB-03');

    expect(rejected).toMatchObject({ summary: { failed: 18 } });
    const [item] = await context.container.repositories.federation.listDue(
      new Date(TEST_NOW.getTime() + 24 * HOUR_MS),
      1,
    );
    expect(item).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      result: '農業情報基盤への連携に失敗しました',
    });
    await context.container.repositories.federation.update({ ...must(item), attempts: 20 });
    context.clock.advance(24 * HOUR_MS);
    await context.container.jobRunner.run('JB-03');
    const [capped] = await context.container.repositories.federation.listDue(
      new Date(context.clock.now().getTime() + 48 * HOUR_MS),
      100,
    );
    const delay = new Date(capped?.nextAttemptAt ?? 0).getTime() - context.clock.now().getTime();
    expect(delay).toBeLessThanOrEqual(720 * 60_000);
  });

  it('想定外のエラーも、失敗として記録する', async () => {
    const context = await withQueue();
    const federation = context.container.dev?.mocks.federation;
    if (federation === undefined) {
      throw new Error('テストの前提');
    }
    vi.spyOn(federation, 'send').mockRejectedValue(new Error('想定外'));

    expect(await context.container.jobRunner.run('JB-03')).toMatchObject({
      summary: { failed: 18 },
    });
  });
});

describe('ダッシュボード（UC-01）', () => {
  const get = (
    context: Context,
    overrides: Partial<Parameters<Context['container']['dashboardQuery']['get']>[0]> = {},
  ) =>
    context.container.dashboardQuery.get({
      equipmentId: FACILITY_ID,
      horizon: 'LONG',
      periodDays: 7,
      ...overrides,
    });

  it('評価がまだなら、全観点を不明にして、評価されていない旨を示す。データは未取得', async () => {
    const context = await setup();

    const dashboard = await get(context);

    expect(dashboard).toMatchObject({
      dataFreshness: 'NONE',
      lastReceivedAt: null,
      evaluatedAt: null,
      summary: { NORMAL: 0, CAUTION: 0, ERROR: 0, UNKNOWN: 10 },
    });
    expect(dashboard.viewpoints).toHaveLength(10);
    expect(dashboard.viewpoints[0]).toMatchObject({
      name: '収穫精度',
      status: 'UNKNOWN',
      statuses: { short: null, long: 'UNKNOWN' },
      horizonUsed: 'LONG',
    });
    expect(dashboard.viewpoints[0]?.diagnosticMessage).toContain('評価がまだ行われていません');
    // 評価前も、データの取得・入力を確認する推奨アクションを付ける（UC-04。FR-5.5）
    expect(dashboard.viewpoints.map((card) => card.recommendedAction)).toEqual(
      Array.from(
        { length: 10 },
        () => 'データの取得・入力を確認してください（取り込みの状況、手動入力）',
      ),
    );
  });

  it('観点を表示順に、ステータス・主要メトリクス・診断メッセージ・推奨アクションつきで返し、件数を集計する', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      ...generateAutoObservations({
        robotId: ROBOT_ID,
        sensorId: SENSOR_ID,
        from: new Date(TEST_NOW.getTime() - 3 * HOUR_MS),
        to: new Date(TEST_NOW.getTime() - 15 * 60_000),
        intervalMinutes: 15,
        seed: 1,
      }),
      ...generateManualObservations({
        robotId: ROBOT_ID,
        at: new Date(TEST_NOW.getTime() - 30 * 60_000),
        enteredBy: undefined,
      }),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');

    const dashboard = await get(context);

    expect(dashboard.viewpoints.map((card) => card.viewpointId)).toEqual([
      'harvestAccuracy',
      'harvestSpeed',
      'environmentalAdaptability',
      'operability',
      'maintainability',
      'costEfficiency',
      'safety',
      'dataUtilization',
      'durability',
      'satisfaction',
    ]);
    const speed = dashboard.viewpoints.find((card) => card.viewpointId === 'harvestSpeed');
    expect(speed?.status).toBe('NORMAL');
    expect(Object.keys(speed?.metrics ?? {})).toEqual([
      'averageSecondsPerFruit',
      'travelStoppedRatePercent',
    ]);
    expect(speed?.statusDetail).toMatchObject({ category: 'NORMAL' });
    expect(speed?.recommendedAction).toContain('維持');
    expect(dashboard.summary.UNKNOWN).toBeGreaterThan(0);
    expect(Object.values(dashboard.summary).reduce((a, b) => a + b, 0)).toBe(10);
    expect(dashboard.evaluatedAt).toBe(TEST_NOW.toISOString());
    expect(dashboard.dataFreshness).toBe('FRESH');
    expect(dashboard.staleThresholdMinutes).toBe(45);
  });

  it('最終のデータ取得から取得間隔の3倍が過ぎたら、データが古いとする', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(20, new Date(TEST_NOW.getTime() - 60_000).toISOString()),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');

    const fresh = await get(context);
    context.clock.advance(44 * 60_000);
    const boundary = await get(context);
    context.clock.advance(2 * 60_000);
    const stale = await get(context);

    expect(fresh.dataFreshness).toBe('FRESH');
    expect(boundary.dataFreshness).toBe('FRESH');
    expect(stale.dataFreshness).toBe('STALE');
    expect(stale.lastReceivedAt).toBe(new Date(TEST_NOW.getTime() - 60_000).toISOString());
  });

  it('短期視点を指定すると、短期評価を持つ観点は短期の結果を、持たない観点は長期の結果を返す', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(30, new Date(TEST_NOW.getTime() - 60_000).toISOString()),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');

    const dashboard = await get(context, { horizon: 'SHORT' });

    const environment = dashboard.viewpoints.find(
      (card) => card.viewpointId === 'environmentalAdaptability',
    );
    const satisfaction = dashboard.viewpoints.find((card) => card.viewpointId === 'satisfaction');
    expect(environment).toMatchObject({
      horizonUsed: 'SHORT',
      statuses: { short: 'CAUTION', long: 'CAUTION' },
    });
    expect(satisfaction).toMatchObject({
      horizonUsed: 'LONG',
      statuses: { short: null, long: 'UNKNOWN' },
    });
  });

  it('長期の期間を切り替えられる', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(30, new Date(TEST_NOW.getTime() - 3 * 24 * HOUR_MS).toISOString()),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');

    const oneDay = await get(context, { periodDays: 1 });
    const sevenDays = await get(context, { periodDays: 7 });

    expect(
      oneDay.viewpoints.find((card) => card.viewpointId === 'environmentalAdaptability')?.statuses
        .long,
    ).toBe('UNKNOWN');
    expect(
      sevenDays.viewpoints.find((card) => card.viewpointId === 'environmentalAdaptability')
        ?.statuses.long,
    ).toBe('CAUTION');
  });

  it('対象の設備を選ぶと、その種別の観点だけを返す（ロボット7、センサー1）', async () => {
    const context = await setup();
    await context.container.evaluationService.evaluateAll('DEV');

    const robot = await get(context, { equipmentId: ROBOT_ID });
    const sensor = await get(context, { equipmentId: SENSOR_ID });

    expect(robot.viewpoints).toHaveLength(7);
    expect(sensor.viewpoints.map((card) => card.viewpointId)).toEqual([
      'environmentalAdaptability',
    ]);
  });

  it('存在しない設備・論理削除した設備は、見つからないエラーにする', async () => {
    const context = await setup();
    const robot = equipmentSet()[1];
    if (robot === undefined) {
      throw new Error('テストの前提');
    }
    await context.container.repositories.equipment.save({ ...robot, isDeleted: true });

    await expect(get(context, { equipmentId: ROBOT_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(get(context, { equipmentId: toEquipmentId('NONE') })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('有効な取り込み元がなければ、既定の取得間隔で「古い」の基準を決める', async () => {
    const context = await setup();
    const sources = await context.container.ingestionSettings.listSources();
    await context.container.ingestionSettings.saveSources(
      sources.map((source) => ({ ...source, isEnabled: false })),
    );

    expect((await get(context)).staleThresholdMinutes).toBe(45);
  });

  it('取り込み間隔の最短を基準にする', async () => {
    const context = await setup();
    const sources = await context.container.ingestionSettings.listSources();
    await context.container.ingestionSettings.saveSources(
      sources.map((source, index) => ({ ...source, intervalMinutes: index === 0 ? 5 : 60 })),
    );

    expect((await get(context)).staleThresholdMinutes).toBe(15);
  });
});

describe('ジョブ（JB-01〜JB-04）とスケジューラ', () => {
  it('ジョブの識別子を判定できる', () => {
    expect(JOB_IDS.every((jobId) => isJobId(jobId))).toBe(true);
    expect(isJobId('JB-99')).toBe(false);
  });

  it('ジョブを、識別子から起動できる（取り込み・評価・連携・通知の配信）', async () => {
    const context = await setup();
    context.placeFixture('robot', 'robot/robot-sample-001.json');

    const results = await Promise.all(
      JOB_IDS.map((jobId) => context.container.jobRunner.run(jobId)),
    );

    expect(results.map((result) => result.jobId)).toEqual([...JOB_IDS]);
    expect(results[0]).toMatchObject({
      summaries: [
        expect.objectContaining({ sourceId: 'robot', recordCount: 14 }),
        expect.objectContaining({ sourceId: 'environment-sensor' }),
      ],
    });
    expect(results[1]).toMatchObject({ summary: { equipmentEvaluated: 3 } });
  });

  it('時計を進めると、間隔が来たジョブだけを実行する（手動・テストから起動できる）', async () => {
    const context = await setup();
    const scheduler = context.container.scheduler;

    const first = await scheduler.tick();
    const immediately = await scheduler.tick();
    context.clock.advance(60_000);
    const afterOneMinute = await scheduler.tick();
    context.clock.advance(4 * 60_000);
    const afterFiveMinutes = await scheduler.tick();

    expect(first).toEqual(['JB-01', 'JB-02', 'JB-03', 'JB-04']);
    expect(immediately).toEqual([]);
    expect(afterOneMinute).toEqual(['JB-01', 'JB-04']);
    expect(afterFiveMinutes).toEqual(['JB-01', 'JB-02', 'JB-03', 'JB-04']);
  });

  it('1つのジョブが失敗しても、他のジョブは実行する', async () => {
    const context = await setup();
    const run = vi.fn((jobId: JobId) =>
      jobId === 'JB-01' ? Promise.reject(new Error('失敗')) : Promise.resolve(JOB_OK),
    );
    const scheduler = createScheduler({
      runner: { run },
      clock: context.clock,
      plans: DEFAULT_SCHEDULE,
      logger: NULL_LOGGER,
    });

    const executed = await scheduler.tick();

    expect(executed).toEqual(['JB-01', 'JB-02', 'JB-03', 'JB-04']);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('実行中の tick に重ねて呼び出しても、二重に実行しない', async () => {
    const context = await setup();
    const run = vi.fn(
      () =>
        new Promise<JobResult>((resolve) => {
          setTimeout(() => {
            resolve(JOB_OK);
          }, 20);
        }),
    );
    const scheduler = createScheduler({
      runner: { run },
      clock: context.clock,
      plans: [must(DEFAULT_SCHEDULE[0])],
      logger: NULL_LOGGER,
    });

    const [first, second] = await Promise.all([scheduler.tick(), scheduler.tick()]);

    expect(first).toEqual(['JB-01']);
    expect(second).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('実時間の間隔で tick を繰り返し、止められる', async () => {
    const context = await setup();
    const run = vi.fn().mockResolvedValue(JOB_OK);
    const scheduler = createScheduler({
      runner: { run },
      clock: createSteppingClock(context),
      plans: [{ jobId: 'JB-04', intervalMinutes: 1 }],
      logger: NULL_LOGGER,
    });

    scheduler.start(5);
    scheduler.start(5);
    await vi.waitFor(() => {
      expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    scheduler.stop();
    scheduler.stop();
    const calls = run.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(run.mock.calls.length).toBe(calls);
  });

  it('ジョブランナーは、4つのサービスを組み合わせて作る', () => {
    const runner = createJobRunner({
      ingestion: {
        runSource: vi.fn(),
        runDueSources: vi.fn().mockResolvedValue([]),
        testConnection: vi.fn(),
        isRunning: vi.fn(),
      },
      evaluation: {
        evaluateAll: vi.fn().mockResolvedValue({
          equipmentEvaluated: 0,
          resultsSaved: 0,
          statusChanges: 0,
          notificationsCreated: 0,
        }),
        evaluateAffected: vi.fn(),
      },
      federation: {
        enqueue: vi.fn(),
        runPending: vi.fn().mockResolvedValue({ sent: 0, failed: 0, held: 0 }),
      },
      notifications: {
        notifyStatusChange: vi.fn(),
        notifyIngestionFailure: vi.fn(),
        notifyFederationExpired: vi.fn(),
        list: vi.fn(),
        unreadCount: vi.fn(),
        markRead: vi.fn(),
        markAllRead: vi.fn(),
        addMemo: vi.fn(),
        listMemos: vi.fn(),
        deliverPending: vi
          .fn()
          .mockResolvedValue({ notificationsProcessed: 0, delivered: 0, failed: 0 }),
      },
    });

    return expect(runner.run('JB-02')).resolves.toMatchObject({ jobId: 'JB-02' });
  });
});

/** tick ごとに時刻が1分進む時計（実時間の tick で、間隔が来たジョブを繰り返し実行させる）。 */
function createSteppingClock(context: Context) {
  return {
    now: () => {
      context.clock.advance(60_000);
      return context.clock.now();
    },
    sleep: () => Promise.resolve(),
  };
}

describe('通知の経過・回復日時（Issue #238。ADR-0019 の D-42）', () => {
  /** 観測の日時は固定（同じ日時の値を上書きして、状態を切り替える）。 */
  const OBSERVED_AT = new Date(TEST_NOW.getTime() - HOUR_MS).toISOString();
  const MINUTE_MS = 60_000;

  /** 指定した分だけ時計を進め、センサーの温度を上書きして、評価する。 */
  async function evaluateAfter(context: Context, minutes: number, celsius: number) {
    context.clock.advance(minutes * MINUTE_MS);
    await context.container.repositories.observations.saveMany([temperature(celsius, OBSERVED_AT)]);
    return context.container.evaluationService.evaluateAll('DEV');
  }

  /** 通知の一覧（新しい順）を、1 件ずつのページで、最後まで読む。 */
  async function listAll(context: Context, limit = 100) {
    const items = [];
    let cursor: string | undefined;
    do {
      const page = await context.container.notificationService.list(USER, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return items;
  }

  const sensorNotifications = async (context: Context, limit?: number) =>
    (await listAll(context, limit)).filter(
      (item) => item.equipmentId === SENSOR_ID && item.viewpointId === 'environmentalAdaptability',
    );

  const isoAfter = (minutes: number) =>
    new Date(TEST_NOW.getTime() + minutes * MINUTE_MS).toISOString();

  it('通知ごとに、次の通知までの経過と、最初に正常に戻った日時（通知の時点からの経過時間つき）を返す（10:00 異常 → 10:20 正常 → 10:40 異常）', async () => {
    const context = await setup();
    await evaluateAfter(context, 0, 45);
    await evaluateAfter(context, 5, 15);
    await evaluateAfter(context, 20, 45);

    const [latest, oldest] = await sensorNotifications(context);

    expect(oldest?.progress?.changes).toEqual([
      { status: 'ERROR', changedAt: isoAfter(0) },
      { status: 'NORMAL', changedAt: isoAfter(5) },
      { status: 'ERROR', changedAt: isoAfter(25) },
    ]);
    expect(oldest?.progress?.recovery).toEqual({ recoveredAt: isoAfter(5), elapsedSeconds: 300 });
    // 最新の通知は、現在までの経過。まだ、正常に戻っていない（未回復）
    expect(latest?.progress?.changes).toEqual([{ status: 'ERROR', changedAt: isoAfter(25) }]);
    expect(latest?.progress?.recovery).toBeNull();
  });

  it('1 件ずつのページで読んでも、同じ（次の通知が、別のページにあっても、経過を導出する）', async () => {
    const context = await setup();
    await evaluateAfter(context, 0, 45);
    await evaluateAfter(context, 5, 15);
    await evaluateAfter(context, 20, 45);

    const paged = await sensorNotifications(context, 1);
    const whole = await sensorNotifications(context);

    expect(paged).toHaveLength(2);
    expect(paged.map((item) => item.progress)).toEqual(whole.map((item) => item.progress));
    expect(paged[1]?.progress?.recovery).toEqual({
      recoveredAt: isoAfter(5),
      elapsedSeconds: 300,
    });
  });

  it('注意 → 異常 の通知: 注意の通知の経過に、異常への変化が入る。どちらも、未回復', async () => {
    const context = await setup();
    await evaluateAfter(context, 0, 30);
    await evaluateAfter(context, 5, 45);

    const [error, caution] = await sensorNotifications(context);

    expect(caution?.status).toBe('CAUTION');
    expect(caution?.progress?.changes.map((item) => item.status)).toEqual(['CAUTION', 'ERROR']);
    expect(caution?.progress?.recovery).toBeNull();
    expect(error?.progress?.changes.map((item) => item.status)).toEqual(['ERROR']);
  });

  it('取り込み失敗の通知には、経過を付けない。履歴がない状態変化の通知（設備を削除した、など）は、経過を示せない（null）', async () => {
    const context = await setup();
    const repository = context.container.repositories.notifications;
    await repository.add({
      notificationId: NotificationIdSchema.parse('n-ingestion'),
      kind: 'INGESTION_FAILURE',
      sourceId: 'robot',
      message: '【データ取得失敗】ロボットデータ: 接続できません',
      createdAt: TEST_NOW.toISOString(),
      dedupKey: 'INGESTION_FAILURE#robot',
      deliveries: [],
    });
    await repository.add({
      notificationId: NotificationIdSchema.parse('n-no-history'),
      kind: 'STATUS_CHANGE',
      viewpointId: 'safety',
      equipmentId: ROBOT_ID,
      status: 'ERROR',
      message: '【異常】安全性（テストロボット）: 異常',
      createdAt: TEST_NOW.toISOString(),
      dedupKey: 'STATUS_CHANGE#safety#ROBOT#ERROR',
      deliveries: [],
    });

    const items = await listAll(context);

    const ingestion = items.find((item) => item.kind === 'INGESTION_FAILURE');
    const noHistory = items.find((item) => item.kind === 'STATUS_CHANGE');
    expect(ingestion).toBeDefined();
    expect('progress' in (ingestion ?? {})).toBe(false);
    expect(noHistory?.progress).toBeNull();
  });
});
