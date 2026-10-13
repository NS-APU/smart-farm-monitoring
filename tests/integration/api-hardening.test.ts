/**
 * API の堅牢化（レビュー V-010・V-013・V-015・V-016・V-024・V-117）の結合テスト。
 */

import { describe, expect, it } from 'vitest';
import { DashboardResponseSchema } from '@smart-farm/shared/schemas/evaluation';
import { createJsonLogger } from '../../src/backend/infrastructure/logging/json-logger.ts';
import { FACILITY_ID, observation, ROBOT_ID } from '../support/builders.ts';
import {
  addUserAndLogin,
  createTestContext,
  errorOf,
  TEST_USER,
  THREE_ROLES_JSON,
  withEquipment,
} from '../support/test-context.ts';

describe('セキュリティヘッダー（V-015）', () => {
  it('API・ヘルスチェックの応答に、CSP・フレーム禁止・参照元なし・HSTS・nosniff を付ける', async () => {
    const context = await createTestContext();

    for (const response of [
      await context.app.request('/health'),
      await context.request('/equipment'),
      await context.app.request('/api/v1/equipment'),
    ]) {
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('strict-transport-security')).toContain('max-age=');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });
});

describe('Web Push の購読の宛先（V-016）', () => {
  const env = { WEB_PUSH_PUBLIC_KEY: 'dummy-web-push-public-key' };

  it.each([
    ['http（https 以外）', 'http://push.example.invalid/a'],
    ['file スキーム', 'file:///etc/passwd'],
    ['localhost', 'https://localhost/a'],
    ['IPv4 アドレスの直接指定', 'https://169.254.169.254/latest'],
    ['IPv6 アドレスの直接指定', 'https://[::1]/a'],
    ['ドットのない内部の名前', 'https://internal/a'],
    ['URL でない', 'not a url'],
  ])('%s の宛先は、400 で拒否する', async (_name, endpoint) => {
    const context = await createTestContext({ env });

    const response = await context.request('/push-subscription', {
      method: 'PUT',
      body: { endpoint },
    });

    expect(response.status).toBe(400);
  });

  it('https のドメイン名の宛先は受け付ける。状態の問い合わせ・解除の endpoint も、同じ検証をする', async () => {
    const context = await createTestContext({ env });

    const ok = await context.request('/push-subscription', {
      method: 'PUT',
      body: { endpoint: 'https://fcm.example.invalid/send/abc' },
    });
    const badStatus = await context.request('/push-subscription?endpoint=http://169.254.169.254/');
    const badDelete = await context.request('/push-subscription', {
      method: 'DELETE',
      body: { endpoint: 'file:///x' },
    });

    expect(ok.status).toBe(204);
    expect(badStatus.status).toBe(400);
    expect(badDelete.status).toBe(400);
  });
});

describe('対象の種類の検証（V-117）', () => {
  it('変更履歴の対象の種類は、定義にあるものだけ指定できる', async () => {
    const context = await createTestContext();

    expect((await context.request('/audit-logs?targetType=user')).status).toBe(200);
    expect((await context.request('/audit-logs?targetType=unknown-type')).status).toBe(400);
  });
});

describe('ユーザー管理の権限を持つ最後の利用者（V-010）', () => {
  const env = { ROLE_DEFINITIONS_JSON: THREE_ROLES_JSON, INITIAL_USER_ROLE: 'admin' };

  it('ユーザー管理の権限を持つ唯一の利用者を、権限のないロールへ変更することは、409 で拒否する', async () => {
    const context = await createTestContext({ env });

    const response = await context.request(`/users/${TEST_USER.userId}`, {
      method: 'PUT',
      body: { userName: TEST_USER.userName, role: 'viewer' },
    });

    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain('1人もいなくなる');
  });

  it('ほかにユーザー管理の権限を持つ利用者がいれば、変更できる。権限を保つロールへの変更は、常にできる', async () => {
    const context = await createTestContext({ env });
    await addUserAndLogin(context, { userId: 'second-admin', role: 'admin' });

    const keep = await context.request(`/users/${TEST_USER.userId}`, {
      method: 'PUT',
      body: { userName: TEST_USER.userName, role: 'admin' },
    });
    const demote = await context.request(`/users/${TEST_USER.userId}`, {
      method: 'PUT',
      body: { userName: TEST_USER.userName, role: 'viewer' },
    });

    expect(keep.status).toBe(200);
    expect(demote.status).toBe(200);
  });
});

describe('認証の事象のログ（V-013）', () => {
  it('ログインの成功・失敗・制限、ログアウトを、イベント名つきで記録し、パスワード・トークンは記録しない', async () => {
    const entries: Record<string, unknown>[] = [];
    const logger = createJsonLogger({
      sink: { write: (line) => entries.push(JSON.parse(line) as Record<string, unknown>) },
      minimumLevel: 'info',
    });
    const context = await createTestContext({ logger });
    const login = (password: string) =>
      context.app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: TEST_USER.userId, password }),
      });
    entries.length = 0;

    for (let count = 0; count < 5; count += 1) {
      await login('Wrong-Passw0rd-x');
    }
    await login(TEST_USER.password);
    await context.app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'invalid-refresh-token-dummy' }),
    });

    const events = entries.map((entry) => entry.event).filter((event) => event !== undefined);
    expect(events).toEqual(
      expect.arrayContaining(['auth.login.failed', 'auth.login.locked', 'auth.refresh.failed']),
    );
    const failed = entries.find((entry) => entry.event === 'auth.login.failed');
    expect(failed).toMatchObject({ userId: TEST_USER.userId, level: 'warn' });
    const text = JSON.stringify(entries);
    expect(text).not.toContain(TEST_USER.password);
    expect(text).not.toContain('Wrong-Passw0rd-x');
    expect(text).not.toContain('invalid-refresh-token-dummy');
  });

  it('ログインに成功したら auth.login.succeeded、ログアウトしたら auth.logout を、操作者つきで記録する', async () => {
    const entries: Record<string, unknown>[] = [];
    const logger = createJsonLogger({
      sink: { write: (line) => entries.push(JSON.parse(line) as Record<string, unknown>) },
      minimumLevel: 'info',
    });
    const context = await createTestContext({ logger });
    const token = await context.login();

    await context.request('/auth/logout', { method: 'POST', token });

    expect(entries.find((entry) => entry.event === 'auth.login.succeeded')).toMatchObject({
      userId: TEST_USER.userId,
    });
    expect(entries.find((entry) => entry.event === 'auth.logout')).toMatchObject({
      userId: TEST_USER.userId,
    });
  });
});

describe('データの新しさ（V-024）', () => {
  async function freshnessOf(context: Awaited<ReturnType<typeof withEquipment>>) {
    const response = await context.request(`/dashboard?equipmentId=${FACILITY_ID}`);
    return DashboardResponseSchema.parse(await response.json()).dataFreshness;
  }

  it('手動入力だけがある場合は、データを受信していない（NONE）。自動取り込みの観測値があれば、新しさを判定する', async () => {
    const context = await withEquipment();
    const received = context.clock.now().toISOString();
    await context.container.repositories.observations.saveMany([
      observation({
        equipmentId: ROBOT_ID,
        itemKey: 'operatingHours',
        value: 4,
        source: 'MANUAL',
        receivedAt: received,
      }),
    ]);
    expect(await freshnessOf(context)).toBe('NONE');

    await context.container.repositories.observations.saveMany([
      observation({
        equipmentId: ROBOT_ID,
        itemKey: 'harvestCount',
        value: 3,
        source: 'AUTO_IMPORT',
        receivedAt: received,
      }),
    ]);
    expect(await freshnessOf(context)).toBe('FRESH');

    // 自動取り込みが止まったまま時間が経つと、手動入力が新しくても STALE になる
    context.clock.advance(46 * 60_000);
    await context.container.repositories.observations.saveMany([
      observation({
        equipmentId: ROBOT_ID,
        itemKey: 'operatingHours',
        value: 5,
        source: 'MANUAL',
        observedAt: context.clock.now().toISOString(),
        receivedAt: context.clock.now().toISOString(),
      }),
    ]);
    expect(await freshnessOf(context)).toBe('STALE');
  });

  it('削除済みの観測値は、データの新しさに数えない', async () => {
    const context = await withEquipment();
    await context.container.repositories.observations.saveMany([
      observation({
        equipmentId: ROBOT_ID,
        itemKey: 'harvestCount',
        value: 3,
        source: 'AUTO_IMPORT',
        isDeleted: true,
      }),
    ]);

    expect(await freshnessOf(context)).toBe('NONE');
    expect(
      await context.container.repositories.observations.latestReceivedAt([ROBOT_ID], {
        autoImportOnly: true,
      }),
    ).toBeNull();
  });
});
