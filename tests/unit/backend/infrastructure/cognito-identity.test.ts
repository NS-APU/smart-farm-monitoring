import { describe, expect, it } from 'vitest';
import { AppError } from '@smart-farm/shared/errors';
import { toUserId } from '@smart-farm/shared/schemas/common';
import type { LoginThrottlePort } from '../../../../src/backend/application/ports/login-throttle-port.ts';
import { createCognitoIdentity } from '../../../../src/backend/infrastructure/cognito/cognito-identity.ts';
import { createControllableClock } from '../../../../src/backend/infrastructure/local/clocks.ts';
import { createInMemoryLoginThrottle } from '../../../../src/backend/infrastructure/local/in-memory-login-throttle.ts';
import { ensureInitialUser } from '../../../../src/backend/infrastructure/local/initial-user.ts';
import { createLocalRepositories } from '../../../../src/backend/infrastructure/local/local-repositories.ts';
import { cognitoError, createFakeCognito } from '../../../support/fake-cognito.ts';

const NOW = new Date('2026-10-09T03:00:00.000Z');
const USER = {
  userId: 'admin-user',
  userName: '管理者',
  password: 'Dummy-Passw0rd-1',
  role: 'worker',
};
const USER_ID = toUserId(USER.userId);

function setup(throttle?: LoginThrottlePort) {
  const clock = createControllableClock(NOW);
  clock.freeze(NOW);
  const fake = createFakeCognito({
    userPoolId: 'pool-1',
    clientId: 'client-1',
    now: () => clock.now(),
  });
  const { repositories } = createLocalRepositories();
  const recorded: string[] = [];
  const throttleOf = throttle ?? createInMemoryLoginThrottle(clock);
  const identity = createCognitoIdentity({
    client: fake,
    userPoolId: 'pool-1',
    clientId: 'client-1',
    users: repositories.users,
    clock,
    throttle: {
      isLocked: (clientKey) => throttleOf.isLocked(clientKey),
      recordFailure(clientKey) {
        recorded.push(clientKey);
        return throttleOf.recordFailure(clientKey);
      },
      reset: (clientKey) => throttleOf.reset(clientKey),
    },
  });
  return { fake, identity, users: repositories.users, clock, recorded };
}

async function seeded(throttle?: LoginThrottlePort) {
  const subject = setup(throttle);
  await ensureInitialUser(subject.users, USER, NOW, subject.identity.credentials);
  return subject;
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? error.code : `想定外: ${String(error)}`;
  }
  return '拒否されなかった';
}

describe('Cognito の実装（送る内容）', () => {
  it('ログイン: サーバー側の認証（ADMIN_USER_PASSWORD_AUTH）で、ユーザーID をユーザー名として送る', async () => {
    const { fake, identity } = await seeded();

    await identity.auth.login({ userId: USER.userId, password: USER.password }, 'client-a');

    expect(fake.calls.at(-1)).toEqual({
      command: 'AdminInitiateAuthCommand',
      input: {
        UserPoolId: 'pool-1',
        ClientId: 'client-1',
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: USER.userId, PASSWORD: USER.password },
      },
    });
  });

  it('ユーザーの作成: 招待のメッセージは送らず（SUPPRESS）、パスワードを、恒久のものとして設定する', async () => {
    const { fake } = await seeded();

    const create = fake.calls.find((call) => call.command === 'AdminCreateUserCommand');
    const set = fake.calls.find((call) => call.command === 'AdminSetUserPasswordCommand');

    expect(create?.input).toEqual({
      UserPoolId: 'pool-1',
      Username: USER.userId,
      MessageAction: 'SUPPRESS',
    });
    expect(set?.input).toEqual({
      UserPoolId: 'pool-1',
      Username: USER.userId,
      Password: USER.password,
      Permanent: true,
    });
  });
});

describe('Cognito の実装（ログイン）', () => {
  it('Cognito の呼び出しの上限（スロットリング）は、試行の失敗として数えず、RATE_LIMITED にする', async () => {
    const { fake, identity, recorded } = await seeded();
    fake.failNext('AdminInitiateAuthCommand', cognitoError('TooManyRequestsException'));

    const result = await code(
      identity.auth.login({ userId: USER.userId, password: USER.password }, 'client-a'),
    );

    expect(result).toBe('RATE_LIMITED');
    expect(recorded).toEqual([]);
  });

  it('想定外の Cognito のエラー（障害など）は、そのまま投げる（ログインの失敗として、数えない）', async () => {
    const { fake, identity, recorded } = await seeded();
    fake.failNext('AdminInitiateAuthCommand', cognitoError('InternalErrorException'));

    await expect(
      identity.auth.login({ userId: USER.userId, password: USER.password }, 'client-a'),
    ).rejects.toThrow('InternalErrorException');
    expect(recorded).toEqual([]);
  });

  it('Error でない値が投げられても、そのまま投げる', async () => {
    const { fake, identity } = await seeded();
    fake.failNext('AdminInitiateAuthCommand', 'boom' as unknown as Error);

    await expect(
      identity.auth.login({ userId: USER.userId, password: USER.password }, 'client-a'),
    ).rejects.toBe('boom');
  });

  it('記録（ロール）のない Cognito のユーザーは、ログインさせず、失敗として数える', async () => {
    const { fake, identity, recorded } = setup();
    fake.addOrphanUser('orphan');
    await identity.credentials.reset(toUserId('orphan'), 'Dummy-Passw0rd-9');

    const result = await code(
      identity.auth.login({ userId: 'orphan', password: 'Dummy-Passw0rd-9' }, 'client-a'),
    );

    expect(result).toBe('UNAUTHENTICATED');
    expect(recorded).toEqual(['client-a']);
  });

  it('追加の認証（チャレンジ）が必要な応答は、ログインさせない', async () => {
    const { users } = await seeded();
    const clock = createControllableClock(NOW);
    const challenged = createCognitoIdentity({
      client: { send: () => Promise.resolve({ ChallengeName: 'NEW_PASSWORD_REQUIRED' }) } as never,
      userPoolId: 'pool-1',
      clientId: 'client-1',
      users,
      clock,
      throttle: createInMemoryLoginThrottle(clock),
    });

    expect(
      await code(challenged.auth.login({ userId: USER.userId, password: USER.password }, 'c')),
    ).toBe('UNAUTHENTICATED');
  });

  it('有効期間の指定がない応答でも、セッションを作る（期限は、発行の時刻）', async () => {
    const { users } = await seeded();
    const clock = createControllableClock(NOW);
    const bare = createCognitoIdentity({
      client: {
        send: () =>
          Promise.resolve({ AuthenticationResult: { AccessToken: 'a', RefreshToken: 'r' } }),
      } as never,
      userPoolId: 'pool-1',
      clientId: 'client-1',
      users,
      clock,
      throttle: createInMemoryLoginThrottle(clock),
    });

    const session = await bare.auth.login({ userId: USER.userId, password: USER.password }, 'c');

    expect(session.accessTokenExpiresAt.getTime()).toBe(NOW.getTime());
  });
});

describe('Cognito の実装（トークン・更新・ログアウト）', () => {
  it('トークンの検証で、想定外の Cognito のエラーは、そのまま投げる', async () => {
    const { fake, identity } = await seeded();
    const session = await identity.auth.login(
      { userId: USER.userId, password: USER.password },
      'client-a',
    );
    fake.failNext('GetUserCommand', cognitoError('InternalErrorException'));

    await expect(identity.auth.verifyAccessToken(session.accessToken)).rejects.toThrow(
      'InternalErrorException',
    );
  });

  it('形式が不正なトークン（InvalidParameterException）は、無効として、null にする', async () => {
    const { fake, identity } = await seeded();
    fake.failNext('GetUserCommand', cognitoError('InvalidParameterException'));

    expect(await identity.auth.verifyAccessToken('malformed')).toBeNull();
  });

  it('ユーザー名が、ユーザーIDの形式でないトークンは、無効', async () => {
    const { users } = await seeded();
    const clock = createControllableClock(NOW);
    const odd = createCognitoIdentity({
      client: { send: () => Promise.resolve({ Username: 'not a valid id!' }) } as never,
      userPoolId: 'pool-1',
      clientId: 'client-1',
      users,
      clock,
      throttle: createInMemoryLoginThrottle(clock),
    });

    expect(await odd.auth.verifyAccessToken('token')).toBeNull();
  });

  it('更新で、想定外の Cognito のエラーは、そのまま投げる。応答に、アクセストークンがなければ、拒否する', async () => {
    const { fake, identity, users } = await seeded();
    const session = await identity.auth.login(
      { userId: USER.userId, password: USER.password },
      'client-a',
    );
    fake.failNext('AdminInitiateAuthCommand', cognitoError('InternalErrorException'));
    await expect(identity.auth.refresh(session.refreshToken)).rejects.toThrow(
      'InternalErrorException',
    );

    const clock = createControllableClock(NOW);
    const empty = createCognitoIdentity({
      client: { send: () => Promise.resolve({}) } as never,
      userPoolId: 'pool-1',
      clientId: 'client-1',
      users,
      clock,
      throttle: createInMemoryLoginThrottle(clock),
    });
    expect(await code(empty.auth.refresh('r'))).toBe('UNAUTHENTICATED');
  });

  it('更新の応答に、新しいリフレッシュトークンがあれば、それを使う（回転する設定にしたとき）', async () => {
    const { users } = await seeded();
    const clock = createControllableClock(NOW);
    const calls: string[] = [];
    const rotating = createCognitoIdentity({
      client: {
        send: (command: { constructor: { name: string } }) => {
          calls.push(command.constructor.name);
          return Promise.resolve(
            command.constructor.name === 'GetUserCommand'
              ? { Username: USER.userId }
              : {
                  AuthenticationResult: {
                    AccessToken: 'new-access',
                    RefreshToken: 'new-refresh',
                    ExpiresIn: 60,
                  },
                },
          );
        },
      } as never,
      userPoolId: 'pool-1',
      clientId: 'client-1',
      users,
      clock,
      throttle: createInMemoryLoginThrottle(clock),
    });

    const session = await rotating.auth.refresh('old-refresh');

    expect(session.refreshToken).toBe('new-refresh');
    expect(session.accessTokenExpiresAt.getTime()).toBe(NOW.getTime() + 60_000);
  });

  it('ログアウトで、想定外の Cognito のエラーは、そのまま投げる', async () => {
    const { fake, identity } = await seeded();
    const session = await identity.auth.login(
      { userId: USER.userId, password: USER.password },
      'client-a',
    );
    fake.failNext('GlobalSignOutCommand', cognitoError('InternalErrorException'));

    await expect(identity.auth.logout(session.accessToken)).rejects.toThrow(
      'InternalErrorException',
    );
  });

  it('セッションの失効で、想定外の Cognito のエラーは、そのまま投げる', async () => {
    const { fake, identity } = await seeded();
    fake.failNext('AdminUserGlobalSignOutCommand', cognitoError('InternalErrorException'));

    await expect(identity.auth.revokeSessionsOf(USER_ID)).rejects.toThrow('InternalErrorException');
  });
});

describe('Cognito の実装（資格情報）', () => {
  it('Cognito のパスワードの条件を満たさなければ、入力不正（VALIDATION_ERROR）にし、作ったユーザーを戻す', async () => {
    const { fake, identity } = setup();

    const result = await code(identity.credentials.register(toUserId('weak-user'), 'weak'));

    expect(result).toBe('VALIDATION_ERROR');
    expect(fake.hasUser('weak-user')).toBe(false);
  });

  it('パスワードの設定に失敗し、戻す操作にも失敗しても、元のエラーを返す', async () => {
    const { fake, identity } = setup();
    fake.failNext('AdminSetUserPasswordCommand', cognitoError('InternalErrorException'));
    fake.failNext('AdminDeleteUserCommand', cognitoError('InternalErrorException'));

    await expect(
      identity.credentials.register(toUserId('new-user'), 'Dummy-Passw0rd-1'),
    ).rejects.toThrow('InternalErrorException');
  });

  it('記録のないまま残っているユーザー（同じユーザー名）は、引き継ぎ、古いセッションを失効する', async () => {
    const { fake, identity } = setup();
    fake.addOrphanUser('leftover');

    await identity.credentials.register(toUserId('leftover'), 'Dummy-Passw0rd-1');

    expect(fake.hasPassword('leftover')).toBe(true);
    expect(fake.calls.map((call) => call.command)).toContain('AdminUserGlobalSignOutCommand');
  });

  it('ユーザーの作成の想定外のエラーは、そのまま投げる', async () => {
    const { fake, identity } = setup();
    fake.failNext('AdminCreateUserCommand', cognitoError('InternalErrorException'));

    await expect(
      identity.credentials.register(toUserId('x-user'), 'Dummy-Passw0rd-1'),
    ).rejects.toThrow('InternalErrorException');
  });

  it('パスワードの再設定: 記録はあるのに Cognito にいないユーザーは、作り直す。想定外のエラーは、そのまま投げる', async () => {
    const { fake, identity } = setup();

    await identity.credentials.reset(toUserId('lost-user'), 'Dummy-Passw0rd-1');
    expect(fake.hasPassword('lost-user')).toBe(true);

    fake.failNext('AdminSetUserPasswordCommand', cognitoError('InternalErrorException'));
    await expect(
      identity.credentials.reset(toUserId('lost-user'), 'Dummy-Passw0rd-2'),
    ).rejects.toThrow('InternalErrorException');
  });

  it('削除: Cognito にいなければ、何もしない。想定外のエラーは、そのまま投げる', async () => {
    const { fake, identity } = setup();

    await expect(identity.credentials.remove(toUserId('nobody'))).resolves.toBeUndefined();

    fake.addOrphanUser('present');
    fake.failNext('AdminDeleteUserCommand', cognitoError('InternalErrorException'));
    await expect(identity.credentials.remove(toUserId('present'))).rejects.toThrow(
      'InternalErrorException',
    );
  });
});
