/**
 * Web Push の送信（ライブラリ web-push の呼び出し。Issue #241）の単体テスト。
 * ライブラリを偽物に差し替え、渡す宛先・本文・オプション（有効期限・緊急度・待ち時間・VAPID）と、
 * 結果の変換（2xx 以外のエラーは、状態コードとして返す。それ以外の例外は、そのまま投げる）を確かめる。
 */

import { createECDH, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type WebPushLibraryModule from 'web-push';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLibrarySender,
  WEB_PUSH_REQUEST_TIMEOUT_MS,
} from '../../../../src/backend/infrastructure/web-push/library-sender.ts';
import type { WebPushRequest } from '../../../../src/backend/infrastructure/web-push/web-push-notifier.ts';

class FakeWebPushError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number) {
    super('fake web push error');
    this.statusCode = statusCode;
  }
}
const library = { sendNotification: vi.fn(), WebPushError: FakeWebPushError };
const send = createLibrarySender(library);
/** 実物のライブラリ（バックエンドのパッケージの依存。テストの場所からは解決できないため、バックエンドの場所から読む）。 */
const webPush = createRequire(new URL('../../../../src/backend/package.json', import.meta.url))(
  'web-push',
) as typeof WebPushLibraryModule;

const REQUEST: WebPushRequest = {
  endpoint: 'https://push.example.test/send/dummy-endpoint-token',
  keys: { p256dh: 'dummy-p256dh-key', auth: 'dummy-auth-secret' },
  payload: '{"title":"異常検知"}',
  ttlSeconds: 600,
  urgency: 'high',
  vapid: {
    subject: 'https://monitoring.example.test/',
    publicKey: 'dummy-public-key',
    privateKey: 'dummy-private-key',
  },
};

beforeEach(() => {
  library.sendNotification.mockReset();
});

describe('Web Push の送信（ライブラリの呼び出し）', () => {
  it('購読・本文・オプション（有効期限・緊急度・待ち時間・VAPID）を渡し、状態コードを返す', async () => {
    library.sendNotification.mockResolvedValue({ statusCode: 201 });

    const result = await send(REQUEST);

    expect(result).toEqual({ statusCode: 201 });
    expect(library.sendNotification).toHaveBeenCalledWith(
      { endpoint: REQUEST.endpoint, keys: REQUEST.keys },
      REQUEST.payload,
      {
        TTL: 600,
        urgency: 'high',
        timeout: WEB_PUSH_REQUEST_TIMEOUT_MS,
        vapidDetails: REQUEST.vapid,
      },
    );
  });

  it('鍵・本文がない（以前の購読）ときは、宛先だけの購読と、本文なし（null）を渡す', async () => {
    library.sendNotification.mockResolvedValue({ statusCode: 201 });
    const { keys, ...withoutKeys } = REQUEST;
    expect(keys).toBeDefined();

    await send({ ...withoutKeys, payload: null });

    expect(library.sendNotification).toHaveBeenCalledWith(
      { endpoint: REQUEST.endpoint },
      null,
      expect.objectContaining({ TTL: 600 }),
    );
  });

  it('プッシュサービスが 2xx 以外を返した（ライブラリが WebPushError を投げた）ときは、例外にせず、状態コードを返す', async () => {
    library.sendNotification.mockRejectedValue(new FakeWebPushError(410));

    expect(await send(REQUEST)).toEqual({ statusCode: 410 });
  });

  it('接続できない・設定の誤り（WebPushError 以外の例外）は、そのまま投げる', async () => {
    const failure = new Error('connect ECONNREFUSED');
    library.sendNotification.mockRejectedValue(failure);

    await expect(send(REQUEST)).rejects.toBe(failure);
  });
});

describe('ライブラリ（実物）に渡す値の形式', () => {
  it('実在の形式の VAPID 鍵・購読の鍵で、本文を暗号化し、VAPID の署名・有効期限・緊急度つきのリクエストを組み立てられる（送信はしない）', () => {
    const vapid = webPush.generateVAPIDKeys();
    const receiver = createECDH('prime256v1');
    receiver.generateKeys();
    const keys = {
      p256dh: receiver.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    };

    const details = webPush.generateRequestDetails(
      { endpoint: REQUEST.endpoint, keys },
      REQUEST.payload,
      {
        TTL: REQUEST.ttlSeconds,
        urgency: REQUEST.urgency,
        timeout: WEB_PUSH_REQUEST_TIMEOUT_MS,
        vapidDetails: { subject: REQUEST.vapid.subject, ...vapid },
      },
    );

    expect(details.method).toBe('POST');
    expect(details.headers.TTL).toBe(600);
    expect(details.headers.Urgency).toBe('high');
    expect(details.headers['Content-Encoding']).toBe('aes128gcm');
    expect(String(details.headers.Authorization)).toMatch(/^vapid t=.+, k=.+$/);
    // 本文は、暗号化される（平文を含まない）
    expect(Buffer.from(details.body ?? []).includes(Buffer.from('異常検知'))).toBe(false);
  });
});
