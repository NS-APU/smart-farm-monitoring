/**
 * 管理者が決めたパスワードの「一時」の扱いと、本人によるパスワード変更の結合テスト（Issue #245。D-45。FR-9.4・FR-9.7。UC-13・UC-14）。
 * Hono アプリ（app.request）から、ログイン → 変更の強制 → 変更 → 他のセッションの失効までを確かめる（ローカルの認証）。
 */

import { describe, expect, it } from 'vitest';
import { LoginResponseSchema } from '@smart-farm/shared/schemas/auth';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import { toUserId } from '@smart-farm/shared/schemas/common';
import {
  errorOf,
  createTestContext,
  TEST_USER,
  type TestContext,
} from '../support/test-context.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };
const TEMP_PASSWORD = 'Dummy-Passw0rd-temp';
const NEW_PASSWORD = 'Dummy-Passw0rd-own';
const MEMBER = { userId: 'member-1', userName: '利用者1', role: 'worker' };

function post(context: TestContext, path: string, body: unknown, token?: string) {
  return context.app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

async function login(context: TestContext, userId: string, password: string) {
  const response = await post(context, '/auth/login', { userId, password });
  return {
    response,
    body: response.status === 200 ? LoginResponseSchema.parse(await response.json()) : undefined,
  };
}

async function session(context: TestContext, userId: string, password: string) {
  const { body } = await login(context, userId, password);
  if (body === undefined) {
    throw new Error('テストの前提: ログインできる');
  }
  return body;
}

/** 管理者（初期ユーザー）が、利用者を登録する（パスワードは、管理者が決めた、一時のもの）。 */
async function registerMember(context: TestContext, password = TEMP_PASSWORD) {
  const response = await context.request('/users', {
    method: 'POST',
    body: { ...MEMBER, password },
  });
  expect(response.status).toBe(201);
}

function changePassword(
  context: TestContext,
  token: string,
  currentPassword: string,
  newPassword: string,
) {
  return post(context, '/auth/password', { currentPassword, newPassword }, token);
}

describe('管理者が決めたパスワードは、一時のもの（D-45）', () => {
  it('管理者が登録した利用者は、最初のログインで、パスワードの変更が必要な旨がわかる。ログインはできる', async () => {
    const context = await createTestContext();
    await registerMember(context);

    const { response, body } = await login(context, MEMBER.userId, TEMP_PASSWORD);

    expect(response.status).toBe(200);
    expect(body?.user.mustChangePassword).toBe(true);
  });

  it('変更するまで、パスワードの変更・ログアウト以外の API は、拒否する（403。PASSWORD_CHANGE_REQUIRED）', async () => {
    const context = await createTestContext();
    await registerMember(context);
    const { accessToken } = await session(context, MEMBER.userId, TEMP_PASSWORD);

    const blocked = await context.request('/equipment', { token: accessToken });
    const blockedWrite = await context.request('/manual-entries', {
      method: 'POST',
      token: accessToken,
      body: {},
    });

    expect(blocked.status).toBe(403);
    expect((await errorOf(blocked)).code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(blockedWrite.status).toBe(403);
    expect((await errorOf(blockedWrite)).code).toBe('PASSWORD_CHANGE_REQUIRED');
    const logout = await post(context, '/auth/logout', {}, accessToken);
    expect(logout.status).toBe(204);
  });

  it('セッションを更新（リフレッシュ）しても、変更が必要な旨は、変わらない', async () => {
    const context = await createTestContext();
    await registerMember(context);
    const { refreshToken } = await session(context, MEMBER.userId, TEMP_PASSWORD);

    const refreshed = LoginResponseSchema.parse(
      await (await post(context, '/auth/refresh', { refreshToken })).json(),
    );

    expect(refreshed.user.mustChangePassword).toBe(true);
  });

  it('新しいパスワードを決めると、変更が必要な旨がなくなり、新しいセッションで、すべての API が使える。管理者が決めたパスワードは、使えなくなる', async () => {
    const context = await createTestContext();
    await registerMember(context);
    const temporary = await session(context, MEMBER.userId, TEMP_PASSWORD);

    const response = await changePassword(
      context,
      temporary.accessToken,
      TEMP_PASSWORD,
      NEW_PASSWORD,
    );

    expect(response.status).toBe(200);
    const changed = LoginResponseSchema.parse(await response.json());
    expect(changed.user.mustChangePassword).toBe(false);
    expect((await context.request('/equipment', { token: changed.accessToken })).status).toBe(200);
    // 管理者が決めたパスワードでは、ログインできない。本人が決めたパスワードで、ログインできる（変更が必要な旨は、ない）
    expect((await login(context, MEMBER.userId, TEMP_PASSWORD)).response.status).toBe(401);
    const again = await login(context, MEMBER.userId, NEW_PASSWORD);
    expect(again.body?.user.mustChangePassword).toBe(false);
  });

  it('管理者が、パスワードを再設定すると（他の利用者）、再設定したパスワードも、一時のもの（変更が必要）', async () => {
    const context = await createTestContext();
    await registerMember(context);
    const first = await session(context, MEMBER.userId, TEMP_PASSWORD);
    await changePassword(context, first.accessToken, TEMP_PASSWORD, NEW_PASSWORD);

    const reset = await context.request(`/users/${MEMBER.userId}`, {
      method: 'PUT',
      body: { userName: MEMBER.userName, role: MEMBER.role, password: 'Dummy-Passw0rd-reset' },
    });
    const afterReset = await login(context, MEMBER.userId, 'Dummy-Passw0rd-reset');

    expect(reset.status).toBe(200);
    expect(afterReset.body?.user.mustChangePassword).toBe(true);
  });

  it('パスワードを指定しない更新（ユーザー名・ロールだけ）は、変更が必要な旨を、変えない', async () => {
    const context = await createTestContext();
    await registerMember(context);
    const first = await session(context, MEMBER.userId, TEMP_PASSWORD);
    await changePassword(context, first.accessToken, TEMP_PASSWORD, NEW_PASSWORD);

    await context.request(`/users/${MEMBER.userId}`, {
      method: 'PUT',
      body: { userName: '名前を変更', role: MEMBER.role },
    });

    expect((await login(context, MEMBER.userId, NEW_PASSWORD)).body?.user.mustChangePassword).toBe(
      false,
    );
  });

  it('管理者が、自分自身のパスワードを再設定したときは、変更を強制しない（自分で決めたパスワードのため）', async () => {
    const context = await createTestContext();

    const reset = await context.request(`/users/${TEST_USER.userId}`, {
      method: 'PUT',
      body: { userName: TEST_USER.userName, role: 'worker', password: 'Dummy-Passw0rd-self' },
    });
    const afterReset = await login(context, TEST_USER.userId, 'Dummy-Passw0rd-self');

    expect(reset.status).toBe(200);
    expect(afterReset.body?.user.mustChangePassword).toBe(false);
  });

  it('最初のユーザー（初期ユーザー）と、記録に印のない既存のユーザーは、変更を強制しない', async () => {
    const context = await createTestContext();

    const initial = await login(context, TEST_USER.userId, TEST_USER.password);

    expect(initial.body?.user.mustChangePassword).toBe(false);
    expect((await context.request('/equipment')).status).toBe(200);
  });
});

describe('本人によるパスワードの変更（POST /auth/password。FR-9.7）', () => {
  it('変更が必要でない利用者も、自分のパスワードを変えられる（現在のパスワードを入力する）', async () => {
    const context = await createTestContext();
    const current = await session(context, TEST_USER.userId, TEST_USER.password);

    const response = await changePassword(
      context,
      current.accessToken,
      TEST_USER.password,
      NEW_PASSWORD,
    );

    expect(response.status).toBe(200);
    expect((await login(context, TEST_USER.userId, TEST_USER.password)).response.status).toBe(401);
    expect((await login(context, TEST_USER.userId, NEW_PASSWORD)).response.status).toBe(200);
  });

  it('現在のパスワードが違うと、400（currentPassword のエラー）で、変更しない', async () => {
    const context = await createTestContext();
    const current = await session(context, TEST_USER.userId, TEST_USER.password);

    const response = await changePassword(
      context,
      current.accessToken,
      'Dummy-Passw0rd-wrong',
      NEW_PASSWORD,
    );

    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.fields?.map((field) => field.name)).toEqual(['currentPassword']);
    expect((await login(context, TEST_USER.userId, TEST_USER.password)).response.status).toBe(200);
  });

  it.each([
    ['短すぎる（7 文字）', 'Aa1xxxx'],
    ['英大文字がない', 'dummy-passw0rd-own'],
    ['英小文字がない', 'DUMMY-PASSW0RD-OWN'],
    ['数字がない', 'Dummy-Password-own'],
    ['長すぎる（129 文字）', `Aa1${'x'.repeat(126)}`],
  ])(
    '新しいパスワードが、条件を満たさない（%s）と、400（newPassword のエラー）で、変更しない',
    async (_name, newPassword) => {
      const context = await createTestContext();
      const current = await session(context, TEST_USER.userId, TEST_USER.password);

      const response = await changePassword(
        context,
        current.accessToken,
        TEST_USER.password,
        newPassword,
      );

      expect(response.status).toBe(400);
      expect((await errorOf(response)).fields?.map((field) => field.name)).toContain('newPassword');
      expect((await login(context, TEST_USER.userId, TEST_USER.password)).response.status).toBe(
        200,
      );
    },
  );

  it('新しいパスワードが、現在のパスワードと同じだと、400（newPassword のエラー）。一時のパスワードのままにはできない', async () => {
    const context = await createTestContext();
    await registerMember(context);
    const temporary = await session(context, MEMBER.userId, TEMP_PASSWORD);

    const response = await changePassword(
      context,
      temporary.accessToken,
      TEMP_PASSWORD,
      TEMP_PASSWORD,
    );

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((field) => field.name)).toEqual(['newPassword']);
    // 変更が必要な旨は、そのまま
    expect((await login(context, MEMBER.userId, TEMP_PASSWORD)).body?.user.mustChangePassword).toBe(
      true,
    );
  });

  it('変更すると、ほかの端末のセッション（アクセス・リフレッシュ）は、失効する。変更に使ったセッションは、新しいセッションに替わる', async () => {
    const context = await createTestContext();
    const mine = await session(context, TEST_USER.userId, TEST_USER.password);
    const other = await session(context, TEST_USER.userId, TEST_USER.password);

    const response = await changePassword(
      context,
      mine.accessToken,
      TEST_USER.password,
      NEW_PASSWORD,
    );

    const changed = LoginResponseSchema.parse(await response.json());
    expect((await context.request('/equipment', { token: other.accessToken })).status).toBe(401);
    expect(
      (await post(context, '/auth/refresh', { refreshToken: other.refreshToken })).status,
    ).toBe(401);
    expect((await context.request('/equipment', { token: mine.accessToken })).status).toBe(401);
    expect((await context.request('/equipment', { token: changed.accessToken })).status).toBe(200);
  });

  it('認証がなければ 401。本文が不正（項目の欠け）なら 400', async () => {
    const context = await createTestContext();
    const current = await session(context, TEST_USER.userId, TEST_USER.password);

    const anonymous = await post(context, '/auth/password', {
      currentPassword: TEST_USER.password,
      newPassword: NEW_PASSWORD,
    });
    const missing = await post(
      context,
      '/auth/password',
      { currentPassword: TEST_USER.password },
      current.accessToken,
    );

    expect(anonymous.status).toBe(401);
    expect(missing.status).toBe(400);
  });

  it('現在のパスワードの誤りは、ログインの失敗と同じく、接続元ごとの制限に数える。上限（既定 5 回）で 429', async () => {
    const context = await createTestContext();
    const current = await session(context, TEST_USER.userId, TEST_USER.password);

    for (let count = 0; count < 5; count += 1) {
      expect(
        (await changePassword(context, current.accessToken, 'Dummy-Passw0rd-wrong', NEW_PASSWORD))
          .status,
      ).toBe(400);
    }
    const blocked = await changePassword(
      context,
      current.accessToken,
      TEST_USER.password,
      NEW_PASSWORD,
    );

    expect(blocked.status).toBe(429);
  });

  it('変更は、変更履歴に残る（操作者は本人。パスワード・ハッシュは残さない）', async () => {
    const context = await createTestContext();
    const current = await session(context, TEST_USER.userId, TEST_USER.password);
    const changed = LoginResponseSchema.parse(
      await (
        await changePassword(context, current.accessToken, TEST_USER.password, NEW_PASSWORD)
      ).json(),
    );

    const audit = AuditLogListResponseSchema.parse(
      await (
        await context.request('/audit-logs?operation=UPDATE', { token: changed.accessToken })
      ).json(),
    );

    const entry = audit.items.find((item) => item.targetType === 'user');
    expect(entry).toMatchObject({ targetId: TEST_USER.userId, actor: toUserId(TEST_USER.userId) });
    expect(JSON.stringify(entry)).not.toMatch(/scrypt|Dummy-Passw0rd/);
  });
});
