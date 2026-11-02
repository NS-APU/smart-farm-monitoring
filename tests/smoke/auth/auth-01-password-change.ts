/**
 * 認証の確認（サーバーレス環境。`pnpm test:smoke:auth`。Issue #243〜#245。D-44・D-45）: 管理者が決めたパスワードの変更の強制と、
 * 本人によるパスワード変更を、実際の経路（CloudFront・API の Lambda・Cognito・DynamoDB）で確かめる。
 * Cognito を偽にした自動テスト（`tests/integration/auth-contract.test.ts`）では確かめられない、次の点を見る:
 * IAM の権限（AdminSetUserPassword・AdminInitiateAuth・AdminUserGlobalSignOut）で足りること、
 * 全セッションの失効（古いアクセストークン・リフレッシュトークンが、すぐに使えなくなること）、Cognito のパスワードの条件。
 *
 * 環境に書き込む: 確認用のユーザー（ユーザーID `smoke-pw-<乱数>`）を 1 人登録し、**終わりに削除する**（変更履歴には残る）。
 * 途中で失敗しても、削除を試みる。削除できなかったときは、ユーザー管理（SC-14）で、`smoke-pw-` で始まるユーザーを削除する。
 * パスワードは、テストごとに乱数で作る（コード・ログ・結果に残さない）。
 *
 * 任意（SMOKE_LOGIN_LIMIT）: 接続元ごとのログインの失敗の制限（`LOGIN_FAILURE_LIMIT`）が、指定した回数で効くことを確かめる。
 * **この端末の接続元が、制限の時間（既定 15 分）、ログインできなくなる**。最後に行う（確認用のユーザーの削除のあと）。
 */

import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { LoginResponseSchema, type LoginResponse } from '../../../src/shared/schemas/auth.ts';
import { readSmokeEnv } from '../support/smoke-env.ts';

const API = '/api/v1';

function randomPassword(): string {
  // パスワードの条件（8 文字以上・英大文字・英小文字・数字）を満たす乱数
  return `Aa1-${randomBytes(9).toString('hex')}`;
}

async function login(
  request: APIRequestContext,
  userId: string,
  password: string,
): Promise<{ status: number; body: LoginResponse | undefined }> {
  const response = await request.post(`${API}/auth/login`, { data: { userId, password } });
  return {
    status: response.status(),
    body: response.status() === 200 ? LoginResponseSchema.parse(await response.json()) : undefined,
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function errorOf(response: {
  json: () => Promise<unknown>;
}): Promise<{ code: string; fields: string[] }> {
  const body = (await response.json()) as {
    error: { code: string; fields?: { name: string }[] };
  };
  return { code: body.error.code, fields: (body.error.fields ?? []).map((field) => field.name) };
}

test('管理者が決めたパスワードの変更の強制と、本人によるパスワード変更（Cognito・DynamoDB の経路）', async ({
  request,
}) => {
  const env = readSmokeEnv();
  const userId = `smoke-pw-${randomBytes(4).toString('hex')}`;
  const temporary = randomPassword();
  const own = randomPassword();
  const reset = randomPassword();

  const admin = await login(request, env.userId, env.password);
  expect(admin.status, '管理者のログイン').toBe(200);
  const adminToken = admin.body?.accessToken ?? '';

  try {
    // 1. 管理者が、利用者を登録する（パスワードは、管理者が決めた、一時のもの）
    const created = await request.post(`${API}/users`, {
      headers: bearer(adminToken),
      data: {
        userId,
        userName: 'スモークテスト（自動）。削除してよい',
        password: temporary,
        role: admin.body?.user.role,
      },
    });
    expect(created.status(), '利用者の登録').toBe(201);

    // 2. 最初のログイン: 変更が必要。ほかの API は、403（PASSWORD_CHANGE_REQUIRED）
    const first = await login(request, userId, temporary);
    expect(first.status, '最初のログイン').toBe(200);
    expect(first.body?.user.mustChangePassword).toBe(true);
    const blocked = await request.get(`${API}/equipment`, {
      headers: bearer(first.body?.accessToken ?? ''),
    });
    expect(blocked.status()).toBe(403);
    expect((await errorOf(blocked)).code).toBe('PASSWORD_CHANGE_REQUIRED');

    // 3. 別の端末（別のセッション）でも、ログインしておく（変更後に失効することを確かめる）
    const other = await login(request, userId, temporary);
    expect(other.status).toBe(200);

    // 4. 現在のパスワードの誤り: 400（currentPassword）。変更しない
    const wrong = await request.post(`${API}/auth/password`, {
      headers: bearer(first.body?.accessToken ?? ''),
      data: { currentPassword: randomPassword(), newPassword: own },
    });
    expect(wrong.status()).toBe(400);
    expect((await errorOf(wrong)).fields).toEqual(['currentPassword']);

    // 5. 変更する: 新しいセッションが返り、変更が必要な旨が外れる。新しいセッションで、すべての API が使える
    const changed = await request.post(`${API}/auth/password`, {
      headers: bearer(first.body?.accessToken ?? ''),
      data: { currentPassword: temporary, newPassword: own },
    });
    expect(changed.status(), '本人によるパスワードの変更').toBe(200);
    const session = LoginResponseSchema.parse(await changed.json());
    expect(session.user.mustChangePassword).toBe(false);
    const allowed = await request.get(`${API}/equipment`, { headers: bearer(session.accessToken) });
    expect(allowed.status()).toBe(200);

    // 6. 古いセッション（変更に使った端末・別の端末）は、アクセストークンも、リフレッシュトークンも、使えない
    for (const old of [first.body, other.body]) {
      const withOldAccess = await request.get(`${API}/equipment`, {
        headers: bearer(old?.accessToken ?? ''),
      });
      expect(withOldAccess.status(), '古いアクセストークン').toBe(401);
      const withOldRefresh = await request.post(`${API}/auth/refresh`, {
        data: { refreshToken: old?.refreshToken },
      });
      expect(withOldRefresh.status(), '古いリフレッシュトークン').toBe(401);
    }

    // 7. 管理者が決めたパスワードは、使えない。本人が決めたパスワードで、変更を求められずに、ログインできる
    expect((await login(request, userId, temporary)).status).toBe(401);
    const again = await login(request, userId, own);
    expect(again.status).toBe(200);
    expect(again.body?.user.mustChangePassword).toBe(false);

    // 8. 管理者が、パスワードを再設定すると、再設定したパスワードも、一時のもの。管理者自身のセッションは、そのまま
    const resetResponse = await request.put(`${API}/users/${userId}`, {
      headers: bearer(adminToken),
      data: {
        userName: 'スモークテスト（自動）。削除してよい',
        role: admin.body?.user.role,
        password: reset,
      },
    });
    expect(resetResponse.status(), 'パスワードの再設定').toBe(200);
    const afterReset = await login(request, userId, reset);
    expect(afterReset.status).toBe(200);
    expect(afterReset.body?.user.mustChangePassword).toBe(true);
    expect((await request.get(`${API}/equipment`, { headers: bearer(adminToken) })).status()).toBe(
      200,
    );

    // 9. 変更履歴に、パスワードの変更が残り、パスワードは、残らない
    const audit = await request.get(`${API}/audit-logs?operation=UPDATE&actor=${userId}`, {
      headers: bearer(adminToken),
    });
    expect(audit.status()).toBe(200);
    const auditText = await audit.text();
    expect(auditText).toContain('passwordChanged');
    for (const secret of [temporary, own, reset]) {
      expect(auditText).not.toContain(secret);
    }
  } finally {
    // 確認用のユーザーを、削除する（管理者のトークンが切れていたら、ログインし直す）
    const relogin = await login(request, env.userId, env.password);
    const token = relogin.body?.accessToken ?? adminToken;
    const removed = await request.delete(`${API}/users/${userId}`, { headers: bearer(token) });
    expect([204, 404], `確認用のユーザー（${userId}）の削除`).toContain(removed.status());
  }
});

test('接続元ごとのログインの失敗の制限が、指定した回数（SMOKE_LOGIN_LIMIT）で効く（任意。この端末の接続元が、制限の時間、ログインできなくなる）', async ({
  request,
}) => {
  const limit = Number(process.env.SMOKE_LOGIN_LIMIT ?? '');
  test.skip(
    !Number.isInteger(limit) || limit < 1,
    'SMOKE_LOGIN_LIMIT（1 以上の整数）を指定したときだけ',
  );
  const probe = `smoke-lock-${randomBytes(4).toString('hex')}`;

  // 存在しないユーザーの失敗も、接続元ごとに数える。回数に達するまでは 401、達したら 429
  for (let count = 1; count <= limit; count += 1) {
    expect(
      (await login(request, probe, randomPassword())).status,
      `${String(count)} 回目の失敗`,
    ).toBe(401);
  }
  const locked = await login(request, probe, randomPassword());

  expect(locked.status, `${String(limit)} 回の失敗のあと`).toBe(429);
});
