/**
 * Cognito の認証の組み立て（container.ts）・最初のユーザーを作るコマンド・ログインの試行回数の制限（DynamoDB）の、結合テスト
 * （Issue #74。ADR-0008）。DynamoDB は DynamoDB Local、Cognito は偽の Cognito（実際の AWS には、接続しない）。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { createLoginThrottle } from '../../src/backend/infrastructure/dynamodb/login-throttle.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import {
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MINUTES,
} from '../../src/backend/infrastructure/common/auth-policy.ts';
import { createApp } from '../../src/backend/presentation/create-app.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { runInitialUserCli } from '../../src/backend/runtime/initial-user-cli.ts';
import { cognitoError, createFakeCognito } from '../support/fake-cognito.ts';
import {
  createDynamoTestDatabase,
  dropDynamoTestTables,
  dynamoTestClientOptions,
} from '../support/dynamodb-test-database.ts';

afterAll(dropDynamoTestTables);

const NOW = new Date('2026-10-09T03:00:00.000Z');
const MS_PER_MINUTE = 60_000;

describe('ログインの試行回数の制限（DynamoDB）', () => {
  async function throttleWithClock() {
    const database = createDynamoTestDatabase();
    await database.ready;
    const clock = createControllableClock(NOW);
    clock.freeze(NOW);
    return {
      clock,
      throttle: createLoginThrottle({ client: database.client, tables: database.tables }, clock),
    };
  }

  it(`同じ接続元の失敗が ${String(LOGIN_FAILURE_LIMIT)} 回に達したら、制限する。別の接続元は、影響を受けない`, async () => {
    const { throttle } = await throttleWithClock();
    for (let count = 0; count < LOGIN_FAILURE_LIMIT - 1; count += 1) {
      await throttle.recordFailure('203.0.113.10');
    }
    expect(await throttle.isLocked('203.0.113.10')).toBe(false);

    await throttle.recordFailure('203.0.113.10');

    expect(await throttle.isLocked('203.0.113.10')).toBe(true);
    expect(await throttle.isLocked('203.0.113.11')).toBe(false);
  });

  it('制限の時間が過ぎたら、制限を解く。古い失敗は、数えない', async () => {
    const { throttle, clock } = await throttleWithClock();
    for (let count = 0; count < LOGIN_FAILURE_LIMIT; count += 1) {
      await throttle.recordFailure('203.0.113.10');
    }

    clock.advance(LOGIN_FAILURE_WINDOW_MINUTES * MS_PER_MINUTE + 1);

    expect(await throttle.isLocked('203.0.113.10')).toBe(false);
    await throttle.recordFailure('203.0.113.10');
    expect(await throttle.isLocked('203.0.113.10')).toBe(false);
  });

  it('リセットすると、失敗の回数が 0 に戻る。記録のない接続元の、リセットは、エラーにしない', async () => {
    const { throttle } = await throttleWithClock();
    for (let count = 0; count < LOGIN_FAILURE_LIMIT; count += 1) {
      await throttle.recordFailure('203.0.113.10');
    }

    await throttle.reset('203.0.113.10');
    await throttle.reset('203.0.113.99');

    expect(await throttle.isLocked('203.0.113.10')).toBe(false);
  });

  it('制限を超えたあとに、失敗を記録し続けても、記録は、制限の回数までしか持たない（回数が、増え続けない）', async () => {
    const { throttle, clock } = await throttleWithClock();
    for (let count = 0; count < LOGIN_FAILURE_LIMIT + 5; count += 1) {
      await throttle.recordFailure('203.0.113.10');
      clock.advance(1);
    }

    expect(await throttle.isLocked('203.0.113.10')).toBe(true);
    clock.advance(LOGIN_FAILURE_WINDOW_MINUTES * MS_PER_MINUTE);
    expect(await throttle.isLocked('203.0.113.10')).toBe(false);
  });
});

describe('Cognito の認証の組み立てと、最初のユーザーを作るコマンド', () => {
  const PASSWORD = 'Dummy-Passw0rd-1';

  function environment(extra: Record<string, string> = {}) {
    const database = createDynamoTestDatabase();
    const options = dynamoTestClientOptions();
    const env: Record<string, string> = {
      APP_MODE: 'test',
      AUTH_PROVIDER: 'cognito',
      PERSISTENCE: 'dynamodb',
      DYNAMODB_ENDPOINT: options.endpoint ?? '',
      DYNAMODB_OBSERVATIONS_TABLE: database.tables.observations,
      DYNAMODB_MAIN_TABLE: database.tables.main,
      COGNITO_USER_POOL_ID: 'pool-1',
      COGNITO_CLIENT_ID: 'client-1',
      ...extra,
    };
    return { env, ready: database.ready };
  }

  function initialUserEnv(extra: Record<string, string> = {}) {
    return {
      INITIAL_USER_ID: 'first-user',
      INITIAL_USER_NAME: '最初のユーザー',
      INITIAL_USER_PASSWORD: PASSWORD,
      ...extra,
    };
  }

  function output() {
    const lines: string[] = [];
    return {
      lines,
      info: (message: string) => lines.push(`info: ${message}`),
      error: (message: string) => lines.push(`error: ${message}`),
    };
  }

  function fakeCognito() {
    return createFakeCognito({ userPoolId: 'pool-1', clientId: 'client-1', now: () => new Date() });
  }

  it('最初のユーザーを作り（Cognito と DynamoDB の両方）、そのユーザーで、ログイン・更新・ユーザー管理ができる', async () => {
    const { env, ready } = environment();
    await ready;
    const fake = fakeCognito();
    const out = output();

    const exitCode = await runInitialUserCli({ ...env, ...initialUserEnv() }, out, {
      cognitoClient: fake,
    });

    expect(exitCode).toBe(0);
    expect(out.lines).toEqual(['info: 最初のユーザー（first-user）を作成しました']);
    expect(out.lines.join('')).not.toContain(PASSWORD);
    expect(fake.hasPassword('first-user')).toBe(true);

    const container = createContainer(parseConfig(env), { cognitoClient: fake });
    try {
      const login = await container.authService.login('first-user', PASSWORD, 'client-a');
      expect(login.user).toMatchObject({ userId: 'first-user', userName: '最初のユーザー' });
      expect(login.user.permissions).toContain('user:manage');
      expect(await container.authService.authenticate(login.accessToken)).toMatchObject({
        userId: 'first-user',
      });
      const refreshed = await container.authService.refresh(login.refreshToken);
      expect(refreshed.user.userId).toBe('first-user');

      await container.userService.create(
        {
          userId: toUserId('second-user'),
          userName: '2 人目',
          password: 'Dummy-Passw0rd-2',
          role: 'worker',
        },
        toUserId('first-user'),
      );
      const second = await container.authService.login(
        'second-user',
        'Dummy-Passw0rd-2',
        'client-a',
      );
      expect(second.user.userName).toBe('2 人目');
      expect((await container.repositories.users.list()).map((user) => user.passwordHash)).toEqual([
        undefined,
        undefined,
      ]);
      expect(container.dev).toBeUndefined();
      await container.authService.logout(login.accessToken);
      expect(await container.authService.authenticate(login.accessToken)).toBeNull();
    } finally {
      container.close();
    }
  });

  it('実際の Cognito に近い長さのトークンで、API のログイン・更新・認証つきの呼び出しができる（Issue #95）', async () => {
    const { env, ready } = environment();
    await ready;
    const fake = fakeCognito();
    await runInitialUserCli({ ...env, ...initialUserEnv() }, output(), { cognitoClient: fake });
    const container = createContainer(parseConfig(env), { cognitoClient: fake });
    try {
      const app = createApp(container);
      const request = (path: string, token: string | undefined, body?: unknown) =>
        app.request(`/api/v1${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

      const login = await request('/auth/login', undefined, {
        userId: 'first-user',
        password: PASSWORD,
      });
      const session = (await login.json()) as { accessToken: string; refreshToken: string };
      const refreshed = await request('/auth/refresh', undefined, {
        refreshToken: session.refreshToken,
      });
      const renewed = (await refreshed.json()) as { accessToken: string };
      const users = await request('/users', renewed.accessToken);

      // 実際の Cognito に近い長さ（短いトークンでは、入力の長さの上限の不具合を、見つけられない）
      expect(session.refreshToken.length).toBeGreaterThan(1000);
      expect(session.accessToken.length).toBeGreaterThan(900);
      expect(login.status).toBe(200);
      expect(refreshed.status).toBe(200);
      expect(users.status).toBe(200);
    } finally {
      container.close();
    }
  });

  it('ユーザーが 1 人でもいれば、何もしない（何度実行しても、既存のユーザーを上書きしない）', async () => {
    const { env, ready } = environment();
    await ready;
    const fake = fakeCognito();
    await runInitialUserCli({ ...env, ...initialUserEnv() }, output(), { cognitoClient: fake });
    const createCalls = fake.calls.filter(
      (call) => call.command === 'AdminCreateUserCommand',
    ).length;
    const out = output();

    const exitCode = await runInitialUserCli(
      { ...env, ...initialUserEnv({ INITIAL_USER_ID: 'another-user' }) },
      out,
      { cognitoClient: fake },
    );

    expect(exitCode).toBe(0);
    expect(out.lines).toEqual(['info: ユーザーがすでにいるため、何もしませんでした']);
    expect(fake.calls.filter((call) => call.command === 'AdminCreateUserCommand')).toHaveLength(
      createCalls,
    );
    expect(fake.hasUser('another-user')).toBe(false);
  });

  it('指定の不足・Cognito でない設定・パスワードの条件に合わない値は、エラー（終了コード 1）。パスワードは、出力しない', async () => {
    const { env } = environment();
    const fake = fakeCognito();
    const run = async (variables: Record<string, string>) => {
      const out = output();
      const exitCode = await runInitialUserCli(variables, out, { cognitoClient: fake });
      return { exitCode, text: out.lines.join('\n') };
    };

    const missing = await run({ ...env });
    const notCognito = await run({ ...initialUserEnv() });
    const weak = await run({ ...env, ...initialUserEnv({ INITIAL_USER_PASSWORD: 'weak' }) });

    expect(missing.exitCode).toBe(1);
    expect(missing.text).toContain('INITIAL_USER_ID');
    expect(notCognito.exitCode).toBe(1);
    expect(notCognito.text).toContain('AUTH_PROVIDER=cognito');
    expect(weak.exitCode).toBe(1);
    expect(weak.text).toContain('パスワードの条件');
    expect(weak.text).not.toContain('weak');
  });

  it('AWS のエラーは、名前だけを出力する（メッセージの、アカウント ID・ARN を、出力しない）', async () => {
    const { env, ready } = environment();
    await ready;
    const fake = fakeCognito();
    fake.failNext(
      'AdminCreateUserCommand',
      cognitoError(
        'AccessDeniedException',
        'User: arn:aws:sts::123456789012:assumed-role/example/example is not authorized',
      ),
    );
    const out = output();

    const exitCode = await runInitialUserCli({ ...env, ...initialUserEnv() }, out, {
      cognitoClient: fake,
    });

    expect(exitCode).toBe(1);
    expect(out.lines.join('\n')).toContain('AccessDeniedException');
    expect(out.lines.join('\n')).not.toContain('123456789012');
    expect(out.lines.join('\n')).not.toContain(PASSWORD);
  });

  it('Error でない値が投げられても、エラーとして、終了コード 1 にする', async () => {
    const { env, ready } = environment();
    await ready;
    const fake = fakeCognito();
    fake.failNext('AdminCreateUserCommand', 'boom' as unknown as Error);
    const out = output();

    const exitCode = await runInitialUserCli({ ...env, ...initialUserEnv() }, out, {
      cognitoClient: fake,
    });

    expect(exitCode).toBe(1);
    expect(out.lines.join('\n')).toContain('不明なエラー');
  });
});
