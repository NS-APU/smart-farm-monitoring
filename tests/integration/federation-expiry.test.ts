/**
 * 連携の破棄の期限（#195 の #204。ADR-0016 の D-06）の結合テスト。
 * 期限（設定値。既定 30 日）を過ぎた未送信の項目は、送らずに破棄し（状態「期限切れ」）、連携のログに「期限切れ」で記録して、通知する。
 */

import { describe, expect, it } from 'vitest';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { MS_PER_DAY, MS_PER_MINUTE } from '@smart-farm/shared/time';
import { createFederationService } from '../../src/backend/application/federation/federation-service.ts';
import { createNotificationService } from '../../src/backend/application/notification/notification-service.ts';
import { FederationUnavailableError } from '../../src/backend/application/ports/federation-port.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { DEFAULT_APP_SETTINGS } from '../../src/backend/application/settings.ts';
import { createNotificationRecipients } from '../../src/backend/application/access/notification-recipients.ts';
import {
  createAccessPolicy,
  DEFAULT_ROLE_CONFIG,
} from '../../src/backend/application/auth/access-policy.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import { TEST_NOW } from '../support/test-context.ts';

const USER = toUserId('user-1');

function setup(overrides: { expiryDays?: number; batchSize?: number } = {}) {
  const { repositories } = createLocalRepositories();
  const clock = createControllableClock(TEST_NOW);
  const ids = createSequentialIdGenerator();
  let down = false;
  const sent: string[] = [];
  const notifications = createNotificationService({
    notifications: repositories.notifications,
    evaluations: repositories.evaluations,
    pushSubscriptions: repositories.pushSubscriptions,
    recipients: createNotificationRecipients({
      repositories,
      policy: createAccessPolicy(DEFAULT_ROLE_CONFIG),
    }),
    webPush: { deliver: () => Promise.resolve('DELIVERED') },
    clock,
    ids,
    settings: DEFAULT_APP_SETTINGS.notification,
    logger: NULL_LOGGER,
  });
  const service = createFederationService({
    federation: repositories.federation,
    equipment: repositories.equipment,
    notifications,
    port: {
      send: (items) => {
        if (down) {
          return Promise.reject(new FederationUnavailableError('停止中'));
        }
        sent.push(...items.map((item) => item.targetRef));
        return Promise.resolve();
      },
    },
    clock,
    ids,
    settings: { ...DEFAULT_APP_SETTINGS.federation, ...overrides },
    logger: NULL_LOGGER,
  });
  return {
    repositories,
    clock,
    service,
    notifications,
    sent,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

type Context = ReturnType<typeof setup>;

async function enqueue(context: Context, targetRef: string) {
  await context.service.enqueue({
    targetType: 'OBSERVATION',
    targetRef,
    payload: { observations: [{ itemKey: 'x' }] },
  });
}

async function logs(context: Context) {
  return (await context.repositories.federation.listLogs({ limit: 20 })).items;
}

describe('破棄の期限（#204）', () => {
  it('期限（既定 30 日）を過ぎた項目は、送らずに破棄し、連携のログに「期限切れ」で記録して、通知する', async () => {
    const context = setup();
    await enqueue(context, 'old');
    context.clock.advance(30 * MS_PER_DAY + 1);

    const summary = await context.service.runPending();

    expect(summary).toEqual({ sent: 0, failed: 0, held: 0, expired: 1 });
    expect(context.sent).toEqual([]);
    expect(await logs(context)).toMatchObject([
      {
        result: 'EXPIRED',
        itemCount: 1,
        message: '連携の期限（30 日）を過ぎた項目を、破棄しました',
      },
    ]);
    const notified = await context.notifications.list(USER, { limit: 10 });
    expect(notified.items).toMatchObject([
      {
        kind: 'FEDERATION_EXPIRED',
        message:
          '【連携の期限切れ】農業情報基盤に 30 日以上送れなかった項目を、破棄しました。連携のログを確認してください',
      },
    ]);
  });

  it('破棄した項目は、状態が「期限切れ」になり、内容（payload）は消え、以後は、送信の対象にならない', async () => {
    const context = setup();
    await enqueue(context, 'old');
    context.clock.advance(30 * MS_PER_DAY + 1);

    await context.service.runPending();
    const second = await context.service.runPending();

    expect(second).toEqual({ sent: 0, failed: 0, held: 0, expired: 0 });
    expect(await context.repositories.federation.countByStatus()).toEqual({
      PENDING: 0,
      SENT: 0,
      FAILED: 0,
      HELD: 0,
      EXPIRED: 1,
    });
    expect(await context.repositories.federation.listDue(context.clock.now(), 10)).toEqual([]);
    expect(await logs(context)).toHaveLength(1);
  });

  it('期限の境界: ちょうど 30 日は、破棄しない（送る）。30 日を 1 ミリ秒でも過ぎたら、破棄する', async () => {
    const exact = setup();
    await enqueue(exact, 'exact');
    exact.clock.advance(30 * MS_PER_DAY);
    const exactSummary = await exact.service.runPending();

    const over = setup();
    await enqueue(over, 'over');
    over.clock.advance(30 * MS_PER_DAY + 1);
    const overSummary = await over.service.runPending();

    expect(exactSummary).toEqual({ sent: 1, failed: 0, held: 0, expired: 0 });
    expect(exact.sent).toEqual(['exact']);
    expect(overSummary).toEqual({ sent: 0, failed: 0, held: 0, expired: 1 });
  });

  it('期限は、設定値で変えられる（例: 7 日）。ログ・通知の期限の日数も、設定値になる', async () => {
    const context = setup({ expiryDays: 7 });
    await enqueue(context, 'old');
    context.clock.advance(7 * MS_PER_DAY + 1);

    const summary = await context.service.runPending();

    expect(summary.expired).toBe(1);
    expect((await logs(context))[0]?.message).toBe(
      '連携の期限（7 日）を過ぎた項目を、破棄しました',
    );
    expect((await context.notifications.list(USER, { limit: 10 })).items[0]?.message).toContain(
      '7 日以上',
    );
  });

  it('同じ実行で、期限内の項目は送り、期限切れの項目だけを破棄する（ログは、期限切れと成功の 2 件）', async () => {
    const context = setup();
    await enqueue(context, 'old');
    context.clock.advance(30 * MS_PER_DAY + 1);
    await enqueue(context, 'new');

    const summary = await context.service.runPending();

    expect(summary).toEqual({ sent: 1, failed: 0, held: 0, expired: 1 });
    expect(context.sent).toEqual(['new']);
    expect((await logs(context)).map((entry) => entry.result).sort()).toEqual(['EXPIRED', 'SENT']);
  });

  it('農業情報基盤が停止中でも、期限切れの項目は破棄する（期限内の項目だけが、保留になる）', async () => {
    const context = setup();
    await enqueue(context, 'old');
    context.clock.advance(30 * MS_PER_DAY + 1);
    await enqueue(context, 'new');
    context.setDown(true);

    const summary = await context.service.runPending();

    expect(summary).toEqual({ sent: 0, failed: 0, held: 1, expired: 1 });
    expect(await context.repositories.federation.countByStatus()).toMatchObject({
      HELD: 1,
      EXPIRED: 1,
    });
  });

  it('通知は、60 分に 1 件（抑制の間に破棄した分は、連携のログにだけ残る）。60 分が過ぎたら、また通知する', async () => {
    const context = setup({ batchSize: 1 });
    await enqueue(context, 'a');
    await enqueue(context, 'b');
    await enqueue(context, 'c');
    context.clock.advance(30 * MS_PER_DAY + 1);

    await context.service.runPending();
    context.clock.advance(5 * MS_PER_MINUTE);
    await context.service.runPending();
    const within = await context.notifications.list(USER, { limit: 10 });
    context.clock.advance(60 * MS_PER_MINUTE);
    await context.service.runPending();
    const after = await context.notifications.list(USER, { limit: 10 });

    const expiredLogs = (await logs(context)).filter((entry) => entry.result === 'EXPIRED');
    expect(expiredLogs).toHaveLength(3);
    expect(within.items).toHaveLength(1);
    expect(after.items).toHaveLength(2);
  });
});
