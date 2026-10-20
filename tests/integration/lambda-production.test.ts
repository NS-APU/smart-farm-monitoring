/**
 * Lambda のハンドラを、本番の設定（APP_MODE=production・DynamoDB・Cognito）で動かす結合テスト（Issue #75。ADR-0009）。
 * DynamoDB は DynamoDB Local、Cognito は偽の Cognito（実際の AWS には、接続しない）。
 * CloudFront → 関数の URL → Lambda の経路の、X-Forwarded-For の扱い（TRUSTED_PROXY_HOPS=2）も確かめる。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { LOGIN_FAILURE_LIMIT } from '../../src/backend/infrastructure/common/auth-policy.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { runInitialUserCli } from '../../src/backend/runtime/initial-user-cli.ts';
import { createLambdaHandler } from '../../src/backend/runtime/lambda.ts';
import { createFakeCognito } from '../support/fake-cognito.ts';
import {
  createDynamoTestDatabase,
  dropDynamoTestTables,
  dynamoTestClientOptions,
} from '../support/dynamodb-test-database.ts';

afterAll(dropDynamoTestTables);

const PASSWORD = 'Dummy-Passw0rd-1';
// インフラ（evaluation-stack.ts の CLIENT_IP_HEADER）と同じ値。CloudFront Function が、利用者の IP を入れる
const CLIENT_IP_HEADER = 'x-sfm-viewer-ip';

interface LambdaResponse {
  readonly statusCode: number;
  readonly body: string;
}

function functionUrlEvent(
  method: string,
  path: string,
  options: {
    body?: unknown;
    token?: string;
    forwardedFor?: string;
    headers?: Record<string, string>;
    sourceIp?: string;
  } = {},
) {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: {
      host: 'example.invalid',
      'content-type': 'application/json',
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.forwardedFor === undefined ? {} : { 'x-forwarded-for': options.forwardedFor }),
      ...options.headers,
    },
    requestContext: {
      accountId: 'anonymous',
      apiId: 'dummy',
      authentication: null,
      authorizer: {},
      domainName: 'example.invalid',
      domainPrefix: 'example',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: options.sourceIp ?? '192.0.2.99',
        userAgent: 'test',
      },
      requestId: 'dummy-request',
      routeKey: '$default',
      stage: '$default',
      time: '09/Oct/2026:03:00:00 +0000',
      timeEpoch: 0,
    },
    body: options.body === undefined ? null : JSON.stringify(options.body),
    isBase64Encoded: false,
  };
}

async function productionHandler() {
  const database = createDynamoTestDatabase();
  await database.ready;
  const fake = createFakeCognito({
    userPoolId: 'pool-1',
    clientId: 'client-1',
    now: () => new Date(),
  });
  const env: Record<string, string> = {
    APP_MODE: 'production',
    AUTH_PROVIDER: 'cognito',
    PERSISTENCE: 'dynamodb',
    DYNAMODB_ENDPOINT: dynamoTestClientOptions().endpoint ?? '',
    DYNAMODB_OBSERVATIONS_TABLE: database.tables.observations,
    DYNAMODB_MAIN_TABLE: database.tables.main,
    COGNITO_USER_POOL_ID: 'pool-1',
    COGNITO_CLIENT_ID: 'client-1',
    CLIENT_IP_HEADER,
    LOG_LEVEL: 'error',
  };
  // 最初のユーザーは、Lambda ではなく、手元で `pnpm initial-user` を実行して作る（ADR-0008）
  await runInitialUserCli(
    {
      ...env,
      APP_MODE: 'test',
      INITIAL_USER_ID: 'first-user',
      INITIAL_USER_NAME: '最初のユーザー',
      INITIAL_USER_PASSWORD: PASSWORD,
    },
    { info: () => undefined, error: () => undefined },
    { cognitoClient: fake },
  );
  const handler = createLambdaHandler(env, {
    createContainer: (config, overrides) =>
      createContainer(config, { ...overrides, cognitoClient: fake }),
  });
  const call = async (
    method: string,
    path: string,
    options: Parameters<typeof functionUrlEvent>[2] = {},
  ) => (await handler(functionUrlEvent(method, path, options))) as LambdaResponse;
  return { call };
}

describe('Lambda のハンドラ（本番の設定: DynamoDB・Cognito）', () => {
  it('/health に答え、ログイン → 認証つきの呼び出し → 更新 → ログアウトが、できる', async () => {
    const { call } = await productionHandler();

    const health = await call('GET', '/health');
    const login = await call('POST', '/api/v1/auth/login', {
      body: { userId: 'first-user', password: PASSWORD },
    });
    const session = JSON.parse(login.body) as { accessToken: string; refreshToken: string };
    const users = await call('GET', '/api/v1/users', { token: session.accessToken });
    const refreshed = await call('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: session.refreshToken },
    });
    const logout = await call('POST', '/api/v1/auth/logout', { token: session.accessToken });
    const afterLogout = await call('GET', '/api/v1/users', { token: session.accessToken });

    expect(health.statusCode).toBe(200);
    expect(login.statusCode).toBe(200);
    expect(users.statusCode).toBe(200);
    expect(JSON.parse(users.body)).toMatchObject({ items: [{ userId: 'first-user' }] });
    expect(refreshed.statusCode).toBe(200);
    expect(logout.statusCode).toBeLessThan(300);
    expect(afterLogout.statusCode).toBe(401);
  });

  it('開発用 API は、登録されない。デモデータは、投入されない（ユーザー以外の設備もない）', async () => {
    const { call } = await productionHandler();
    const login = await call('POST', '/api/v1/auth/login', {
      body: { userId: 'first-user', password: PASSWORD },
    });
    const { accessToken } = JSON.parse(login.body) as { accessToken: string };

    const dev = await call('GET', '/api/v1/dev/clock', { token: accessToken });
    const reset = await call('POST', '/api/v1/dev/reset', { token: accessToken });
    const equipment = await call('GET', '/api/v1/equipment', { token: accessToken });

    expect(dev.statusCode).toBe(404);
    expect(reset.statusCode).toBe(404);
    expect(equipment.statusCode).toBe(200);
    expect(JSON.parse(equipment.body)).toMatchObject({ facilities: [] });
  });

  it('ログインの試行回数の制限は、利用者の IP（CloudFront Function が入れるヘッダー）ごと。関数の URL が切り詰める X-Forwarded-For・エッジごとに変わる接続元には、よらない（Issue #100）', async () => {
    const { call } = await productionHandler();
    // 関数の URL は、X-Forwarded-For を、最初の 1 つ（利用者が付けられる値）に切り詰める。接続元（sourceIp）は、CloudFront のエッジの IP で、リクエストごとに変わる
    const login = (password: string, viewerIp: string, edgeIp: string) =>
      call('POST', '/api/v1/auth/login', {
        body: { userId: 'first-user', password },
        forwardedFor: `192.0.2.${edgeIp}`,
        headers: { [CLIENT_IP_HEADER]: viewerIp },
        sourceIp: `203.0.113.${edgeIp}`,
      });
    for (let count = 0; count < LOGIN_FAILURE_LIMIT; count += 1) {
      await login('wrong', '198.51.100.10', String(count + 1));
    }

    const blocked = await login(PASSWORD, '198.51.100.10', '200');
    const otherViewer = await login(PASSWORD, '198.51.100.11', '200');

    expect(blocked.statusCode).toBe(429);
    expect(otherViewer.statusCode).toBe(200);
  });
});
