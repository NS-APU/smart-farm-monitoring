/**
 * 実行時の耐障害性（レビュー V-042・V-044・V-052・V-056・V-098）の結合・単体テスト。
 * 外部通信のタイムアウト、設備単位の評価の失敗の分離、評価の直列化、内部のデータ不整合のエラー形式。
 */

import { describe, expect, it, vi } from 'vitest';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { createCriteriaService } from '../../src/backend/application/evaluation/criteria-service.ts';
import { createEvaluationService } from '../../src/backend/application/evaluation/evaluation-service.ts';
import { errorLogFields } from '../../src/backend/application/error-fields.ts';
import { createFederationService } from '../../src/backend/application/federation/federation-service.ts';
import { createNotificationService } from '../../src/backend/application/notification/notification-service.ts';
import { createScheduler, DEFAULT_SCHEDULE } from '../../src/backend/application/jobs/scheduler.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { OperationTimeoutError, withTimeout } from '../../src/backend/application/with-timeout.ts';
import { DEFAULT_APP_SETTINGS } from '../../src/backend/application/settings.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import { INGESTION_SETTINGS_KEY } from '../../src/backend/application/ingestion/ingestion-settings.ts';
import { equipmentSet, FACILITY_ID, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import {
  createTestContext,
  errorOf,
  TEST_NOW,
  untilEvaluationStarted,
} from '../support/test-context.ts';

const NEVER = new Promise<never>(() => undefined);

describe('withTimeout（外部通信のタイムアウト。V-042）', () => {
  it('時間内に完了すれば、結果を返す。失敗は、そのまま伝える', async () => {
    await expect(withTimeout(() => Promise.resolve(1), 1000, '処理')).resolves.toBe(1);
    await expect(
      withTimeout(() => Promise.reject(new RangeError('x')), 1000, '処理'),
    ).rejects.toThrow(RangeError);
  });

  it('時間内に完了しなければ、OperationTimeoutError で失敗させる', async () => {
    await expect(withTimeout(() => NEVER, 10, '一覧の取得')).rejects.toBeInstanceOf(
      OperationTimeoutError,
    );
  });

  it('0 以下なら、タイムアウトを設けない。Error でない値の失敗は、Error にして伝える', async () => {
    await expect(withTimeout(() => Promise.resolve('ok'), 0, '処理')).resolves.toBe('ok');
    // Error でない値での拒否（外部の実装が Error 以外を投げた場合）を再現するため、あえて文字列で拒否する
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await expect(withTimeout(() => Promise.reject('文字列'), 100, '処理')).rejects.toThrow(
      '文字列',
    );
  });
});

describe('errorLogFields（失敗のログ用のフィールド。V-097・V-098）', () => {
  it('エラーの種類・メッセージ・原因・スタック（長さを限る）を返す', () => {
    const error = new TypeError('壊れた', { cause: new RangeError('原因') });

    const fields = errorLogFields(error);

    expect(fields).toMatchObject({
      errorName: 'TypeError',
      errorMessage: '壊れた',
      errorCause: 'RangeError: 原因',
    });
    expect(fields.errorStack?.length).toBeLessThanOrEqual(2000);
  });

  it('Error でない値・文字列の原因・スタックがない場合も扱える', () => {
    expect(errorLogFields('文字列')).toEqual({ errorName: 'NonError', errorMessage: '文字列' });
    expect(errorLogFields(new Error('x', { cause: '文字の原因' }))).toMatchObject({
      errorCause: '文字の原因',
    });
    expect(errorLogFields(new Error('x', { cause: { code: 1 } }))).toMatchObject({
      errorCause: 'unknown',
    });
    const noStack = new Error('x');
    delete noStack.stack;
    expect(errorLogFields(noStack)).toEqual({ errorName: 'Error', errorMessage: 'x' });
  });
});

describe('スケジューラのジョブの最大実行時間（V-042）', () => {
  it('ジョブが応答しなくても、時間が過ぎたら失敗として記録し、次のジョブを実行する（全ジョブが止まらない）', async () => {
    const executed: string[] = [];
    const errors: { message: string; fields: unknown }[] = [];
    const clock = createControllableClock(TEST_NOW);
    const scheduler = createScheduler({
      runner: {
        run: (jobId) => {
          executed.push(jobId);
          return jobId === 'JB-01'
            ? NEVER
            : Promise.resolve({
                jobId: 'JB-04',
                summary: { notificationsProcessed: 0, delivered: 0, failed: 0 },
              });
        },
      },
      clock,
      plans: DEFAULT_SCHEDULE,
      logger: {
        ...NULL_LOGGER,
        error: (message, fields) => errors.push({ message, fields }),
      },
      jobTimeoutMs: 20,
    });

    const first = await scheduler.tick();
    // 応答しなかったジョブがあっても、tick は終わり、次の tick を実行できる
    clock.advance(6 * 60_000);
    const second = await scheduler.tick();

    expect(first).toEqual(['JB-01', 'JB-02', 'JB-03', 'JB-04']);
    expect(second).toEqual(['JB-01', 'JB-02', 'JB-03', 'JB-04']);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      message: 'ジョブの実行に失敗しました',
      fields: { jobId: 'JB-01', errorName: 'OperationTimeoutError' },
    });
  });
});

describe('農業情報基盤・Web Push の通信のタイムアウト（V-042）', () => {
  it('農業情報基盤が応答しなければ、タイムアウトして「保留」にする（連携の処理が止まらない）', async () => {
    const { repositories } = createLocalRepositories();
    const clock = createControllableClock(TEST_NOW);
    const service = createFederationService({
      federation: repositories.federation,
      port: { send: () => NEVER },
      clock,
      ids: createSequentialIdGenerator(),
      settings: { ...DEFAULT_APP_SETTINGS.federation, ioTimeoutMs: 20 },
      logger: NULL_LOGGER,
    });
    await service.enqueue({ targetType: 'OBSERVATION', targetRef: 'a', payload: {} });

    const summary = await service.runPending();

    expect(summary).toEqual({ sent: 0, failed: 0, held: 1 });
  });

  it('Web Push の配信が応答しなければ、配信の失敗として記録する（再送の対象）', async () => {
    const { repositories } = createLocalRepositories();
    const clock = createControllableClock(TEST_NOW);
    const service = createNotificationService({
      notifications: repositories.notifications,
      pushSubscriptions: repositories.pushSubscriptions,
      webPush: { deliver: () => NEVER },
      clock,
      ids: createSequentialIdGenerator(),
      settings: { ...DEFAULT_APP_SETTINGS.notification, ioTimeoutMs: 20 },
      logger: NULL_LOGGER,
    });
    await repositories.pushSubscriptions.save({
      subscriptionId: 's-1',
      userId: toUserId('user-1'),
      endpoint: 'https://push.example.invalid/1',
      isActive: true,
      createdAt: TEST_NOW.toISOString(),
    });
    await service.notifyIngestionFailure({
      sourceId: 'robot',
      sourceName: 'ロボット',
      reason: 'x',
    });

    const summary = await service.deliverPending();

    expect(summary).toEqual({ notificationsProcessed: 1, delivered: 0, failed: 1 });
    const pending = await repositories.notifications.listUndelivered(5);
    const delivery = pending[0]?.deliveries.find((item) => item.channel === 'WEB_PUSH');
    expect(delivery).toMatchObject({
      result: 'FAILURE',
      errorMessage: '配信がタイムアウトしました',
    });
  });
});

describe('評価（V-044・V-052）', () => {
  async function setupService(overrides: { failFor?: string } = {}) {
    const context = await createTestContext();
    for (const equipment of equipmentSet()) {
      await context.container.repositories.equipment.save(equipment);
    }
    const errors: { message: string; fields: unknown }[] = [];
    const repositories = context.container.repositories;
    const findForEvaluation = repositories.observations.findForEvaluation.bind(
      repositories.observations,
    );
    let concurrent = 0;
    let maxConcurrent = 0;
    const gated = {
      ...repositories,
      observations: {
        ...repositories.observations,
        async findForEvaluation(...args: Parameters<typeof findForEvaluation>) {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          concurrent -= 1;
          if (overrides.failFor !== undefined && args[0].some((id) => id === overrides.failFor)) {
            throw new RangeError('保存データが不整合です');
          }
          return findForEvaluation(...args);
        },
      },
    };
    const service = createEvaluationService({
      repositories: gated,
      criteria: createCriteriaService({ criteria: repositories.criteria }),
      notifications: context.container.notificationService,
      federation: { enqueue: vi.fn(), runPending: vi.fn() },
      clock: context.clock,
      settings: { defaultIngestionIntervalMinutes: 15 },
      logger: {
        ...NULL_LOGGER,
        error: (message, fields) => errors.push({ message, fields }),
      },
    });
    return { service, errors, maxConcurrent: () => maxConcurrent, context };
  }

  it('1つの設備の評価が失敗しても、残りの設備を評価し、失敗した設備をログに残してから、最初の失敗を伝える', async () => {
    const { service, errors, context } = await setupService({ failFor: ROBOT_ID });

    await expect(service.evaluateAll('DEV')).rejects.toThrow('保存データが不整合です');

    // ロボットを含まない設備（センサー）の評価結果は保存されている（ハウスは、配下のロボットを含むため、失敗する）
    const saved = await context.container.repositories.evaluations.listLatest(SENSOR_ID);
    expect(saved.length).toBeGreaterThan(0);
    expect(errors.filter((entry) => entry.message === '設備の評価に失敗しました')).toHaveLength(2);
    expect(errors.map((entry) => (entry.fields as { equipmentId: string }).equipmentId)).toEqual([
      FACILITY_ID,
      ROBOT_ID,
    ]);
    expect(errors[1]?.fields).toMatchObject({
      equipmentId: ROBOT_ID,
      errorName: 'RangeError',
      trigger: 'DEV',
    });
  });

  it('評価を同時に実行しない。実行中に重なった要求は、実行が終わってから、1回にまとめて実行する', async () => {
    const { service, maxConcurrent } = await setupService();

    const first = service.evaluateAll('MANUAL_ENTRY');
    // 最初の評価が始まってから、重なった要求を出す
    await untilEvaluationStarted();
    const second = service.evaluateAll('INGESTION');
    const third = service.evaluateAll('SCHEDULED');
    const results = await Promise.all([first, second, third]);
    const next = await service.evaluateAll('DEV');

    expect(maxConcurrent()).toBe(1);
    expect(second).toBe(third);
    expect(second).not.toBe(first);
    expect(results.map((summary) => summary.equipmentEvaluated)).toEqual([3, 3, 3]);
    expect(next.equipmentEvaluated).toBe(3);
  });
});

describe('エラーの応答（V-056）', () => {
  it('入力の検証の失敗（本文・クエリ・パスのパラメータ）は、400 を返す', async () => {
    const context = await createTestContext();

    const body = await context.request('/users', { method: 'POST', body: { userId: '' } });
    const query = await context.request('/dashboard?horizon=bad');
    const path = await context.request('/users/bad id', { method: 'DELETE' });

    expect(body.status).toBe(400);
    expect(query.status).toBe(400);
    expect(path.status).toBe(400);
    expect((await errorOf(body)).code).toBe('VALIDATION_ERROR');
  });

  it('保存済みのデータの不整合（内部の検証の失敗）は、入力の誤りではなく、500 とし、原因をログに残す', async () => {
    const errors: { message: string; fields: unknown }[] = [];
    const context = await createTestContext({
      logger: {
        ...NULL_LOGGER,
        error: (message, fields) => errors.push({ message, fields }),
        child: () => ({
          ...NULL_LOGGER,
          error: (message, fields) => errors.push({ message, fields }),
        }),
      },
    });
    // 取り込み設定の保存データを、スキーマと合わない値にする
    await context.container.repositories.settings.set(INGESTION_SETTINGS_KEY, [{ sourceId: 1 }]);

    const response = await context.request('/ingestion/settings');

    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe('INTERNAL_ERROR');
    expect(errors[0]).toMatchObject({
      message: '想定外のエラーが発生しました',
      fields: { method: 'GET', path: '/api/v1/ingestion/settings', errorName: 'ZodError' },
    });
    expect(
      JSON.stringify(await (await context.request('/ingestion/settings')).json()),
    ).not.toContain('sourceId');
  });
});
