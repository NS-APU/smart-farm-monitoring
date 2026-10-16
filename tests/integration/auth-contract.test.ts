/**
 * 認証・資格情報（AuthPort・CredentialPort）の契約テスト。ローカルの実装と、Cognito の実装（偽の Cognito。実際の AWS には、
 * 接続しない）に、同じシナリオを適用する（Issue #74。ADR-0008）。ログイン・更新・ログアウト・トークンの検証・セッションの失効・
 * ログインの試行回数の制限・ユーザー管理（作成・パスワードの再設定・削除）が、どちらでも、同じ振る舞いになることを確かめる。
 * 実装ごとに違う振る舞い（本人のパスワードの再設定で、現在のセッションを残すか）は、末尾に、実装ごとに書く。
 */

import { describe, expect, it } from 'vitest';
import { AppError } from '@smart-farm/shared/errors';
import { toUserId } from '@smart-farm/shared/schemas/common';
import {
  createAccessPolicy,
  DEFAULT_ROLE_CONFIG,
} from '../../src/backend/application/auth/access-policy.ts';
import {
  createUserService,
  type UserService,
} from '../../src/backend/application/auth/user-service.ts';
import { createAuditService } from '../../src/backend/application/audit/audit-service.ts';
import type { AuthPort } from '../../src/backend/application/ports/auth-port.ts';
import type { CredentialPort } from '../../src/backend/application/ports/credential-port.ts';
import type { UserRepository } from '../../src/backend/application/ports/repositories.ts';
import { createCognitoIdentity } from '../../src/backend/infrastructure/cognito/cognito-identity.ts';
import {
  ACCESS_TOKEN_TTL_MINUTES,
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MINUTES,
  REFRESH_TOKEN_TTL_DAYS,
} from '../../src/backend/infrastructure/common/auth-policy.ts';
import {
  createControllableClock,
  type ControllableClock,
} from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { createInMemoryLoginThrottle } from '../../src/backend/infrastructure/local/in-memory-login-throttle.ts';
import { ensureInitialUser } from '../../src/backend/infrastructure/local/initial-user.ts';
import { createLocalAuth } from '../../src/backend/infrastructure/local/local-auth.ts';
import { createLocalCredentials } from '../../src/backend/infrastructure/local/local-credentials.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import { hashPassword } from '../../src/backend/infrastructure/local/password-hasher.ts';
import { createFakeCognito } from '../support/fake-cognito.ts';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const NOW = new Date('2026-10-09T03:00:00.000Z');
const ADMIN = {
  userId: 'admin-user',
  userName: '管理者',
  password: 'Dummy-Passw0rd-1',
  role: 'worker',
};

interface Subject {
  readonly auth: AuthPort;
  readonly credentials: CredentialPort;
  readonly users: UserRepository;
  readonly clock: ControllableClock;
  readonly userService: UserService;
}

function build(
  createIdentity: (
    users: UserRepository,
    clock: ControllableClock,
  ) => {
    auth: AuthPort;
    credentials: CredentialPort;
  },
): Subject {
  const clock = createControllableClock(NOW);
  clock.freeze(NOW);
  const { repositories } = createLocalRepositories();
  const { auth, credentials } = createIdentity(repositories.users, clock);
  const userService = createUserService({
    users: repositories.users,
    policy: createAccessPolicy(DEFAULT_ROLE_CONFIG),
    credentials,
    audit: createAuditService({
      auditLogs: repositories.auditLogs,
      clock,
      ids: createSequentialIdGenerator('audit'),
    }),
    clock,
    sessions: auth,
    pushSubscriptions: repositories.pushSubscriptions,
  });
  return { auth, credentials, users: repositories.users, clock, userService };
}

interface Factory {
  readonly name: string;
  readonly create: () => Subject;
}

const LOCAL: Factory = {
  name: 'ローカル',
  create: () =>
    build((users, clock) => ({
      auth: createLocalAuth({ users, clock }),
      credentials: createLocalCredentials({ hash: hashPassword }),
    })),
};

const COGNITO: Factory = {
  name: 'Cognito（偽）',
  create: () =>
    build((users, clock) => {
      const fake = createFakeCognito({
        userPoolId: 'pool',
        clientId: 'client',
        now: () => clock.now(),
      });
      return createCognitoIdentity({
        client: fake,
        userPoolId: 'pool',
        clientId: 'client',
        users,
        clock,
        throttle: createInMemoryLoginThrottle(clock),
      });
    }),
};

const FACTORIES: readonly Factory[] = [LOCAL, COGNITO];

/** 管理者（最初のユーザー）を作った状態。 */
async function seeded(create: () => Subject): Promise<Subject> {
  const subject = create();
  await ensureInitialUser(subject.users, ADMIN, NOW, subject.credentials);
  return subject;
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error('拒否されませんでした');
}

describe.each(FACTORIES)('認証・資格情報の契約（$name）', ({ create }) => {
  it('ログインできる。セッションに、ユーザー・ロール・期限があり、最終ログインの日時を記録する', async () => {
    const { auth, users } = await seeded(create);

    const session = await auth.login(
      { userId: ADMIN.userId, password: ADMIN.password },
      'client-a',
    );

    expect(session.principal).toEqual({ userId: ADMIN.userId, userName: '管理者', role: 'worker' });
    expect(session.accessTokenExpiresAt.getTime()).toBe(
      NOW.getTime() + ACCESS_TOKEN_TTL_MINUTES * MS_PER_MINUTE,
    );
    expect(session.refreshTokenExpiresAt.getTime()).toBe(
      NOW.getTime() + REFRESH_TOKEN_TTL_DAYS * MS_PER_DAY,
    );
    expect(session.accessToken).not.toBe(session.refreshToken);
    expect((await users.get(toUserId(ADMIN.userId)))?.lastLoginAt).toBe(NOW.toISOString());
  });

  it('パスワードの誤り・存在しないユーザー・形式が不正なユーザーIDは、同じメッセージで拒否する（存在を推測させない）', async () => {
    const { auth } = await seeded(create);

    const wrongPassword = await rejection(
      auth.login({ userId: ADMIN.userId, password: 'Wrong-Passw0rd-1' }, 'client-a'),
    );
    const unknownUser = await rejection(
      auth.login({ userId: 'nobody', password: ADMIN.password }, 'client-a'),
    );
    const malformedUserId = await rejection(
      auth.login({ userId: ' bad id ', password: ADMIN.password }, 'client-a'),
    );

    for (const error of [wrongPassword, unknownUser, malformedUserId]) {
      expect(error.code).toBe('UNAUTHENTICATED');
      expect(error.message).toBe(wrongPassword.message);
    }
  });

  it(`同じ接続元の失敗が ${String(LOGIN_FAILURE_LIMIT)} 回に達したら、正しいパスワードでも拒否する。別の接続元は、影響を受けない`, async () => {
    const { auth } = await seeded(create);
    for (let count = 0; count < LOGIN_FAILURE_LIMIT; count += 1) {
      await rejection(
        auth.login({ userId: ADMIN.userId, password: 'Wrong-Passw0rd-1' }, 'client-a'),
      );
    }

    const locked = await rejection(
      auth.login({ userId: ADMIN.userId, password: ADMIN.password }, 'client-a'),
    );
    const other = await auth.login({ userId: ADMIN.userId, password: ADMIN.password }, 'client-b');

    expect(locked.code).toBe('RATE_LIMITED');
    expect(other.principal.userId).toBe(ADMIN.userId);
  });

  it('制限の時間が過ぎたら、再びログインできる。成功すると、失敗の回数をリセットする', async () => {
    const { auth, clock } = await seeded(create);
    for (let count = 0; count < LOGIN_FAILURE_LIMIT; count += 1) {
      await rejection(
        auth.login({ userId: ADMIN.userId, password: 'Wrong-Passw0rd-1' }, 'client-a'),
      );
    }
    clock.advance(LOGIN_FAILURE_WINDOW_MINUTES * MS_PER_MINUTE + 1);

    await auth.login({ userId: ADMIN.userId, password: ADMIN.password }, 'client-a');
    for (let count = 0; count < LOGIN_FAILURE_LIMIT - 1; count += 1) {
      await rejection(
        auth.login({ userId: ADMIN.userId, password: 'Wrong-Passw0rd-1' }, 'client-a'),
      );
    }

    // 成功でリセットされているため、あと 1 回の失敗では、まだ、拒否されない
    expect(
      (await auth.login({ userId: ADMIN.userId, password: ADMIN.password }, 'client-a')).principal
        .userId,
    ).toBe(ADMIN.userId);
  });

  it('アクセストークンを検証できる。知らないトークンと、期限切れのトークンは、null', async () => {
    const { auth, clock } = await seeded(create);
    const session = await auth.login(
      { userId: ADMIN.userId, password: ADMIN.password },
      'client-a',
    );

    expect(await auth.verifyAccessToken(session.accessToken)).toEqual(session.principal);
    expect(await auth.verifyAccessToken('unknown-token')).toBeNull();
    clock.advance(ACCESS_TOKEN_TTL_MINUTES * MS_PER_MINUTE + 1000);
    expect(await auth.verifyAccessToken(session.accessToken)).toBeNull();
  });

  it('ロール・ユーザー名の変更と、ユーザーの削除は、次の検証から反映される', async () => {
    const { auth, users } = await seeded(create);
    const session = await auth.login(
      { userId: ADMIN.userId, password: ADMIN.password },
      'client-a',
    );
    const user = await users.get(toUserId(ADMIN.userId));
    if (user === undefined) {
      throw new Error('テストの前提');
    }

    await users.save({ ...user, userName: '改名後', role: 'viewer' });
    const renamed = await auth.verifyAccessToken(session.accessToken);
    await users.delete(toUserId(ADMIN.userId));

    expect(renamed).toMatchObject({ userName: '改名後', role: 'viewer' });
    expect(await auth.verifyAccessToken(session.accessToken)).toBeNull();
  });

  it('リフレッシュトークンで、セッションを更新できる。更新後のアクセストークンが使える', async () => {
    const { auth, clock } = await seeded(create);
    const first = await auth.login({ userId: ADMIN.userId, password: ADMIN.password }, 'client-a');
    clock.advance(ACCESS_TOKEN_TTL_MINUTES * MS_PER_MINUTE + 1000);

    const refreshed = await auth.refresh(first.refreshToken);

    expect(refreshed.principal).toEqual(first.principal);
    expect(await auth.verifyAccessToken(refreshed.accessToken)).toEqual(first.principal);
    expect(refreshed.accessTokenExpiresAt.getTime()).toBe(
      clock.now().getTime() + ACCESS_TOKEN_TTL_MINUTES * MS_PER_MINUTE,
    );
  });

  it('知らないリフレッシュトークンと、期限切れのリフレッシュトークンは、UNAUTHENTICATED', async () => {
    const { auth, clock } = await seeded(create);
    const session = await auth.login(
      { userId: ADMIN.userId, password: ADMIN.password },
      'client-a',
    );

    const unknown = await rejection(auth.refresh('unknown-token'));
    clock.advance(REFRESH_TOKEN_TTL_DAYS * MS_PER_DAY + 1);
    const expired = await rejection(auth.refresh(session.refreshToken));

    expect(unknown.code).toBe('UNAUTHENTICATED');
    expect(expired.code).toBe('UNAUTHENTICATED');
  });

  it('削除されたユーザーは、リフレッシュできない', async () => {
    const { auth, users } = await seeded(create);
    const session = await auth.login(
      { userId: ADMIN.userId, password: ADMIN.password },
      'client-a',
    );
    await users.delete(toUserId(ADMIN.userId));

    const error = await rejection(auth.refresh(session.refreshToken));

    expect(error.code).toBe('UNAUTHENTICATED');
  });

  it('ログアウトすると、アクセストークンも、リフレッシュトークンも、使えなくなる。2 回目のログアウトは、エラーにしない', async () => {
    const { auth } = await seeded(create);
    const session = await auth.login(
      { userId: ADMIN.userId, password: ADMIN.password },
      'client-a',
    );

    await auth.logout(session.accessToken);
    await auth.logout(session.accessToken);

    expect(await auth.verifyAccessToken(session.accessToken)).toBeNull();
    expect((await rejection(auth.refresh(session.refreshToken))).code).toBe('UNAUTHENTICATED');
  });

  it('そのユーザーのセッションを、失効できる。ユーザーがいなくても、エラーにしない', async () => {
    const { auth } = await seeded(create);
    const session = await auth.login(
      { userId: ADMIN.userId, password: ADMIN.password },
      'client-a',
    );

    await auth.revokeSessionsOf(toUserId(ADMIN.userId));
    await auth.revokeSessionsOf(toUserId('nobody'));

    expect(await auth.verifyAccessToken(session.accessToken)).toBeNull();
    expect((await rejection(auth.refresh(session.refreshToken))).code).toBe('UNAUTHENTICATED');
  });

  describe('ユーザー管理（資格情報の預け先）', () => {
    const NEW_USER = {
      userId: toUserId('new-user'),
      userName: '新しいユーザー',
      password: 'Dummy-Passw0rd-2',
      role: 'worker',
    };

    it('作成したユーザーは、そのパスワードでログインできる。同じユーザーIDの重複は、競合', async () => {
      const { auth, userService } = await seeded(create);

      await userService.create(NEW_USER, toUserId(ADMIN.userId));
      const session = await auth.login(
        { userId: NEW_USER.userId, password: NEW_USER.password },
        'client-a',
      );
      const duplicate = await rejection(userService.create(NEW_USER, toUserId(ADMIN.userId)));

      expect(session.principal.userName).toBe('新しいユーザー');
      expect(duplicate.code).toBe('CONFLICT');
    });

    it('パスワードを再設定すると、古いパスワードは使えず、新しいパスワードで、ログインできる。古いセッションは、失効する', async () => {
      const { auth, userService } = await seeded(create);
      await userService.create(NEW_USER, toUserId(ADMIN.userId));
      const old = await auth.login(
        { userId: NEW_USER.userId, password: NEW_USER.password },
        'client-a',
      );

      await userService.update(
        NEW_USER.userId,
        { userName: NEW_USER.userName, role: NEW_USER.role, password: 'Dummy-Passw0rd-3' },
        toUserId(ADMIN.userId),
      );

      expect(
        (
          await rejection(
            auth.login({ userId: NEW_USER.userId, password: NEW_USER.password }, 'client-b'),
          )
        ).code,
      ).toBe('UNAUTHENTICATED');
      expect(
        (await auth.login({ userId: NEW_USER.userId, password: 'Dummy-Passw0rd-3' }, 'client-b'))
          .principal.userId,
      ).toBe(NEW_USER.userId);
      expect(await auth.verifyAccessToken(old.accessToken)).toBeNull();
    });

    it('パスワードを変えない更新は、ログインできる状態を保つ（ロール・名前だけの変更）', async () => {
      const { auth, userService } = await seeded(create);
      await userService.create(NEW_USER, toUserId(ADMIN.userId));

      await userService.update(
        NEW_USER.userId,
        { userName: '改名後', role: NEW_USER.role },
        toUserId(ADMIN.userId),
      );

      expect(
        (await auth.login({ userId: NEW_USER.userId, password: NEW_USER.password }, 'client-a'))
          .principal.userName,
      ).toBe('改名後');
    });

    it('削除したユーザーは、ログインできず、セッションも使えない。同じ ID で作り直しても、古いトークンは使えない', async () => {
      const { auth, userService } = await seeded(create);
      await userService.create(NEW_USER, toUserId(ADMIN.userId));
      const old = await auth.login(
        { userId: NEW_USER.userId, password: NEW_USER.password },
        'client-a',
      );

      await userService.delete(NEW_USER.userId, toUserId(ADMIN.userId));
      const afterDelete = await auth.verifyAccessToken(old.accessToken);
      await userService.create(NEW_USER, toUserId(ADMIN.userId));
      const afterRecreate = await auth.verifyAccessToken(old.accessToken);

      expect(afterDelete).toBeNull();
      expect(afterRecreate).toBeNull();
      expect((await rejection(auth.refresh(old.refreshToken))).code).toBe('UNAUTHENTICATED');
    });
  });
});

describe('実装ごとに違う振る舞い（ADR-0008）', () => {
  it('ローカル: 本人が自分のパスワードを再設定しても、現在のセッションは残る', async () => {
    const subject = await seeded(LOCAL.create);
    const session = await subject.auth.login(
      { userId: ADMIN.userId, password: ADMIN.password },
      'client-a',
    );
    const other = await subject.auth.login(
      { userId: ADMIN.userId, password: ADMIN.password },
      'client-b',
    );

    await subject.userService.update(
      toUserId(ADMIN.userId),
      { userName: ADMIN.userName, role: ADMIN.role, password: 'Dummy-Passw0rd-3' },
      toUserId(ADMIN.userId),
      { currentAccessToken: session.accessToken },
    );

    expect(await subject.auth.verifyAccessToken(session.accessToken)).not.toBeNull();
    expect(await subject.auth.verifyAccessToken(other.accessToken)).toBeNull();
  });

  it('Cognito: 本人が自分のパスワードを再設定すると、すべての端末のセッションが終了する（再ログイン）', async () => {
    const subject = await seeded(COGNITO.create);
    const session = await subject.auth.login(
      { userId: ADMIN.userId, password: ADMIN.password },
      'client-a',
    );

    await subject.userService.update(
      toUserId(ADMIN.userId),
      { userName: ADMIN.userName, role: ADMIN.role, password: 'Dummy-Passw0rd-3' },
      toUserId(ADMIN.userId),
      { currentAccessToken: session.accessToken },
    );

    expect(await subject.auth.verifyAccessToken(session.accessToken)).toBeNull();
    await expect(
      subject.auth.login({ userId: ADMIN.userId, password: 'Dummy-Passw0rd-3' }, 'client-a'),
    ).resolves.toBeDefined();
  });

  it('ログアウトは、Cognito では、そのユーザーのすべての端末のセッションを終了し、ローカルでは、その端末だけ', async () => {
    const local = await seeded(LOCAL.create);
    const cognito = await seeded(COGNITO.create);
    const outcome = async (subject: Subject) => {
      const first = await subject.auth.login(
        { userId: ADMIN.userId, password: ADMIN.password },
        'a',
      );
      const second = await subject.auth.login(
        { userId: ADMIN.userId, password: ADMIN.password },
        'b',
      );
      await subject.auth.logout(first.accessToken);
      return (await subject.auth.verifyAccessToken(second.accessToken)) !== null;
    };

    expect(await outcome(local)).toBe(true);
    expect(await outcome(cognito)).toBe(false);
  });
});
