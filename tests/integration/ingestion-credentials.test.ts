/**
 * ファイルサーバーの認証情報の登録（Issue #207。D-47。UC-15。FR-1.4）の結合テスト。
 * 書き込み専用（保存後は、値を再表示しない）。「設定済み／未設定」と更新日時だけを示す。
 * 値（パスワード・トークン・API キー）は、画面・API の応答・ログ・エラー・変更履歴のどこにも残さない。
 * 認証情報は、明らかにダミーとわかる値。
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import { IngestionSettingsResponseSchema } from '@smart-farm/shared/schemas/ingestion';
import { createJsonLogger } from '../../src/backend/infrastructure/logging/json-logger.ts';
import { equipmentSet } from '../support/builders.ts';
import {
  addUserAndLogin,
  createTestContext,
  errorOf,
  THREE_ROLES_JSON,
  type TestContext,
} from '../support/test-context.ts';

const DUMMY_PASSWORD = 'dummy-password-0123';
const DUMMY_TOKEN = 'dummy-token-4567';
const DUMMY_API_KEY = 'dummy-api-key-89ab';

const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(
  respond: (request: IncomingMessage) => number,
): Promise<{ port: number }> {
  const server = createServer((request, response) => {
    response.writeHead(respond(request));
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port };
}

interface Harness {
  readonly context: TestContext;
  readonly logs: string[];
}

async function setup(env: Record<string, string> = {}): Promise<Harness> {
  const logs: string[] = [];
  const logger = createJsonLogger({
    sink: { write: (line: string) => logs.push(line) },
    minimumLevel: 'debug',
  });
  const context = await createTestContext({
    env: { HTTP_FILE_SOURCE_ALLOW_PRIVATE: 'true', ...env },
    logger,
  });
  return { context, logs };
}

function send(context: TestContext, method: string, path: string, body?: unknown, token?: string) {
  return context.request(path, {
    method,
    ...(body === undefined ? {} : { body }),
    ...(token === undefined ? {} : { token }),
  });
}

function connection(authMethod: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'HTTP',
    protocol: 'HTTP',
    host: '127.0.0.1',
    port: 8080,
    authMethod,
    ...overrides,
  };
}

async function configure(
  context: TestContext,
  authMethod: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await send(context, 'PUT', '/ingestion/settings', {
    sources: [
      {
        sourceId: 'robot',
        connectionRef: 'FILE_SERVER_MOCK',
        intervalMinutes: 15,
        isEnabled: true,
        connection: connection(authMethod, overrides),
      },
    ],
  });
  expect(response.status).toBe(200);
}

async function credentialsOf(context: TestContext, sourceId = 'robot') {
  const body = IngestionSettingsResponseSchema.parse(
    await (await send(context, 'GET', '/ingestion/settings')).json(),
  );
  return body.sources.find((source) => source.sourceId === sourceId)?.credentials;
}

describe('状態（設定済み／未設定）', () => {
  it('モック・認証なしは、認証情報が不要（NOT_REQUIRED）', async () => {
    const { context } = await setup();

    expect(await credentialsOf(context)).toEqual({ state: 'NOT_REQUIRED' });
    await configure(context, 'NONE');
    expect(await credentialsOf(context)).toEqual({ state: 'NOT_REQUIRED' });
  });

  it('認証方式があり、まだ登録していなければ、未設定（NOT_CONFIGURED）', async () => {
    const { context } = await setup();
    await configure(context, 'BASIC');

    expect(await credentialsOf(context)).toEqual({ state: 'NOT_CONFIGURED' });
  });

  it('登録すると、設定済み（CONFIGURED）と更新日時を示す。上書きで、更新日時が変わる', async () => {
    const { context } = await setup();
    await configure(context, 'BEARER');

    const first = await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });
    const firstStatus = await credentialsOf(context);
    context.clock.advance(60_000);
    await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BEARER',
      token: `${DUMMY_TOKEN}-2`,
    });
    const secondStatus = await credentialsOf(context);

    expect(first.status).toBe(200);
    expect(firstStatus).toMatchObject({ state: 'CONFIGURED' });
    expect(firstStatus?.updatedAt).toBeDefined();
    expect(secondStatus?.updatedAt).not.toBe(firstStatus?.updatedAt);
  });
});

describe('登録（書き込み専用）', () => {
  it('Basic: ユーザー名・パスワードを、秘密情報の保管先に、JSON で保存する。応答は、状態だけ（値を含めない）', async () => {
    const { context } = await setup();
    await configure(context, 'BASIC');

    const response = await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BASIC',
      username: 'dummy-user',
      password: DUMMY_PASSWORD,
    });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ state: 'CONFIGURED' });
    expect(text).not.toContain(DUMMY_PASSWORD);
    expect(text).not.toContain('dummy-user');
    expect(JSON.parse((await context.container.secrets.get('file-server/robot')) ?? '')).toEqual({
      username: 'dummy-user',
      password: DUMMY_PASSWORD,
    });
  });

  it('Bearer・API キー: 文字列を保存する', async () => {
    const { context } = await setup();
    await configure(context, 'BEARER');
    await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });
    expect(await context.container.secrets.get('file-server/robot')).toBe(DUMMY_TOKEN);

    await configure(context, 'API_KEY');
    await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'API_KEY',
      apiKey: DUMMY_API_KEY,
    });
    expect(await context.container.secrets.get('file-server/robot')).toBe(DUMMY_API_KEY);
  });

  it('取り込み元ごとに、別の保存名（もう一方の取り込み元は、変わらない）', async () => {
    const { context } = await setup();
    await configure(context, 'BEARER');

    await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });

    expect(await context.container.secrets.get('file-server/environment-sensor')).toBeUndefined();
  });

  it('登録した認証情報で、接続テストが成功する（保存から、接続まで）', async () => {
    const { context } = await setup();
    // 接続テストは、ファイルパスが設定された設備のファイルで行う（ADR-0023）
    const robot = equipmentSet().find((item) => item.equipmentType === 'ROBOT');
    if (robot === undefined) {
      throw new Error('テストの前提');
    }
    await context.container.repositories.equipment.save({
      ...robot,
      sourceFilePath: '/data/robot-01.json',
    });
    const seen: (string | undefined)[] = [];
    const server = await startServer((request) => {
      seen.push(request.headers.authorization);
      return request.headers.authorization ===
        `Basic ${Buffer.from(`dummy-user:${DUMMY_PASSWORD}`).toString('base64')}`
        ? 200
        : 401;
    });
    await configure(context, 'BASIC', { port: server.port });
    const before = await (await send(context, 'POST', '/ingestion/robot/test')).json();
    await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BASIC',
      username: 'dummy-user',
      password: DUMMY_PASSWORD,
    });

    const after = await (await send(context, 'POST', '/ingestion/robot/test')).json();

    expect((before as { ok: boolean; message: string }).message).toContain(
      '認証情報が設定されていません',
    );
    expect(after).toEqual({ ok: true, message: '接続できました' });
    expect(seen).toHaveLength(1);
  });
});

describe('入力の検証', () => {
  it.each([
    [
      '認証方式が、保存済みの設定と違う',
      'BASIC',
      { authMethod: 'BEARER', token: DUMMY_TOKEN },
      'authMethod',
    ],
    [
      'ユーザー名が空',
      'BASIC',
      { authMethod: 'BASIC', username: '', password: DUMMY_PASSWORD },
      'username',
    ],
    [
      'ユーザー名に : を含む',
      'BASIC',
      { authMethod: 'BASIC', username: 'a:b', password: DUMMY_PASSWORD },
      'username',
    ],
    ['パスワードが空', 'BASIC', { authMethod: 'BASIC', username: 'u', password: '' }, 'password'],
    ['トークンが空', 'BEARER', { authMethod: 'BEARER', token: '' }, 'token'],
    ['トークンに空白を含む', 'BEARER', { authMethod: 'BEARER', token: 'dummy token' }, 'token'],
    [
      'トークンに改行を含む（ヘッダーの注入）',
      'BEARER',
      { authMethod: 'BEARER', token: 'dummy\r\nX-Evil: 1' },
      'token',
    ],
    ['トークンに日本語を含む', 'BEARER', { authMethod: 'BEARER', token: 'ダミー' }, 'token'],
    ['トークンが長すぎる', 'BEARER', { authMethod: 'BEARER', token: 'a'.repeat(2001) }, 'token'],
    ['API キーが空', 'API_KEY', { authMethod: 'API_KEY', apiKey: '' }, 'apiKey'],
    ['未知の認証方式', 'BASIC', { authMethod: 'DIGEST', token: DUMMY_TOKEN }, 'authMethod'],
    ['認証方式なし（NONE）には、登録できない', 'BASIC', { authMethod: 'NONE' }, 'authMethod'],
  ])('不正な入力（%s）は、保存せず、400。応答に値を含めない', async (_name, saved, body, field) => {
    const { context, logs } = await setup();
    await configure(context, saved);

    const response = await send(context, 'PUT', '/ingestion/robot/credentials', body);

    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).toContain(field);
    for (const value of [DUMMY_PASSWORD, DUMMY_TOKEN, 'X-Evil']) {
      expect(text).not.toContain(value);
    }
    expect(logs.join('\n')).not.toContain('X-Evil');
    expect(await context.container.secrets.get('file-server/robot')).toBeUndefined();
  });

  it('認証が不要な設定（モック・認証なし）には、登録できない', async () => {
    const { context } = await setup();
    const mock = await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });
    await configure(context, 'NONE');
    const none = await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });

    expect(mock.status).toBe(400);
    expect(none.status).toBe(400);
    expect(await context.container.secrets.get('file-server/robot')).toBeUndefined();
  });

  it('存在しない取り込み元は、404', async () => {
    const { context } = await setup();

    const response = await send(context, 'PUT', '/ingestion/unknown/credentials', {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });

    expect(response.status).toBe(404);
  });
});

describe('権限', () => {
  it('取り込みの設定の権限（ingestion:configure）がなければ、403。保存しない', async () => {
    const context = await createTestContext({
      env: { ROLE_DEFINITIONS_JSON: THREE_ROLES_JSON, HTTP_FILE_SOURCE_ALLOW_PRIVATE: 'true' },
    });
    await configure(context, 'BEARER');
    const viewer = await addUserAndLogin(context, { userId: 'viewer-1', role: 'viewer' });

    const response = await send(
      context,
      'PUT',
      '/ingestion/robot/credentials',
      { authMethod: 'BEARER', token: DUMMY_TOKEN },
      viewer,
    );

    expect(response.status).toBe(403);
    expect(await context.container.secrets.get('file-server/robot')).toBeUndefined();
  });
});

describe('値を残さない（画面・API の応答・ログ・エラー・変更履歴）', () => {
  it('変更履歴には、「認証情報を更新した」という事実だけを残す（値・認証方式以外の内容は、残さない）', async () => {
    const { context } = await setup();
    await configure(context, 'BASIC');

    await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BASIC',
      username: 'dummy-user',
      password: DUMMY_PASSWORD,
    });

    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?targetType=ingestion-settings')).json(),
    );
    const entry = audit.items.find((item) => item.targetId === 'credentials/robot');
    expect(entry).toMatchObject({ operation: 'UPDATE', after: { credentialsUpdated: true } });
    const text = JSON.stringify(audit);
    expect(text).not.toContain(DUMMY_PASSWORD);
    expect(text).not.toContain('dummy-user');
  });

  it('ログ（アクセスログ・アプリのログ）に、リクエストの本文の値を出さない', async () => {
    const { context, logs } = await setup();
    await configure(context, 'BASIC');

    await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BASIC',
      username: 'dummy-user',
      password: DUMMY_PASSWORD,
    });
    await send(context, 'POST', '/ingestion/robot/test');

    const text = logs.join('\n');
    expect(text).toContain('/ingestion/robot/credentials');
    expect(text).not.toContain(DUMMY_PASSWORD);
    expect(text).not.toContain('dummy-user');
  });

  it('秘密情報の保管先が失敗しても、エラー・ログに値を出さない', async () => {
    const { context, logs } = await setup();
    await configure(context, 'BEARER');
    vi.spyOn(context.container.secrets, 'set').mockRejectedValue(
      new Error(`AccessDenied ${DUMMY_TOKEN}`),
    );

    const response = await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });

    const text = await response.text();
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(text).not.toContain(DUMMY_TOKEN);
    expect(logs.join('\n')).not.toContain(DUMMY_TOKEN);
  });

  it('設定の取得（GET /ingestion/settings）の応答に、値を含めない', async () => {
    const { context } = await setup();
    await configure(context, 'BEARER');
    await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });

    const text = await (await send(context, 'GET', '/ingestion/settings')).text();

    expect(text).not.toContain(DUMMY_TOKEN);
  });

  it('状態を読み出せないとき（保管先の障害）は、UNAVAILABLE を示す（設定の画面は、読める）', async () => {
    const { context } = await setup();
    await configure(context, 'BEARER');
    vi.spyOn(context.container.secrets, 'status').mockRejectedValue(new Error('down'));

    const settings = await send(context, 'GET', '/ingestion/settings');

    expect(settings.status).toBe(200);
    expect(await credentialsOf(context)).toEqual({ state: 'UNAVAILABLE' });
  });
});

describe('エラーの形式', () => {
  it('検証のエラーは、項目名を返す（画面が、項目に表示する）', async () => {
    const { context } = await setup();
    await configure(context, 'BASIC');

    const response = await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BASIC',
      username: '',
      password: '',
    });

    expect((await errorOf(response)).fields?.map((field) => field.name)).toEqual(
      expect.arrayContaining(['username', 'password']),
    );
  });
});
