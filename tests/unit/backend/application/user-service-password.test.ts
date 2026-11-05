/**
 * 本人によるパスワード変更の、新しいセッションの発行（Issue #245。D-45）。
 * Cognito は、全セッションの失効（AdminUserGlobalSignOut）と同じ秒に発行したトークンも、失効として扱うことがある
 * （評価環境で、変更の直後の新しいセッションが 401 になった）。新しいセッションが、有効になるまで、間を置いて、やり直す。
 */

import { describe, expect, it } from 'vitest';
import { AppError } from '@smart-farm/shared/errors';
import { toUserId } from '@smart-farm/shared/schemas/common';
import {
  createAccessPolicy,
  DEFAULT_ROLE_CONFIG,
} from '../../../../src/backend/application/auth/access-policy.ts';
import { createUserService } from '../../../../src/backend/application/auth/user-service.ts';
import { createAuditService } from '../../../../src/backend/application/audit/audit-service.ts';
import type { AuthPort, AuthSession } from '../../../../src/backend/application/ports/auth-port.ts';
import { createControllableClock } from '../../../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../../../src/backend/infrastructure/local/ids.ts';
import { createLocalRepositories } from '../../../../src/backend/infrastructure/local/local-repositories.ts';

const NOW = new Date('2026-10-09T03:00:00.000Z');
const USER = toUserId('member-1');
const CURRENT = 'Dummy-Passw0rd-cur';
const NEXT = 'Dummy-Passw0rd-new';

function sessionOf(token: string): AuthSession {
  return {
    accessToken: token,
    refreshToken: `refresh-${token}`,
    accessTokenExpiresAt: new Date(NOW.getTime() + 1_800_000),
    refreshTokenExpiresAt: new Date(NOW.getTime() + 604_800_000),
    principal: { userId: USER, userName: '利用者', role: 'worker', mustChangePassword: false },
  };
}

/**
 * `revokedNewSessions` 個の、新しいパスワードのログインのセッションを、失効として扱う（検証で null）セッションの窓口。
 * `delays` は、待った時間（ミリ秒）の記録。
 */
async function build(revokedNewSessions: number) {
  const clock = createControllableClock(NOW);
  clock.freeze(NOW);
  const { repositories } = createLocalRepositories();
  await repositories.users.save({
    userId: USER,
    userName: '利用者',
    role: 'worker',
    mustChangePassword: true,
    createdAt: NOW.toISOString(),
  });
  const resetCalls: string[] = [];
  let newLogins = 0;
  const delays: number[] = [];
  const sessions: Pick<AuthPort, 'login' | 'revokeSessionsOf' | 'verifyAccessToken'> = {
    login(credentials) {
      if (credentials.password === CURRENT) {
        return Promise.resolve(sessionOf('current'));
      }
      newLogins += 1;
      return Promise.resolve(sessionOf(`new-${String(newLogins)}`));
    },
    revokeSessionsOf: () => Promise.resolve(),
    verifyAccessToken(token) {
      const index = token.startsWith('new-') ? Number(token.slice(4)) : 0;
      return Promise.resolve(index > revokedNewSessions ? { ...sessionOf(token).principal } : null);
    },
  };
  const service = createUserService({
    users: repositories.users,
    policy: createAccessPolicy(DEFAULT_ROLE_CONFIG),
    credentials: {
      register: () => Promise.resolve({}),
      reset(userId) {
        resetCalls.push(userId);
        return Promise.resolve({});
      },
      remove: () => Promise.resolve(),
    },
    audit: createAuditService({
      auditLogs: repositories.auditLogs,
      clock,
      ids: createSequentialIdGenerator('audit'),
    }),
    clock,
    sessions,
    pushSubscriptions: repositories.pushSubscriptions,
    delay(milliseconds) {
      delays.push(milliseconds);
      return Promise.resolve();
    },
  });
  return { service, users: repositories.users, resetCalls, delays, newLogins: () => newLogins };
}

describe('本人によるパスワード変更: 新しいセッションの発行', () => {
  it('新しいセッションが、すぐに有効なら、待たずに返す', async () => {
    const { service, delays, newLogins } = await build(0);

    const session = await service.changeOwnPassword(
      USER,
      { currentPassword: CURRENT, newPassword: NEXT },
      'client-a',
    );

    expect(session.accessToken).toBe('new-1');
    expect(delays).toEqual([]);
    expect(newLogins()).toBe(1);
  });

  it('失効として扱われたら（全セッションの失効と同じ秒の発行）、間を置いて、ログインし直し、有効なセッションを返す', async () => {
    const { service, delays, newLogins } = await build(2);

    const session = await service.changeOwnPassword(
      USER,
      { currentPassword: CURRENT, newPassword: NEXT },
      'client-a',
    );

    expect(session.accessToken).toBe('new-3');
    expect(newLogins()).toBe(3);
    expect(delays).toEqual([700, 700]);
  });

  it('何度やり直しても有効にならなければ、パスワードは変更済みのまま、ログインし直す旨のエラー（UNAUTHENTICATED）にする', async () => {
    const { service, users, resetCalls, delays, newLogins } = await build(99);

    const error = await service
      .changeOwnPassword(USER, { currentPassword: CURRENT, newPassword: NEXT }, 'client-a')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('UNAUTHENTICATED');
    expect((error as AppError).message).toContain('パスワードを変更しました');
    // ログインは 4 回（最初と、やり直し 3 回）。待ちは 3 回
    expect(newLogins()).toBe(4);
    expect(delays).toEqual([700, 700, 700]);
    // パスワードは、変更されている（変更が必要な旨も、外れている）
    expect(resetCalls).toEqual([USER]);
    expect((await users.get(USER))?.mustChangePassword).toBe(false);
  });
});
