/**
 * 評価（JB-02）の、状態の変化の通知・連携・記録の失敗と再試行の結合テスト（Issue #561。ADR-0019 の D-37・D-38）。
 * 状態の変化の記録は、通知・連携のあとに行う（完了の印）。通知・連携・記録のどれかが失敗した評価は、変化を記録せず、
 * 次の評価で再試行する（通知が永久に失われない）。記録の前に、通知・連携が済んでいる場合は、再試行で重複しうる（許容）。
 */

import { describe, expect, it, vi } from 'vitest';
import { toUserId } from '@smart-farm/shared/schemas/common';
import type { LogFields, Logger } from '../../src/backend/application/ports/logger-port.ts';
import { equipmentSet, SENSOR_ID, observation } from '../support/builders.ts';
import { createTestContext, TEST_NOW, TEST_USER } from '../support/test-context.ts';

const HOUR_MS = 3_600_000;
const SENSOR_REF = `${SENSOR_ID}#environmentalAdaptability`;
const TRANSIENT = '一時的なエラー（テスト）';

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** 出力したログを集めるロガー（ログの内容の検証用）。 */
function collectingLogger(entries: LogEntry[]): Logger {
  const logger: Logger = {
    debug: (message, fields = {}) => entries.push({ level: 'debug', message, fields }),
    info: (message, fields = {}) => entries.push({ level: 'info', message, fields }),
    warn: (message, fields = {}) => entries.push({ level: 'warn', message, fields }),
    error: (message, fields = {}) => entries.push({ level: 'error', message, fields }),
    child: () => logger,
  };
  return logger;
}

/** 温度 30℃（注意）の観測値があり、センサーの環境適応性が、初回の評価で「注意」に変わる状態。 */
async function setup(logger?: Logger) {
  const context = await createTestContext(logger === undefined ? {} : { logger });
  for (const equipment of equipmentSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  await context.container.repositories.observations.saveMany([
    observation({
      equipmentId: SENSOR_ID,
      itemKey: 'temperatureCelsius',
      value: 30,
      observedAt: new Date(TEST_NOW.getTime() - HOUR_MS).toISOString(),
    }),
  ]);
  return context;
}

type Context = Awaited<ReturnType<typeof setup>>;

async function sensorNotifications(context: Context) {
  const { items } = await context.container.repositories.notifications.list(
    toUserId(TEST_USER.userId),
    {},
    { limit: 100 },
  );
  return items
    .map((entry) => entry.notification)
    .filter((notification) => notification.equipmentId === SENSOR_ID);
}

async function sensorQueuedCount(context: Context): Promise<number> {
  const due = await context.container.repositories.federation.listDue(
    new Date(TEST_NOW.getTime() + HOUR_MS),
    1000,
  );
  return due.filter((item) => item.targetRef === SENSOR_REF).length;
}

const sensorStatusChange = (context: Context) =>
  context.container.repositories.evaluations.getLastStatusChange(
    SENSOR_ID,
    'environmentalAdaptability',
  );

describe('状態の変化の通知・連携・記録の失敗と再試行（Issue #561）', () => {
  it('通知の作成が失敗した評価の次の評価で、通知が作られる（変化を記録していないため、永久に失われない）', async () => {
    const context = await setup();
    const service = context.container.notificationService;
    const original = service.notifyStatusChange.bind(service);
    let failed = false;
    vi.spyOn(service, 'notifyStatusChange').mockImplementation((input) => {
      if (!failed && input.equipment.equipmentId === SENSOR_ID) {
        failed = true;
        return Promise.reject(new Error(TRANSIENT));
      }
      return original(input);
    });

    await expect(context.container.evaluationService.evaluateAll('DEV')).rejects.toThrow(TRANSIENT);

    // 失敗した評価では、センサーの変化を記録せず、連携にも積まない（通知・連携・記録の順）
    expect(await sensorStatusChange(context)).toBeUndefined();
    expect(await sensorNotifications(context)).toHaveLength(0);
    expect(await sensorQueuedCount(context)).toBe(0);

    context.clock.advance(5 * 60_000);
    const retry = await context.container.evaluationService.evaluateAll('SCHEDULED');

    expect(retry).toMatchObject({ statusChanges: 1, notificationsCreated: 1 });
    expect(await sensorNotifications(context)).toHaveLength(1);
    expect(await sensorStatusChange(context)).toMatchObject({ status: 'CAUTION' });
    expect(await sensorQueuedCount(context)).toBe(1);

    // 成功したあとは、通知を繰り返さない（1 回だけ）
    context.clock.advance(5 * 60_000);
    const later = await context.container.evaluationService.evaluateAll('SCHEDULED');
    expect(later).toMatchObject({ statusChanges: 0, notificationsCreated: 0 });
    expect(await sensorNotifications(context)).toHaveLength(1);
  });

  it('連携の積み込みが失敗した評価の次の評価で、変化の記録・連携・通知が行われる（通知は、重複しうる）', async () => {
    const context = await setup();
    const service = context.container.federationService;
    const original = service.enqueue.bind(service);
    let failed = false;
    vi.spyOn(service, 'enqueue').mockImplementation((input) => {
      if (!failed && input.targetRef === SENSOR_REF) {
        failed = true;
        return Promise.reject(new Error(TRANSIENT));
      }
      return original(input);
    });

    await expect(context.container.evaluationService.evaluateAll('DEV')).rejects.toThrow(TRANSIENT);

    expect(await sensorStatusChange(context)).toBeUndefined();
    expect(await sensorQueuedCount(context)).toBe(0);
    // 通知は、連携の前に作る。失敗した評価でも、通知はある
    expect(await sensorNotifications(context)).toHaveLength(1);

    context.clock.advance(5 * 60_000);
    const retry = await context.container.evaluationService.evaluateAll('SCHEDULED');

    expect(retry).toMatchObject({ statusChanges: 1 });
    expect(await sensorStatusChange(context)).toMatchObject({ status: 'CAUTION' });
    expect(await sensorQueuedCount(context)).toBe(1);
    // 取りこぼしより重複を許容する（再試行で、通知が重複する）
    expect(await sensorNotifications(context)).toHaveLength(2);

    context.clock.advance(5 * 60_000);
    const later = await context.container.evaluationService.evaluateAll('SCHEDULED');
    expect(later).toMatchObject({ statusChanges: 0, notificationsCreated: 0 });
    expect(await sensorNotifications(context)).toHaveLength(2);
    expect(await sensorQueuedCount(context)).toBe(1);
  });

  it('状態の変化の記録が失敗した評価の次の評価で、変化が再び検出される（通知・連携は、重複しうる）', async () => {
    const context = await setup();
    const repository = context.container.repositories.evaluations;
    const original = repository.appendStatusChange.bind(repository);
    let failed = false;
    vi.spyOn(repository, 'appendStatusChange').mockImplementation((change) => {
      if (!failed && change.equipmentId === SENSOR_ID) {
        failed = true;
        return Promise.reject(new Error(TRANSIENT));
      }
      return original(change);
    });

    await expect(context.container.evaluationService.evaluateAll('DEV')).rejects.toThrow(TRANSIENT);

    expect(await sensorStatusChange(context)).toBeUndefined();
    expect(await sensorNotifications(context)).toHaveLength(1);
    expect(await sensorQueuedCount(context)).toBe(1);

    context.clock.advance(5 * 60_000);
    const retry = await context.container.evaluationService.evaluateAll('SCHEDULED');

    expect(retry).toMatchObject({ statusChanges: 1, notificationsCreated: 1 });
    expect(await sensorStatusChange(context)).toMatchObject({ status: 'CAUTION' });
    expect(await sensorNotifications(context)).toHaveLength(2);
    expect(await sensorQueuedCount(context)).toBe(2);

    context.clock.advance(5 * 60_000);
    const later = await context.container.evaluationService.evaluateAll('SCHEDULED');
    expect(later).toMatchObject({ statusChanges: 0, notificationsCreated: 0 });
    expect(await sensorNotifications(context)).toHaveLength(2);
  });

  it('失敗がなければ、通知の作成 → 連携への積み込み → 状態の変化の記録の順に行い、通知は 1 回だけ', async () => {
    const context = await setup();
    const notify = vi.spyOn(context.container.notificationService, 'notifyStatusChange');
    const enqueue = vi.spyOn(context.container.federationService, 'enqueue');
    const append = vi.spyOn(context.container.repositories.evaluations, 'appendStatusChange');

    await context.container.evaluationService.evaluateAll('DEV');

    const orderOf = (spy: { mock: { calls: unknown[][]; invocationCallOrder: number[] } }) => {
      const index = spy.mock.calls.findIndex((call) => {
        const argument = call[0] as {
          equipment?: { equipmentId: string };
          targetRef?: string;
          equipmentId?: string;
        };
        return (
          argument.equipment?.equipmentId === SENSOR_ID ||
          argument.targetRef === SENSOR_REF ||
          argument.equipmentId === SENSOR_ID
        );
      });
      const order = spy.mock.invocationCallOrder[index];
      if (order === undefined) {
        throw new Error('センサーの呼び出しがありません');
      }
      return order;
    };
    const [notifyOrder = 0, enqueueOrder = 0, appendOrder = 0] = [notify, enqueue, append].map(
      orderOf,
    );
    expect(notifyOrder).toBeLessThan(enqueueOrder);
    expect(enqueueOrder).toBeLessThan(appendOrder);
    expect(await sensorNotifications(context)).toHaveLength(1);
  });

  describe('ログ', () => {
    it('評価の失敗のログに、設備・観点・段階（通知・連携・記録）を残す（秘密情報・個人情報は含まない）', async () => {
      const entries: LogEntry[] = [];
      const context = await setup(collectingLogger(entries));
      const service = context.container.notificationService;
      vi.spyOn(service, 'notifyStatusChange').mockRejectedValueOnce(new Error(TRANSIENT));

      await expect(context.container.evaluationService.evaluateAll('DEV')).rejects.toThrow(
        TRANSIENT,
      );

      const failure = entries.find((entry) => entry.message === '設備の評価に失敗しました');
      expect(failure).toMatchObject({
        level: 'error',
        fields: { trigger: 'DEV', stage: 'NOTIFICATION', errorMessage: TRANSIENT },
      });
      expect(failure?.fields.equipmentId).toBeTypeOf('string');
      expect(failure?.fields.viewpointId).toBeTypeOf('string');
    });

    it('連携・記録の失敗の段階も、ログに残る', async () => {
      const entries: LogEntry[] = [];
      const context = await setup(collectingLogger(entries));
      vi.spyOn(context.container.federationService, 'enqueue').mockRejectedValueOnce(
        new Error(TRANSIENT),
      );
      vi.spyOn(
        context.container.repositories.evaluations,
        'appendStatusChange',
      ).mockRejectedValueOnce(new Error(TRANSIENT));

      // 設備ごとに失敗して、残りの設備の評価を続ける（連携の失敗と、記録の失敗は、別の設備で起きる）
      await expect(context.container.evaluationService.evaluateAll('DEV')).rejects.toThrow(
        TRANSIENT,
      );

      const stages = entries
        .filter((entry) => entry.message === '設備の評価に失敗しました')
        .map((entry) => entry.fields.stage);
      expect(stages).toContain('FEDERATION');
      expect(stages).toContain('RECORD');
    });

    it('「評価を実行しました」のログに、状態の変化の件数と通知の件数を入れる', async () => {
      const entries: LogEntry[] = [];
      const context = await setup(collectingLogger(entries));

      const summary = await context.container.evaluationService.evaluateAll('DEV');

      const executed = entries.find((entry) => entry.message === '評価を実行しました');
      expect(executed?.fields).toMatchObject({
        trigger: 'DEV',
        statusChanges: summary.statusChanges,
        notificationsCreated: summary.notificationsCreated,
      });
      expect(summary.notificationsCreated).toBeGreaterThan(0);
    });
  });
});
