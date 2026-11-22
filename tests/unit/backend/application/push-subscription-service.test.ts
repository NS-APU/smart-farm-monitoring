/**
 * Web Push の購読のユースケース（UC-23。SC-15）の単体テスト。
 * 購読が無効になったことの判定（#159 SC-15-6）と、テスト通知（#159 SC-15-2。宛先は自分のこの端末だけ・1 分に 1 回まで）を確かめる。
 */

import { describe, expect, it } from 'vitest';
import { AppError } from '@smart-farm/shared/errors';
import { toUserId } from '@smart-farm/shared/schemas/common';
import {
  createPushSubscriptionService,
  pushSubscriptionId,
  PUSH_TEST_INTERVAL_SECONDS,
} from '../../../../src/backend/application/notification/push-subscription-service.ts';
import {
  NotificationDeliveryError,
  type DeliveryOutcome,
  type NotifierPort,
} from '../../../../src/backend/application/ports/notifier-port.ts';
import type { PushSubscriptionRecord } from '../../../../src/backend/application/ports/records.ts';
import { createControllableClock } from '../../../../src/backend/infrastructure/local/clocks.ts';
import { createLocalRepositories } from '../../../../src/backend/infrastructure/local/local-repositories.ts';

const NOW = new Date('2026-11-22T03:00:00.000Z');
const USER_A = toUserId('user-a');
const USER_B = toUserId('user-b');
const ENDPOINT = 'https://push.example.invalid/endpoint-a';
const OTHER_ENDPOINT = 'https://push.example.invalid/endpoint-b';
const KEYS = { p256dh: 'dummy_p256dh-key', auth: 'dummy_auth-secret' };
const PUBLIC_KEY = 'dummy-web-push-public-key';

/** テスト通知の送信の偽物。呼ばれた購読を記録し、指定の結果（または例外）を返す。 */
function fakeNotifier(
  behavior: 'DELIVERED' | 'SUBSCRIPTION_GONE' | 'FAIL' | 'TIMEOUT' = 'DELIVERED',
) {
  const tested: { subscription: PushSubscriptionRecord; ttlSeconds: number }[] = [];
  const notifier: NotifierPort = {
    deliver: () => Promise.resolve('DELIVERED'),
    deliverTest(subscription, options): Promise<DeliveryOutcome> {
      tested.push({ subscription, ttlSeconds: options.ttlSeconds });
      if (behavior === 'FAIL') {
        return Promise.reject(new NotificationDeliveryError('配信サービスに接続できません'));
      }
      if (behavior === 'TIMEOUT') {
        return new Promise<DeliveryOutcome>(() => undefined);
      }
      return Promise.resolve(behavior);
    },
  };
  return { notifier, tested };
}

function setup(
  options: { behavior?: Parameters<typeof fakeNotifier>[0]; ioTimeoutMs?: number } = {},
) {
  const clock = createControllableClock(NOW);
  clock.freeze(NOW);
  const { repositories } = createLocalRepositories();
  const { notifier, tested } = fakeNotifier(options.behavior);
  const service = createPushSubscriptionService({
    subscriptions: repositories.pushSubscriptions,
    clock,
    publicKey: PUBLIC_KEY,
    webPush: notifier,
    ioTimeoutMs: options.ioTimeoutMs ?? 0,
  });
  return { service, clock, tested, subscriptions: repositories.pushSubscriptions };
}

async function expectAppError(
  promise: Promise<unknown>,
  code: AppError['code'],
): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('購読が無効になったことの判定（status の isInvalidated。SC-15-6）', () => {
  it('端末（endpoint）を指定: その端末の購読が、自動で無効にされていれば true。有効・記録なし・解除した（記録を消した）端末は false', async () => {
    const { service, subscriptions } = setup();
    await service.subscribe(USER_A, ENDPOINT, KEYS);
    await service.subscribe(USER_A, OTHER_ENDPOINT, KEYS);
    await subscriptions.deactivate(pushSubscriptionId(USER_A, ENDPOINT));

    expect(await service.status(USER_A, ENDPOINT)).toMatchObject({
      isSubscribed: false,
      isInvalidated: true,
    });
    expect(await service.status(USER_A, OTHER_ENDPOINT)).toMatchObject({
      isSubscribed: true,
      isInvalidated: false,
    });
    expect(
      await service.status(USER_A, 'https://push.example.invalid/never-subscribed'),
    ).toMatchObject({ isSubscribed: false, isInvalidated: false });
    await service.unsubscribe(USER_A, ENDPOINT);
    expect(await service.status(USER_A, ENDPOINT)).toMatchObject({ isInvalidated: false });
  });

  it('もう一度有効にする（同じ端末で購読し直す）と、無効になったことの表示は消える', async () => {
    const { service, subscriptions } = setup();
    await service.subscribe(USER_A, ENDPOINT, KEYS);
    await subscriptions.deactivate(pushSubscriptionId(USER_A, ENDPOINT));

    await service.subscribe(USER_A, ENDPOINT, KEYS);

    expect(await service.status(USER_A, ENDPOINT)).toMatchObject({
      isSubscribed: true,
      isInvalidated: false,
    });
  });

  it('端末を指定しない: 有効な購読がなく、無効にされた購読がある利用者だけ true（この端末が、ブラウザの側で購読を失ったとき）', async () => {
    const { service, subscriptions } = setup();
    await service.subscribe(USER_A, ENDPOINT, KEYS);
    await service.subscribe(USER_B, OTHER_ENDPOINT, KEYS);
    await subscriptions.deactivate(pushSubscriptionId(USER_A, ENDPOINT));

    expect(await service.status(USER_A)).toMatchObject({
      isSubscribed: false,
      isInvalidated: true,
    });
    // ほかの利用者の購読は、影響しない。有効な購読が 1 つでもあれば、false
    expect(await service.status(USER_B)).toMatchObject({
      isSubscribed: true,
      isInvalidated: false,
    });
    await service.subscribe(USER_A, OTHER_ENDPOINT, KEYS);
    expect(await service.status(USER_A)).toMatchObject({
      isSubscribed: true,
      isInvalidated: false,
    });
  });

  it('購読がない利用者は false', async () => {
    const { service } = setup();

    expect(await service.status(USER_A)).toMatchObject({
      isSubscribed: false,
      isInvalidated: false,
    });
    expect(await service.status(USER_A, ENDPOINT)).toMatchObject({ isInvalidated: false });
  });
});

describe('テスト通知（sendTest。SC-15-2）', () => {
  it('自分のこの端末（購読）だけへ送る。ほかの端末・利用者には送らない。短い有効期限（TTL）を付ける', async () => {
    const { service, tested } = setup();
    await service.subscribe(USER_A, ENDPOINT, KEYS);
    await service.subscribe(USER_A, OTHER_ENDPOINT, KEYS);
    await service.subscribe(USER_B, ENDPOINT, KEYS);

    await service.sendTest(USER_A, ENDPOINT);

    expect(tested).toHaveLength(1);
    expect(tested[0]?.subscription).toMatchObject({ userId: USER_A, endpoint: ENDPOINT });
    expect(tested[0]?.ttlSeconds).toBe(PUSH_TEST_INTERVAL_SECONDS);
  });

  it('この端末が有効でない（購読がない）なら NOT_FOUND。送らない。ほかの利用者の購読の宛先を指定しても、同じ', async () => {
    const { service, tested } = setup();
    await service.subscribe(USER_B, OTHER_ENDPOINT, KEYS);

    await expectAppError(service.sendTest(USER_A, ENDPOINT), 'NOT_FOUND');
    await expectAppError(service.sendTest(USER_A, OTHER_ENDPOINT), 'NOT_FOUND');

    expect(tested).toHaveLength(0);
  });

  it('無効にされた購読（配信の結果で、自動で無効になった）なら CONFLICT。送らない', async () => {
    const { service, tested, subscriptions } = setup();
    await service.subscribe(USER_A, ENDPOINT, KEYS);
    await subscriptions.deactivate(pushSubscriptionId(USER_A, ENDPOINT));

    const error = await expectAppError(service.sendTest(USER_A, ENDPOINT), 'CONFLICT');

    expect(error.message).toContain('無効になりました');
    expect(tested).toHaveLength(0);
  });

  it('1 分に 1 回まで: 1 分以内の再送は RATE_LIMITED（あと何秒かを示す）。送らない。1 分たてば、また送れる', async () => {
    const { service, clock, tested } = setup();
    await service.subscribe(USER_A, ENDPOINT, KEYS);
    await service.sendTest(USER_A, ENDPOINT);

    clock.advance(20_000);
    const error = await expectAppError(service.sendTest(USER_A, ENDPOINT), 'RATE_LIMITED');
    expect(error.message).toContain('1 分に 1 回');
    expect(error.message).toContain('あと 40 秒');
    clock.advance(39_000);
    await expectAppError(service.sendTest(USER_A, ENDPOINT), 'RATE_LIMITED');
    expect(tested).toHaveLength(1);

    clock.advance(1_000);
    await service.sendTest(USER_A, ENDPOINT);

    expect(tested).toHaveLength(2);
  });

  it('制限は、端末（購読）ごと。別の端末・別の利用者には、影響しない', async () => {
    const { service, tested } = setup();
    await service.subscribe(USER_A, ENDPOINT, KEYS);
    await service.subscribe(USER_A, OTHER_ENDPOINT, KEYS);
    await service.subscribe(USER_B, ENDPOINT, KEYS);

    await service.sendTest(USER_A, ENDPOINT);
    await service.sendTest(USER_A, OTHER_ENDPOINT);
    await service.sendTest(USER_B, ENDPOINT);

    expect(tested).toHaveLength(3);
  });

  it('制限の記録は、購読の記録に残る（複数のサーバーの実行環境でも守る）。購読し直しても、1 分以内は送れない', async () => {
    const { service, subscriptions, tested } = setup();
    await service.subscribe(USER_A, ENDPOINT, KEYS);
    await service.sendTest(USER_A, ENDPOINT);

    expect((await subscriptions.listByUser(USER_A))[0]?.testSentAt).toBe(NOW.toISOString());
    await service.subscribe(USER_A, ENDPOINT, KEYS);

    await expectAppError(service.sendTest(USER_A, ENDPOINT), 'RATE_LIMITED');
    expect(tested).toHaveLength(1);
  });

  it('配信サービスが購読を無効（解除・期限切れ）と返したら、購読を無効にし、CONFLICT（もう一度有効にするよう促す）', async () => {
    const { service, subscriptions } = setup({ behavior: 'SUBSCRIPTION_GONE' });
    await service.subscribe(USER_A, ENDPOINT, KEYS);

    const error = await expectAppError(service.sendTest(USER_A, ENDPOINT), 'CONFLICT');

    expect(error.message).toContain('もう一度有効にしてください');
    expect((await subscriptions.listByUser(USER_A))[0]?.isActive).toBe(false);
    expect(await service.status(USER_A, ENDPOINT)).toMatchObject({ isInvalidated: true });
  });

  it('配信に失敗したら SERVICE_UNAVAILABLE（内部の情報を含まない）。失敗でも、1 分の制限に数える（配信サービスへ連打しない）', async () => {
    const { service, tested } = setup({ behavior: 'FAIL' });
    await service.subscribe(USER_A, ENDPOINT, KEYS);

    const error = await expectAppError(service.sendTest(USER_A, ENDPOINT), 'SERVICE_UNAVAILABLE');

    expect(error.message).toContain('テスト通知を送れませんでした');
    expect(error.message).not.toContain('接続できません');
    await expectAppError(service.sendTest(USER_A, ENDPOINT), 'RATE_LIMITED');
    expect(tested).toHaveLength(1);
  });

  it('応答がなければ（タイムアウト）、SERVICE_UNAVAILABLE', async () => {
    const { service } = setup({ behavior: 'TIMEOUT', ioTimeoutMs: 20 });
    await service.subscribe(USER_A, ENDPOINT, KEYS);

    await expectAppError(service.sendTest(USER_A, ENDPOINT), 'SERVICE_UNAVAILABLE');
  });
});
