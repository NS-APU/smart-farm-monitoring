/**
 * Web Push の実配信（Issue #241。ADR-0019 の D-36・D-38）の結合テスト。
 * 設定（WEB_PUSH_DELIVERY=vapid）で、ダミーの代わりに、実配信のアダプタを組み立てる。プッシュサービスへの送信は、偽物に差し替える。
 * 通知を作って配信すると、購読ごとに送られ、結果（配信できた・購読が無効・失敗）が、配信の状態に反映されることを確かめる。
 * あわせて、購読の登録が、暗号鍵（keys）を保存すること、ログに秘密情報が出ないことを確かめる。
 */

import { describe, expect, it } from 'vitest';
import { PushStatusResponseSchema } from '@smart-farm/shared/schemas/notification';
import { toUserId } from '@smart-farm/shared/schemas/common';
import type { Logger } from '../../src/backend/application/ports/logger-port.ts';
import {
  VAPID_PRIVATE_KEY_REFERENCE,
  type WebPushRequest,
  type WebPushSender,
} from '../../src/backend/infrastructure/web-push/web-push-notifier.ts';
import { pushSubscriptionId } from '../../src/backend/application/notification/push-subscription-service.ts';
import { createTestContext, TEST_USER, type TestContext } from '../support/test-context.ts';

const DUMMY_PRIVATE_KEY = 'dummy-vapid-private-key-value';
const ENDPOINT = 'https://push.example.test/send/dummy-endpoint-token';
const KEYS = { p256dh: 'dummy_p256dh-key', auth: 'dummy_auth-secret' };
const VAPID_ENV = {
  WEB_PUSH_DELIVERY: 'vapid',
  WEB_PUSH_PUBLIC_KEY: 'dummy-vapid-public-key',
  WEB_PUSH_SUBJECT: 'https://monitoring.example.test/',
};
const USER = toUserId(TEST_USER.userId);

/** 送信の偽物。呼ばれた内容を記録し、状態コード（既定は 201）を返す。 */
function fakeSender(statusCode = 201) {
  const requests: WebPushRequest[] = [];
  const send: WebPushSender = (request) => {
    requests.push(request);
    return Promise.resolve({ statusCode });
  };
  return { requests, send };
}

async function setup(
  options: { statusCode?: number; withPrivateKey?: boolean; logger?: Logger } = {},
): Promise<{ context: TestContext; requests: WebPushRequest[] }> {
  const sender = fakeSender(options.statusCode);
  const context = await createTestContext({
    env: VAPID_ENV,
    webPushSender: sender.send,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  if (options.withPrivateKey !== false) {
    await context.container.secrets.set(VAPID_PRIVATE_KEY_REFERENCE, DUMMY_PRIVATE_KEY);
  }
  return { context, requests: sender.requests };
}

async function subscribe(context: TestContext, endpoint = ENDPOINT): Promise<string> {
  const response = await context.request('/push-subscription', {
    method: 'PUT',
    body: { endpoint, keys: KEYS },
  });
  expect(response.status).toBe(204);
  return pushSubscriptionId(USER, endpoint);
}

function createNotification(context: TestContext) {
  return context.container.notificationService.notifyIngestionFailure({
    sourceId: 'robot',
    sourceName: 'ロボットデータ',
    reason: '接続できません',
  });
}

describe('Web Push の実配信（WEB_PUSH_DELIVERY=vapid）', () => {
  it('通知を作って配信すると、購読の宛先・鍵へ、本文つきで送る。ダミーには、配信しない。VAPID の秘密鍵は、秘密情報から読む', async () => {
    const { context, requests } = await setup();
    await subscribe(context);
    const created = await createNotification(context);

    const summary = await context.container.notificationService.deliverPending();

    expect(summary).toMatchObject({ delivered: 1, failed: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      endpoint: ENDPOINT,
      keys: KEYS,
      urgency: 'high',
      vapid: {
        subject: VAPID_ENV.WEB_PUSH_SUBJECT,
        publicKey: VAPID_ENV.WEB_PUSH_PUBLIC_KEY,
        privateKey: DUMMY_PRIVATE_KEY,
      },
    });
    expect(JSON.parse(requests[0]?.payload ?? 'null')).toMatchObject({
      title: 'データ取得失敗',
      notificationId: created?.notificationId,
    });
    // 通知の作成から 1 時間（D-38）の範囲の、有効期限（秒）
    expect(requests[0]?.ttlSeconds).toBeGreaterThan(0);
    expect(requests[0]?.ttlSeconds).toBeLessThanOrEqual(3600);
    expect(context.container.dev?.mocks.webPush.delivered()).toHaveLength(0);
    const stored = await context.container.repositories.notifications.get(
      created?.notificationId as never,
    );
    expect(stored?.webPushDeliveries?.[0]).toMatchObject({ result: 'SUCCESS', attempts: 1 });
  });

  it('購読ごとに送る（2 つの端末へ、それぞれの宛先で）', async () => {
    const { context, requests } = await setup();
    await subscribe(context);
    await subscribe(context, 'https://push.example.test/send/second-endpoint-token');
    await createNotification(context);

    const summary = await context.container.notificationService.deliverPending();

    expect(summary.delivered).toBe(2);
    expect(requests.map((request) => request.endpoint).sort()).toEqual([
      ENDPOINT,
      'https://push.example.test/send/second-endpoint-token',
    ]);
  });

  it('プッシュサービスが 410 を返した購読は、無効にする（以降の配信先から除く）', async () => {
    const { context, requests } = await setup({ statusCode: 410 });
    const subscriptionId = await subscribe(context);
    await createNotification(context);

    await context.container.notificationService.deliverPending();

    expect(requests).toHaveLength(1);
    const active = await context.container.repositories.pushSubscriptions.listActive();
    expect(active.map((item) => item.subscriptionId)).not.toContain(subscriptionId);
  });

  it('プッシュサービスが 503 を返したら、失敗として記録し、再送の対象にする（次の試行の日時を持つ）', async () => {
    const { context } = await setup({ statusCode: 503 });
    await subscribe(context);
    const created = await createNotification(context);

    const summary = await context.container.notificationService.deliverPending();

    expect(summary).toMatchObject({ delivered: 0, failed: 1 });
    const stored = await context.container.repositories.notifications.get(
      created?.notificationId as never,
    );
    expect(stored?.webPushDeliveries?.[0]).toMatchObject({
      result: 'FAILURE',
      attempts: 1,
      errorMessage: expect.stringContaining('HTTP 503'),
    });
    expect(stored?.webPushDeliveries?.[0]?.nextAttemptAt).toBeDefined();
  });

  it('秘密鍵が未設定なら、送らずに、失敗として記録する（設定後の再送で届く）。記録に、設定の場所を示す', async () => {
    const { context, requests } = await setup({ withPrivateKey: false });
    await subscribe(context);
    const created = await createNotification(context);

    const summary = await context.container.notificationService.deliverPending();

    expect(summary).toMatchObject({ delivered: 0, failed: 1 });
    expect(requests).toHaveLength(0);
    const stored = await context.container.repositories.notifications.get(
      created?.notificationId as never,
    );
    expect(stored?.webPushDeliveries?.[0]?.errorMessage).toContain('秘密鍵が設定されていません');
  });

  it('失敗の理由（プッシュサービスの HTTP の状態コード・設定の不足）を、ログに残す（運用で、原因を切り分けるため。秘密情報は含まない）', async () => {
    const lines: string[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message, fields) => lines.push(JSON.stringify({ message, fields })),
      error: () => undefined,
      child: () => logger,
    };
    const { context } = await setup({ statusCode: 403, logger });
    await subscribe(context);
    await createNotification(context);

    await context.container.notificationService.deliverPending();

    const text = lines.join(String.fromCharCode(10));
    expect(text).toContain('Web Push の配信に失敗しました');
    expect(text).toContain('HTTP 403');
    expect(text).not.toContain(DUMMY_PRIVATE_KEY);
  });

  it('ログに、秘密鍵・購読の鍵・宛先を出さない', async () => {
    const lines: string[] = [];
    const logger: Logger = {
      debug: (message, fields) => lines.push(JSON.stringify({ message, fields })),
      info: (message, fields) => lines.push(JSON.stringify({ message, fields })),
      warn: (message, fields) => lines.push(JSON.stringify({ message, fields })),
      error: (message, fields) => lines.push(JSON.stringify({ message, fields })),
      child: () => logger,
    };
    const { context } = await setup({ statusCode: 503, logger });
    await subscribe(context);
    await createNotification(context);

    await context.container.notificationService.deliverPending();

    const text = lines.join('\n');
    expect(text).not.toContain(DUMMY_PRIVATE_KEY);
    expect(text).not.toContain(KEYS.auth);
    expect(text).not.toContain('dummy-endpoint-token');
  });
});

describe('購読の登録: 暗号鍵（keys）の保存', () => {
  it('PUT /push-subscription は、鍵（p256dh・auth）を購読の記録に保存する。鍵は、状態の応答に出さない', async () => {
    const { context } = await setup();

    await subscribe(context);

    const [record] = await context.container.repositories.pushSubscriptions.listByUser(USER);
    expect(record?.keys).toEqual(KEYS);
    const status = await context.request(
      `/push-subscription?endpoint=${encodeURIComponent(ENDPOINT)}`,
    );
    const body: unknown = await status.json();
    expect(PushStatusResponseSchema.parse(body).isSubscribed).toBe(true);
    expect(JSON.stringify(body)).not.toContain(KEYS.auth);
  });

  it('鍵なしの登録も受け付ける（以前の画面からの登録）。その購読は、本文なしで送る', async () => {
    const { context, requests } = await setup();
    const response = await context.request('/push-subscription', {
      method: 'PUT',
      body: { endpoint: ENDPOINT },
    });
    expect(response.status).toBe(204);
    await createNotification(context);

    await context.container.notificationService.deliverPending();

    const [record] = await context.container.repositories.pushSubscriptions.listByUser(USER);
    expect(record?.keys).toBeUndefined();
    expect(requests[0]?.payload).toBeNull();
  });

  it.each([
    ['p256dh が空', { p256dh: '', auth: KEYS.auth }],
    ['auth が空', { p256dh: KEYS.p256dh, auth: '' }],
    ['p256dh が base64url でない', { p256dh: 'not base64url!', auth: KEYS.auth }],
    ['auth が長すぎる', { p256dh: KEYS.p256dh, auth: 'a'.repeat(65) }],
    ['auth がない', { p256dh: KEYS.p256dh }],
  ])('不正な鍵（%s）は、400。保存しない', async (_name, keys) => {
    const { context } = await setup();

    const response = await context.request('/push-subscription', {
      method: 'PUT',
      body: { endpoint: ENDPOINT, keys },
    });

    expect(response.status).toBe(400);
    expect(await context.container.repositories.pushSubscriptions.listByUser(USER)).toEqual([]);
  });

  it('同じ端末の再登録は、鍵を上書きする（購読の鍵が変わった場合）', async () => {
    const { context } = await setup();
    await subscribe(context);

    await context.request('/push-subscription', {
      method: 'PUT',
      body: { endpoint: ENDPOINT, keys: { p256dh: 'new_p256dh-key', auth: 'new_auth-secret' } },
    });

    const records = await context.container.repositories.pushSubscriptions.listByUser(USER);
    expect(records).toHaveLength(1);
    expect(records[0]?.keys).toEqual({ p256dh: 'new_p256dh-key', auth: 'new_auth-secret' });
  });
});

describe('既定（WEB_PUSH_DELIVERY=dummy）', () => {
  it('ダミーに配信する（実際には送らない）。送信の関数は、使われない', async () => {
    const sender = fakeSender();
    const context = await createTestContext({
      env: { WEB_PUSH_PUBLIC_KEY: 'dummy-vapid-public-key' },
      webPushSender: sender.send,
    });
    await subscribe(context);
    await createNotification(context);

    const summary = await context.container.notificationService.deliverPending();

    expect(summary.delivered).toBe(1);
    expect(context.container.dev?.mocks.webPush.delivered()).toHaveLength(1);
    expect(sender.requests).toHaveLength(0);
  });
});
