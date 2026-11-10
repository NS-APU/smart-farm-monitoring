/**
 * ロール（管理者・一般）ごとの認可と、本人によるユーザー名の編集の結合テスト（Issue #115。ADR-0013。FR-9.5・FR-9.6・FR-9.7。UC-14）。
 * 既定のロール（`admin`＝全権限、`general`＝手動入力のみ）で、Hono アプリ（app.request）から確かめる。
 * 一般が使えない操作は、ルート一覧（route-table.ts）から導き、増えたルートも、自動で確かめる。
 */

import { describe, expect, it } from 'vitest';
import { PERMISSIONS, type Permission } from '@smart-farm/shared/constants/permissions';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import {
  LoginResponseSchema,
  PublicUserSchema,
  UserListResponseSchema,
} from '@smart-farm/shared/schemas/auth';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { ROUTE_TABLE } from '../../src/backend/presentation/route-table.ts';
import { FACILITY_ID } from '../support/builders.ts';
import {
  addUserAndLogin,
  createTestContext,
  errorOf,
  markPasswordChanged,
  TEST_USER,
  withEquipment,
  type TestContext,
} from '../support/test-context.ts';

const GENERAL = { userId: 'general-1', role: 'general' } as const;
/** addUserAndLogin の既定のパスワード（ダミー）。 */
const GENERAL_PASSWORD = 'Dummy-Passw0rd-extra';

/** 一般が持つ権限（手動入力）。 */
const GENERAL_PERMISSIONS: readonly Permission[] = ['manual-entry:write'];

/** パスのパラメーターに、ダミーの値を入れる（存在しない対象。404・400 になってよい。ここで見るのは、権限の拒否〔403〕の有無だけ）。 */
function concretePath(path: string): string {
  return path.replace(/:[A-Za-z]+/g, 'dummy-id');
}

async function loginOf(context: TestContext, userId: string, password: string) {
  const response = await context.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, password }),
  });
  return LoginResponseSchema.parse(await response.json());
}

async function general(context: TestContext): Promise<string> {
  const token = await addUserAndLogin(context, GENERAL);
  await markPasswordChanged(context, GENERAL.userId);
  return token;
}

describe('ロールごとの認可（既定のロール。ADR-0013）', () => {
  it('管理者は、すべての権限を持つ。一般は、手動入力の権限だけを持つ（ログインの応答に、ロールと権限の一覧が含まれる）', async () => {
    const context = await createTestContext();
    await general(context);

    const admin = await loginOf(context, TEST_USER.userId, TEST_USER.password);
    const member = await loginOf(context, GENERAL.userId, GENERAL_PASSWORD);

    expect(admin.user).toMatchObject({ role: 'admin', permissions: [...PERMISSIONS] });
    expect(member.user).toMatchObject({ role: 'general', permissions: [...GENERAL_PERMISSIONS] });
  });

  describe('一般が使えない操作は、API の入口で拒否する（403 FORBIDDEN）', () => {
    const adminOnly = ROUTE_TABLE.filter(
      (route) =>
        route.access !== 'PUBLIC' &&
        route.access !== 'LOGIN' &&
        !GENERAL_PERMISSIONS.includes(route.access),
    );
    const allowedForGeneral = ROUTE_TABLE.filter(
      (route) =>
        route.access === 'LOGIN' ||
        (route.access !== 'PUBLIC' && GENERAL_PERMISSIONS.includes(route.access)),
    );

    it('管理者のみの操作が、ルート一覧にある（権限のあるルートが、一般に開かれていない）', () => {
      expect(adminOnly.length).toBeGreaterThanOrEqual(20);
    });

    it.each(adminOnly.map((route) => [`${route.method} ${route.path}`, route] as const))(
      '%s: 一般は拒否され、管理者は拒否されない',
      async (_name, route) => {
        const context = await createTestContext();
        const generalToken = await general(context);
        const path = concretePath(route.path);

        const denied = await context.request(path, {
          method: route.method,
          token: generalToken,
          body: route.method === 'GET' || route.method === 'DELETE' ? undefined : {},
        });
        const allowed = await context.request(path, {
          method: route.method,
          body: route.method === 'GET' || route.method === 'DELETE' ? undefined : {},
        });

        expect(denied.status).toBe(403);
        expect((await errorOf(denied)).code).toBe('FORBIDDEN');
        expect(allowed.status).not.toBe(403);
      },
    );

    it.each(
      allowedForGeneral
        // 本人のパスワードの変更・ログアウトは、副作用があるため、別のテストで確かめる
        .filter((route) => !route.path.startsWith('/auth/'))
        .map((route) => [`${route.method} ${route.path}`, route] as const),
    )('%s: 一般も、権限による拒否はされない', async (_name, route) => {
      const context = await createTestContext();
      const generalToken = await general(context);

      const response = await context.request(concretePath(route.path), {
        method: route.method,
        token: generalToken,
        body: route.method === 'GET' || route.method === 'DELETE' ? undefined : {},
      });

      expect(response.status).not.toBe(403);
    });
  });

  it('取り込みの設定・状況・ログと、連携のログの閲覧は、管理者のみ（ADR-0013。一般への開放は、設備ごとに絞れるようになってから。#116）', async () => {
    const context = await createTestContext();
    const generalToken = await general(context);

    for (const path of ['/ingestion/settings', '/ingestion/logs', '/federation/logs']) {
      const denied = await context.request(path, { token: generalToken });
      expect(denied.status, path).toBe(403);
      expect((await context.request(path)).status, path).toBe(200);
    }
  });

  it('一般は、割り当てられたハウスのダッシュボード・設備・通知・観測値を閲覧でき、手動入力の一覧も読める（割り当ては、Issue #330）', async () => {
    const context = await withEquipment();
    const generalToken = await general(context);
    await context.container.repositories.facilityAccess.save({
      facilityId: FACILITY_ID,
      userIds: [toUserId(GENERAL.userId)],
    });

    for (const path of ['/equipment', '/dashboard', '/notifications', '/manual-entries']) {
      const response = await context.request(path, { token: generalToken });
      expect(response.status, path).toBe(200);
    }
  });
});

describe('自身のユーザー情報の編集（PUT /auth/profile。FR-9.7）', () => {
  function putProfile(context: TestContext, token: string, body: unknown) {
    return context.request('/auth/profile', { method: 'PUT', token, body });
  }

  it('一般も、自分のユーザー名を変えられる。ロール・ユーザー ID は、変わらない', async () => {
    const context = await createTestContext();
    const token = await general(context);

    const response = await putProfile(context, token, { userName: '新しい名前' });

    expect(response.status).toBe(200);
    expect(PublicUserSchema.parse(await response.json())).toMatchObject({
      userId: GENERAL.userId,
      userName: '新しい名前',
      role: 'general',
    });
    const list = UserListResponseSchema.parse(await (await context.request('/users')).json());
    expect(list.items.find((user) => user.userId === GENERAL.userId)).toMatchObject({
      userName: '新しい名前',
      role: 'general',
    });
  });

  it('ロール・ユーザー ID・パスワードを送っても、変わらない（ユーザー名だけを受け付ける）', async () => {
    const context = await createTestContext();
    const token = await general(context);

    const response = await putProfile(context, token, {
      userName: '名前だけ',
      role: 'admin',
      userId: 'someone-else',
      password: 'Dummy-Passw0rd-x',
    });

    expect(response.status).toBe(200);
    const stored = await context.container.repositories.users.get(toUserId(GENERAL.userId));
    expect(stored).toMatchObject({ userName: '名前だけ', role: 'general' });
    expect(
      await context.container.repositories.users.get(toUserId('someone-else')),
    ).toBeUndefined();
    // パスワードは、変わっていない（もとのパスワードで、ログインできる）
    expect((await loginOf(context, GENERAL.userId, GENERAL_PASSWORD)).user.userId).toBe(
      GENERAL.userId,
    );
  });

  it('管理者も、自分のユーザー名を変えられる（ロールは、管理者のまま）', async () => {
    const context = await createTestContext();

    const response = await putProfile(context, await context.login(), { userName: '管理者A' });

    expect(response.status).toBe(200);
    expect(PublicUserSchema.parse(await response.json())).toMatchObject({
      userId: TEST_USER.userId,
      userName: '管理者A',
      role: 'admin',
    });
  });

  it.each([
    ['空', { userName: '' }],
    ['空白だけ', { userName: '   ' }],
    ['201 文字', { userName: 'あ'.repeat(201) }],
    ['ユーザー名がない', {}],
  ])('ユーザー名が不正（%s）なら、400 で拒否し、変更しない', async (_name, body) => {
    const context = await createTestContext();
    const token = await general(context);

    const response = await putProfile(context, token, body);

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('VALIDATION_ERROR');
    expect(
      (await context.container.repositories.users.get(toUserId(GENERAL.userId)))?.userName,
    ).toBe(GENERAL.userId);
  });

  it('ログインしていなければ、拒否する（401）', async () => {
    const context = await createTestContext();

    const response = await context.app.request('/api/v1/auth/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'x' }),
    });

    expect(response.status).toBe(401);
  });

  it('管理者が決めたパスワードの変更が済むまでは、できない（403 PASSWORD_CHANGE_REQUIRED）', async () => {
    const context = await createTestContext();
    const token = await addUserAndLogin(context, GENERAL);
    const stored = await context.container.repositories.users.get(toUserId(GENERAL.userId));
    if (stored === undefined) {
      throw new Error('テストの前提: ユーザーがいる');
    }
    await context.container.repositories.users.save({ ...stored, mustChangePassword: true });

    const response = await putProfile(context, token, { userName: '変更' });

    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('変更の履歴（操作履歴）に、変更前・変更後のユーザー名を残す', async () => {
    const context = await createTestContext();
    const token = await general(context);
    await putProfile(context, token, { userName: '履歴の確認' });

    const audit = AuditLogListResponseSchema.parse(
      await (await context.request('/audit-logs?operation=UPDATE')).json(),
    );

    const entry = audit.items.find((item) => item.targetType === 'user');
    expect(entry).toMatchObject({ targetId: GENERAL.userId, actor: toUserId(GENERAL.userId) });
    expect(JSON.stringify(entry)).toContain('履歴の確認');
    expect(JSON.stringify(entry)).not.toMatch(/scrypt|Dummy-Passw0rd/);
  });
});

describe('他人のユーザー情報・ロールは、一般には変えられない', () => {
  it('一般は、ユーザー管理（一覧・登録・変更・削除）を使えない。自分のロールも、管理者に変えられない', async () => {
    const context = await createTestContext();
    const token = await general(context);

    const attempts = [
      context.request('/users', { token }),
      context.request('/users', {
        method: 'POST',
        token,
        body: { userId: 'x-1', userName: 'x', password: 'Dummy-Passw0rd-x', role: 'admin' },
      }),
      context.request(`/users/${GENERAL.userId}`, {
        method: 'PUT',
        token,
        body: { userName: GENERAL.userId, role: 'admin' },
      }),
      context.request(`/users/${TEST_USER.userId}`, { method: 'DELETE', token }),
    ];

    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(403);
    }
    expect((await context.container.repositories.users.get(toUserId(GENERAL.userId)))?.role).toBe(
      'general',
    );
  });
});
