/**
 * 評価（JB-02）・異常検知と通知（UC-05, UC-10, UC-22。JB-04）・連携（UC-11。JB-03）・ダッシュボード（UC-01）の結合テスト。
 */

import { describe, expect, it, vi } from 'vitest';
import { toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
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
      settings: { defaultIngestionIntervalMinutes: 15 },
      logger: NULL_LOGGER,
    });

    await expect(service.evaluateAll('DEV')).rejects.toThrow('判断基準が見つかりません');
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

  it('状態が行き来しても、抑制の期間内の同じ状態の通知は繰り返さず、期間が過ぎたら通知する', async () => {
    const context = await setup();
    /** 指定した分だけ時計を進め、直前の時刻の温度を取り込んで、評価する。 */
    async function evaluateAfter(minutes: number, celsius: number) {
      context.clock.advance(minutes * 60_000);
      await context.container.repositories.observations.saveMany([
        temperature(celsius, new Date(context.clock.now().getTime() - 60_000).toISOString()),
      ]);
      return (await context.container.evaluationService.evaluateAll('DEV')).notificationsCreated;
    }
    const environmentNotifications = async () =>
      (await notificationsOf(context)).filter(
        (item) => item.viewpointId === 'environmentalAdaptability',
      );

    const first = await evaluateAfter(0, 30);
    const backToNormal = await evaluateAfter(5, 15);
    const cautionAgainSoon = await evaluateAfter(5, 30);
    const countWhileSuppressed = (await environmentNotifications()).length;
    await evaluateAfter(60, 15);
    const cautionAfterSuppression = await evaluateAfter(5, 30);

    // 初回: 環境適応性（ハウス・センサー）と、データ活用度合い（ハウス）
    expect(first).toBe(3);
    expect(backToNormal).toBe(0);
    // 10分後の同じ「注意」は、抑制の期間（60分）内のため、通知しない
    expect(cautionAgainSoon).toBe(0);
    expect(countWhileSuppressed).toBe(2);
    // 抑制の期間が過ぎたあとの「注意」は、通知する
    expect(cautionAfterSuppression).toBe(2);
    expect(await environmentNotifications()).toHaveLength(4);
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

describe('Web Push の配信と再送（FR-7.2, FR-7.7。JB-04）', () => {
  async function withSubscription() {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(30, new Date(TEST_NOW.getTime() - HOUR_MS).toISOString()),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');
    await context.container.repositories.pushSubscriptions.save({
      subscriptionId: 's-1',
      userId: USER,
      endpoint: 'https://push.invalid/1',
      isActive: true,
      createdAt: TEST_NOW.toISOString(),
    });
    return context;
  }

  async function pushDelivery(context: Context) {
    const [notification] = await notificationsOf(context);
    return notification?.deliveries.find((delivery) => delivery.channel === 'WEB_PUSH');
  }

  it('購読している端末へ配信し、配信の結果を記録する', async () => {
    const context = await withSubscription();

    const summary = await context.container.notificationService.deliverPending();

    expect(summary).toEqual({ notificationsProcessed: 3, delivered: 3, failed: 0 });
    expect(context.container.dev?.mocks.webPush.delivered()).toHaveLength(3);
    expect(await pushDelivery(context)).toMatchObject({ result: 'SUCCESS', attempts: 1 });
    // 配信済みの通知は、再び配信しない
    expect(await context.container.notificationService.deliverPending()).toMatchObject({
      notificationsProcessed: 0,
    });
  });

  it('購読がなければ、配信する相手がなく、配信は完了とする（画面内の通知のみ）', async () => {
    const context = await setup();
    await context.container.repositories.observations.saveMany([
      temperature(30, new Date(TEST_NOW.getTime() - HOUR_MS).toISOString()),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');

    const summary = await context.container.notificationService.deliverPending();

    expect(summary).toMatchObject({ delivered: 3, failed: 0 });
    expect(context.container.dev?.mocks.webPush.delivered()).toEqual([]);
  });

  it('配信に失敗したら記録して再送し、試行回数の上限で止める。画面内の通知には影響しない', async () => {
    const context = await withSubscription();
    context.container.dev?.faults.webPush.set({ mode: 'DOWN' });

    const first = await context.container.notificationService.deliverPending();
    const delivery = await pushDelivery(context);
    await context.container.notificationService.deliverPending();
    await context.container.notificationService.deliverPending();
    const afterLimit = await context.container.notificationService.deliverPending();

    expect(first).toMatchObject({ failed: 3 });
    expect(delivery).toMatchObject({
      result: 'FAILURE',
      attempts: 1,
      errorMessage: 'Web Push の配信サービスに接続できません',
    });
    expect(await pushDelivery(context)).toMatchObject({ result: 'FAILURE', attempts: 3 });
    expect(afterLimit.notificationsProcessed).toBe(0);
    expect(await context.container.notificationService.unreadCount(USER)).toBe(3);
  });

  it('復旧後の再送で配信できる', async () => {
    const context = await withSubscription();
    context.container.dev?.faults.webPush.set({ mode: 'DOWN' });
    await context.container.notificationService.deliverPending();
    context.container.dev?.faults.webPush.set({ mode: 'UP' });

    const retry = await context.container.notificationService.deliverPending();

    expect(retry).toMatchObject({ delivered: 3, failed: 0 });
    expect(await pushDelivery(context)).toMatchObject({ result: 'SUCCESS', attempts: 2 });
  });

  it('購読が無効（解除・期限切れ）なら、購読を無効にする', async () => {
    const context = await withSubscription();
    context.container.dev?.faults.webPush.set({ mode: 'REJECT' });

    await context.container.notificationService.deliverPending();

    expect(await context.container.repositories.pushSubscriptions.listActive()).toEqual([]);
  });

  it('配信の失敗が通知のエラー以外（想定外）でも、記録して再送の対象にする', async () => {
    const context = await withSubscription();
    const webPush = context.container.dev?.mocks.webPush;
    if (webPush === undefined) {
      throw new Error('テストの前提');
    }
    vi.spyOn(webPush, 'deliver').mockRejectedValue(new Error('想定外'));

    await context.container.notificationService.deliverPending();

    expect(await pushDelivery(context)).toMatchObject({
      result: 'FAILURE',
      errorMessage: '配信に失敗しました',
    });
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
        list: vi.fn(),
        unreadCount: vi.fn(),
        markRead: vi.fn(),
        markAllRead: vi.fn(),
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
