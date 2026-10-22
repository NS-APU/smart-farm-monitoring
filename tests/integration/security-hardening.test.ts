/**
 * セキュリティの強化（レビュー V-001・V-004〜V-009）の結合テスト。
 * 開発用 API の既定無効、ユーザー削除・パスワード再設定時のセッションと Web Push 購読の失効、
 * 接続元の識別（信頼するプロキシの設定）、入力の長さの上限。
 */

import { describe, expect, it } from 'vitest';
import { LoginResponseSchema } from '@smart-farm/shared/schemas/auth';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { LOGIN_FAILURE_LIMIT } from '../../src/backend/infrastructure/local/local-auth.ts';
import { createTestContext, TEST_USER, type TestContext } from '../support/test-context.ts';

const NEW_USER = {
  userId: 'worker-2',
  userName: '作業者2',
  password: 'Dummy-Passw0rd-new',
  role: 'worker',
};
const JSON_HEADERS = { 'content-type': 'application/json' };

function login(
  context: TestContext,
  userId: string,
  password: string,
  headers: Readonly<Record<string, string>> = {},
) {
  return context.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify({ userId, password }),
  });
}

async function loginSession(context: TestContext, userId: string, password: string) {
  return LoginResponseSchema.parse(await (await login(context, userId, password)).json());
}

async function createWorker(context: TestContext) {
  await context.request('/users', { method: 'POST', body: NEW_USER });
  return loginSession(context, NEW_USER.userId, NEW_USER.password);
}

describe('開発用 API の有効化（V-001・V-143）', () => {
  it('環境変数で明示しなければ、開発用 API を登録しない（ログイン済みでも 404）', async () => {
    const context = await createTestContext({ env: { DEV_API_ENABLED: 'false' } });

    const response = await context.request('/dev/clock');

    expect(response.status).toBe(404);
    expect(context.container.dev).toBeUndefined();
  });

  it('DEV_API_ENABLED=true と明示すると、ローカル・テストでは有効になる', async () => {
    const context = await createTestContext({ env: { DEV_API_ENABLED: 'true' } });

    expect((await context.request('/dev/clock')).status).toBe(200);
  });
});

describe('ユーザー削除・パスワード再設定とセッション（V-004・V-005・V-006）', () => {
  it('ユーザーを削除すると、そのユーザーの Web Push の購読も削除する', async () => {
    const context = await createTestContext({ env: { WEB_PUSH_PUBLIC_KEY: 'dummy-public-key' } });
    const session = await createWorker(context);
    await context.request('/push-subscription', {
      method: 'PUT',
      token: session.accessToken,
      body: { endpoint: 'https://push.example.invalid/worker-2' },
    });
    const subscriptions = context.container.repositories.pushSubscriptions;
    expect(await subscriptions.listByUser(toUserId(NEW_USER.userId))).toHaveLength(1);

    const deleted = await context.request(`/users/${NEW_USER.userId}`, { method: 'DELETE' });

    expect(deleted.status).toBe(204);
    expect(await subscriptions.listByUser(toUserId(NEW_USER.userId))).toEqual([]);
    expect(await subscriptions.listActive()).toEqual([]);
  });

  it('削除したユーザーと同じIDで再登録しても、削除前のアクセス・リフレッシュトークンは使えない', async () => {
    const context = await createTestContext();
    const before = await createWorker(context);
    await context.request(`/users/${NEW_USER.userId}`, { method: 'DELETE' });

    await context.request('/users', { method: 'POST', body: NEW_USER });

    const withOldAccess = await context.request('/equipment', { token: before.accessToken });
    const withOldRefresh = await context.app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ refreshToken: before.refreshToken }),
    });
    expect(withOldAccess.status).toBe(401);
    expect(withOldRefresh.status).toBe(401);
    expect((await login(context, NEW_USER.userId, NEW_USER.password)).status).toBe(200);
  });

  it('パスワードを再設定すると、発行済みのアクセス・リフレッシュトークンを失効する', async () => {
    const context = await createTestContext();
    const before = await createWorker(context);

    const reset = await context.request(`/users/${NEW_USER.userId}`, {
      method: 'PUT',
      body: { userName: NEW_USER.userName, role: 'worker', password: 'Dummy-Passw0rd-reset' },
    });

    expect(reset.status).toBe(200);
    expect((await context.request('/equipment', { token: before.accessToken })).status).toBe(401);
    const refresh = await context.app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ refreshToken: before.refreshToken }),
    });
    expect(refresh.status).toBe(401);
    expect((await login(context, NEW_USER.userId, NEW_USER.password)).status).toBe(401);
    expect((await login(context, NEW_USER.userId, 'Dummy-Passw0rd-reset')).status).toBe(200);
  });

  it('パスワードを変えない更新（名称・ロール）では、セッションを失効しない', async () => {
    const context = await createTestContext();
    const before = await createWorker(context);

    await context.request(`/users/${NEW_USER.userId}`, {
      method: 'PUT',
      body: { userName: '改名', role: 'worker' },
    });

    expect((await context.request('/equipment', { token: before.accessToken })).status).toBe(200);
  });

  it('自分のパスワードを再設定した場合、操作に使った現在のセッションだけを残し、ほかのセッションは失効する', async () => {
    const context = await createTestContext();
    const current = await loginSession(context, TEST_USER.userId, TEST_USER.password);
    const other = await loginSession(context, TEST_USER.userId, TEST_USER.password);

    const reset = await context.request(`/users/${TEST_USER.userId}`, {
      method: 'PUT',
      token: current.accessToken,
      body: { userName: TEST_USER.userName, role: 'worker', password: 'Dummy-Passw0rd-self' },
    });

    expect(reset.status).toBe(200);
    expect((await context.request('/equipment', { token: current.accessToken })).status).toBe(200);
    expect((await context.request('/equipment', { token: other.accessToken })).status).toBe(401);
  });
});

describe('接続元の識別（V-007・V-008。ログインの試行回数の制限）', () => {
  async function failLogins(
    context: TestContext,
    userId: string,
    headersOf: (index: number) => Readonly<Record<string, string>>,
  ) {
    for (let index = 0; index < LOGIN_FAILURE_LIMIT; index += 1) {
      expect((await login(context, userId, 'Wrong-Passw0rd-x', headersOf(index))).status).toBe(401);
    }
  }

  it('既定（信頼するプロキシなし）では、X-Forwarded-For を信頼せず、値を変えても制限を回避できない', async () => {
    const context = await createTestContext();

    await failLogins(context, TEST_USER.userId, (index) => ({
      'x-forwarded-for': `198.51.100.${String(index + 1)}`,
    }));

    const blocked = await login(context, TEST_USER.userId, TEST_USER.password, {
      'x-forwarded-for': '198.51.100.200',
    });
    expect(blocked.status).toBe(429);
  });

  it('信頼するプロキシが1段のとき、末尾（プロキシが付けた値）を接続元にし、先頭の偽装では回避できない', async () => {
    const context = await createTestContext({ env: { TRUSTED_PROXY_HOPS: '1' } });

    await failLogins(context, TEST_USER.userId, (index) => ({
      'x-forwarded-for': `203.0.113.${String(index + 1)}, 192.0.2.10`,
    }));

    const spoofed = await login(context, TEST_USER.userId, TEST_USER.password, {
      'x-forwarded-for': '203.0.113.99, 192.0.2.10',
    });
    const otherClient = await login(context, TEST_USER.userId, TEST_USER.password, {
      'x-forwarded-for': '203.0.113.1, 192.0.2.11',
    });
    expect(spoofed.status).toBe(429);
    expect(otherClient.status).toBe(200);
  });

  it('信頼するプロキシの段数より、ヘッダーの値が少ない場合は、ヘッダーを使わない', async () => {
    const context = await createTestContext({ env: { TRUSTED_PROXY_HOPS: '2' } });

    await failLogins(context, TEST_USER.userId, (index) => ({
      'x-forwarded-for': `198.51.100.${String(index + 1)}`,
    }));

    const blocked = await login(context, TEST_USER.userId, TEST_USER.password, {
      'x-forwarded-for': '198.51.100.250',
    });
    expect(blocked.status).toBe(429);
  });

  it('接続元のヘッダー（CLIENT_IP_HEADER）を指定したとき、そのヘッダーの IP を接続元にする。X-Forwarded-For が変わっても、回避できない（Issue #100）', async () => {
    const context = await createTestContext({
      env: { CLIENT_IP_HEADER: 'x-sfm-viewer-ip', TRUSTED_PROXY_HOPS: '1' },
    });

    await failLogins(context, TEST_USER.userId, (index) => ({
      'x-sfm-viewer-ip': '203.0.113.10',
      'x-forwarded-for': `198.51.100.${String(index + 1)}`,
    }));

    const blocked = await login(context, TEST_USER.userId, TEST_USER.password, {
      'x-sfm-viewer-ip': '203.0.113.10',
      'x-forwarded-for': '198.51.100.200',
    });
    const otherClient = await login(context, TEST_USER.userId, TEST_USER.password, {
      'x-sfm-viewer-ip': '2001:db8::11',
      'x-forwarded-for': '198.51.100.1',
    });
    expect(blocked.status).toBe(429);
    expect(otherClient.status).toBe(200);
  });

  it('接続元のヘッダーの値が IP でないときは、使わず、ユーザーID単位に切り替える（偽の値で、回避できない）', async () => {
    const context = await createTestContext({ env: { CLIENT_IP_HEADER: 'x-sfm-viewer-ip' } });

    await failLogins(context, TEST_USER.userId, (index) => ({
      'x-sfm-viewer-ip': `not-an-ip-${String(index)}`,
    }));

    const blocked = await login(context, TEST_USER.userId, TEST_USER.password, {
      'x-sfm-viewer-ip': 'not-an-ip-other',
    });
    expect(blocked.status).toBe(429);
  });

  it('接続元を取得できない環境では、ユーザーID単位で数え、1人の失敗がほかの利用者のログインを止めない', async () => {
    const context = await createTestContext();
    await context.request('/users', { method: 'POST', body: NEW_USER });

    await failLogins(context, NEW_USER.userId, () => ({}));

    const lockedUser = await login(context, NEW_USER.userId, NEW_USER.password);
    const otherUser = await login(context, TEST_USER.userId, TEST_USER.password);
    expect(lockedUser.status).toBe(429);
    expect(otherUser.status).toBe(200);
  });
});

describe('入力の長さの上限（V-009）', () => {
  it('パスワード・リフレッシュトークン・ユーザーIDが長すぎる場合は、検証せずに 400 にする', async () => {
    const context = await createTestContext();

    const longPassword = await login(context, TEST_USER.userId, 'A'.repeat(129));
    const longUserId = await login(context, 'a'.repeat(101), TEST_USER.password);
    const longRefresh = await context.app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ refreshToken: 'x'.repeat(4097) }),
    });

    expect(longPassword.status).toBe(400);
    expect(longUserId.status).toBe(400);
    expect(longRefresh.status).toBe(400);
  });

  it('リフレッシュトークンは、4096 文字まで、検証に進む（Cognito のトークンは、1,000 文字を超える。Issue #95）', async () => {
    const context = await createTestContext();
    const refresh = (refreshToken: string) =>
      context.app.request('/api/v1/auth/refresh', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ refreshToken }),
      });

    const atLimit = await refresh('x'.repeat(4096));
    const overLimit = await refresh('x'.repeat(4097));

    // 上限の内側は、入力の検証を通り、無効なトークンとして拒否される（401）。外側は、検証せずに拒否される（400）
    expect(atLimit.status).toBe(401);
    expect(overLimit.status).toBe(400);
  });

  it('ユーザー登録・再設定のパスワードにも上限がある', async () => {
    const context = await createTestContext();

    const created = await context.request('/users', {
      method: 'POST',
      body: { ...NEW_USER, password: `Aa1${'x'.repeat(130)}` },
    });

    expect(created.status).toBe(400);
  });
});
