/**
 * Web Push の実配信（NotifierPort の実装。Issue #241。ADR-0019 の D-36・D-38）の単体テスト。
 * 実際のプッシュサービスには送らず、送信の関数の偽物で、送る内容（宛先・本文・有効期限・VAPID）と、結果の扱い
 * （購読が無効・一時的な失敗・秘密鍵の未設定）、秘密情報・宛先がエラーメッセージに出ないことを確かめる。
 */

import { describe, expect, it } from 'vitest';
import type { Notification } from '@smart-farm/shared/schemas/notification';
import { NotificationDeliveryError } from '../../../../src/backend/application/ports/notifier-port.ts';
import type { PushSubscriptionRecord } from '../../../../src/backend/application/ports/records.ts';
import { createMemorySecretPort } from '../../../../src/backend/infrastructure/local/env-secret.ts';
import {
  createWebPushNotifier,
  VAPID_PRIVATE_KEY_REFERENCE,
  type WebPushRequest,
} from '../../../../src/backend/infrastructure/web-push/web-push-notifier.ts';

const DUMMY_PRIVATE_KEY = 'dummy-vapid-private-key';
const PUBLIC_KEY = 'dummy-vapid-public-key';
const SUBJECT = 'https://monitoring.example.test/';
const ENDPOINT = 'https://push.example.test/send/dummy-endpoint-token';
const KEYS = { p256dh: 'dummy-p256dh-key', auth: 'dummy-auth-secret' };

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    notificationId: 'n-1' as Notification['notificationId'],
    kind: 'STATUS_CHANGE',
    viewpointId: 'safety',
    status: 'ERROR',
    message: '【異常】安全性（ハウス1）: 転倒を検知しました',
    createdAt: '2026-11-09T01:00:00.000Z',
    dedupKey: 'key-1',
    deliveries: [],
    ...overrides,
  };
}

function subscription(overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    subscriptionId: 'sub-1',
    userId: 'worker-a' as PushSubscriptionRecord['userId'],
    endpoint: ENDPOINT,
    keys: KEYS,
    isActive: true,
    createdAt: '2026-11-09T00:00:00.000Z',
    ...overrides,
  };
}

/** 送信の関数の偽物。結果（HTTP の状態コード）か、例外を返す。呼ばれた内容を記録する。 */
function setup(
  options: {
    respond?: (request: WebPushRequest) => Promise<{ statusCode: number }>;
    secrets?: Record<string, string>;
  } = {},
) {
  const requests: WebPushRequest[] = [];
  const notifier = createWebPushNotifier({
    secrets: createMemorySecretPort(
      options.secrets ?? { [VAPID_PRIVATE_KEY_REFERENCE]: DUMMY_PRIVATE_KEY },
    ),
    publicKey: PUBLIC_KEY,
    subject: SUBJECT,
    send(request) {
      requests.push(request);
      return (options.respond ?? (() => Promise.resolve({ statusCode: 201 })))(request);
    },
  });
  return { notifier, requests };
}

const respondWith = (statusCode: number) => () => Promise.resolve({ statusCode });

describe('Web Push の実配信: 送る内容', () => {
  it('購読の宛先・鍵へ、通知の見出し・本文・識別子を送る。VAPID（連絡先・公開鍵・秘密鍵）と、有効期限・緊急度を付ける', async () => {
    const { notifier, requests } = setup();

    const outcome = await notifier.deliver(notification(), subscription(), { ttlSeconds: 1800 });

    expect(outcome).toBe('DELIVERED');
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.endpoint).toBe(ENDPOINT);
    expect(request?.keys).toEqual(KEYS);
    expect(JSON.parse(request?.payload ?? 'null')).toEqual({
      title: '異常検知',
      message: '【異常】安全性（ハウス1）: 転倒を検知しました',
      notificationId: 'n-1',
    });
    expect(request?.ttlSeconds).toBe(1800);
    expect(request?.urgency).toBe('high');
    expect(request?.vapid).toEqual({
      subject: SUBJECT,
      publicKey: PUBLIC_KEY,
      privateKey: DUMMY_PRIVATE_KEY,
    });
  });

  it.each([
    ['STATUS_CHANGE', '異常検知'],
    ['INGESTION_FAILURE', 'データ取得失敗'],
    ['FEDERATION_EXPIRED', '連携の期限切れ'],
  ] as const)('見出しは、通知の種別（%s）の表示名（%s）', async (kind, title) => {
    const { notifier, requests } = setup();

    await notifier.deliver(notification({ kind }), subscription(), { ttlSeconds: 60 });

    expect(JSON.parse(requests[0]?.payload ?? 'null')).toMatchObject({ title });
  });

  it('鍵を持たない購読（鍵の保存より前に登録した購読）には、本文なしで送る（端末は、既定の文言で表示する）', async () => {
    const { notifier, requests } = setup();

    const { keys, ...withoutKeys } = subscription();
    expect(keys).toBeDefined();
    const outcome = await notifier.deliver(notification(), withoutKeys, { ttlSeconds: 60 });

    expect(outcome).toBe('DELIVERED');
    expect(requests[0]?.payload).toBeNull();
    expect(requests[0]?.keys).toBeUndefined();
  });

  it('長いメッセージは、本文の上限に収まるよう、切り詰める（送信の上限を超えない）', async () => {
    const { notifier, requests } = setup();

    await notifier.deliver(notification({ message: 'あ'.repeat(1000) }), subscription(), {
      ttlSeconds: 60,
    });

    const payload = JSON.parse(requests[0]?.payload ?? 'null') as { message: string };
    expect(payload.message.length).toBeLessThanOrEqual(300);
    expect(payload.message.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(requests[0]?.payload ?? '', 'utf8')).toBeLessThan(2000);
  });

  it('有効期限（秒）は、そのまま渡す。負の値は 0 にする（すでに期限切れ）', async () => {
    const { notifier, requests } = setup();

    await notifier.deliver(notification(), subscription(), { ttlSeconds: -5 });

    expect(requests[0]?.ttlSeconds).toBe(0);
  });
});

describe('Web Push の実配信: 結果の扱い', () => {
  it.each([200, 201, 202])('HTTP %i は、配信できた', async (statusCode) => {
    const { notifier } = setup({ respond: respondWith(statusCode) });

    expect(await notifier.deliver(notification(), subscription(), { ttlSeconds: 60 })).toBe(
      'DELIVERED',
    );
  });

  it.each([404, 410])(
    'HTTP %i（購読の解除・期限切れ）は、購読が無効（SUBSCRIPTION_GONE）',
    async (statusCode) => {
      const { notifier } = setup({ respond: respondWith(statusCode) });

      expect(await notifier.deliver(notification(), subscription(), { ttlSeconds: 60 })).toBe(
        'SUBSCRIPTION_GONE',
      );
    },
  );

  it.each([429, 500, 502, 503])('HTTP %i は、一時的な失敗（再送の対象）', async (statusCode) => {
    const { notifier } = setup({ respond: respondWith(statusCode) });

    const failure = notifier.deliver(notification(), subscription(), { ttlSeconds: 60 });

    await expect(failure).rejects.toBeInstanceOf(NotificationDeliveryError);
    await expect(failure).rejects.toThrow(`HTTP ${String(statusCode)}`);
  });

  it.each([400, 401, 403, 413])(
    'HTTP %i（鍵・連絡先・本文の問題）も、失敗として扱う。メッセージに、設定の確認を促す',
    async (statusCode) => {
      const { notifier } = setup({ respond: respondWith(statusCode) });

      const failure = notifier.deliver(notification(), subscription(), { ttlSeconds: 60 });

      await expect(failure).rejects.toBeInstanceOf(NotificationDeliveryError);
      await expect(failure).rejects.toThrow(`HTTP ${String(statusCode)}`);
    },
  );

  it('接続できない・タイムアウトなどの例外は、一時的な失敗。メッセージに、例外の内容・宛先を含めない', async () => {
    const { notifier } = setup({
      respond: () => Promise.reject(new Error(`connect ECONNREFUSED ${ENDPOINT}`)),
    });

    const failure = notifier.deliver(notification(), subscription(), { ttlSeconds: 60 });

    await expect(failure).rejects.toBeInstanceOf(NotificationDeliveryError);
    await expect(failure).rejects.toThrow('接続できません');
    await failure.catch((error: unknown) => {
      expect(String(error)).not.toContain('push.example.test');
      expect(String(error)).not.toContain('ECONNREFUSED');
    });
  });
});

describe('Web Push の実配信: 秘密鍵', () => {
  it('秘密鍵が未設定なら、送らずに、一時的な失敗にする（設定後の再送で、届く）。メッセージに、設定の場所を示す', async () => {
    const { notifier, requests } = setup({ secrets: {} });

    const failure = notifier.deliver(notification(), subscription(), { ttlSeconds: 60 });

    await expect(failure).rejects.toBeInstanceOf(NotificationDeliveryError);
    await expect(failure).rejects.toThrow('秘密鍵が設定されていません');
    expect(requests).toHaveLength(0);
  });

  it('秘密鍵の読み取りに失敗したら、一時的な失敗にする。メッセージに、読み取りの例外の内容を含めない', async () => {
    const requests: WebPushRequest[] = [];
    const notifier = createWebPushNotifier({
      secrets: {
        get: () => Promise.reject(new Error('AccessDenied: arn:aws:ssm:dummy-parameter')),
        set: () => Promise.resolve(),
        status: () => Promise.resolve({ configured: false }),
      },
      publicKey: PUBLIC_KEY,
      subject: SUBJECT,
      send(request) {
        requests.push(request);
        return Promise.resolve({ statusCode: 201 });
      },
    });

    const failure = notifier.deliver(notification(), subscription(), { ttlSeconds: 60 });

    await expect(failure).rejects.toBeInstanceOf(NotificationDeliveryError);
    await failure.catch((error: unknown) => {
      expect(String(error)).not.toContain('AccessDenied');
      expect(String(error)).not.toContain('arn:aws');
    });
    expect(requests).toHaveLength(0);
  });

  it('エラーのメッセージに、秘密鍵・購読の鍵を含めない', async () => {
    const { notifier } = setup({ respond: respondWith(503) });

    const failure = notifier.deliver(notification(), subscription(), { ttlSeconds: 60 });

    await failure.catch((error: unknown) => {
      const text = String(error);
      expect(text).not.toContain(DUMMY_PRIVATE_KEY);
      expect(text).not.toContain(KEYS.auth);
      expect(text).not.toContain(ENDPOINT);
    });
  });
});
