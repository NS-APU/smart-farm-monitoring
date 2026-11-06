/**
 * ファイルサーバーの接続設定（HTTP）の結合テスト（Issue #172・#119。ADR-0022・ADR-0023。UC-15）。
 * 取り込み設定の保存（検証・変更履歴）と、接続テスト・取り込み（手元の HTTP サーバー・秘密情報・認証方式・設備ごとのファイルパス）を、API を通して確かめる。
 * 認証情報は、明らかにダミーとわかる値。内部のアドレスは、既定で拒否する（HTTP_FILE_SOURCE_ALLOW_PRIVATE で、テストだけ許可）。
 */

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import { IngestionSettingsResponseSchema } from '@smart-farm/shared/schemas/ingestion';
import { ROBOT_ID, equipmentSet } from '../support/builders.ts';
import { STUB_MODIFIED_AT } from '../support/test-constants.ts';
import {
  createTestContext,
  errorOf,
  withEquipment,
  type TestContext,
} from '../support/test-context.ts';

const servers: Server[] = [];

async function startServer(
  respond: (request: IncomingMessage) => { status: number },
): Promise<{ port: number; requests: IncomingMessage['headers'][] }> {
  const requests: IncomingMessage['headers'][] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    response.writeHead(respond(request).status);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

afterEach(async () => {
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

function send(context: TestContext, method: string, path: string, body?: unknown) {
  return context.request(path, { method, ...(body === undefined ? {} : { body }) });
}

function httpConnection(overrides: Record<string, unknown> = {}) {
  return {
    type: 'HTTP',
    protocol: 'HTTPS',
    host: 'fileserver.example.ac.jp',
    authMethod: 'BASIC',
    ...overrides,
  };
}

function update(context: TestContext, connection?: unknown) {
  return send(context, 'PUT', '/ingestion/settings', {
    sources: [
      {
        sourceId: 'robot',
        connectionRef: 'FILE_SERVER_MOCK',
        intervalMinutes: 15,
        isEnabled: true,
        ...(connection === undefined ? {} : { connection }),
      },
    ],
  });
}

/** 設備（ロボット）に、ファイルパスを設定する（取得するファイルは、設備ごと。ADR-0023）。 */
async function withRobotFilePath(context: TestContext, sourceFilePath: string): Promise<void> {
  const robot = equipmentSet().find((item) => item.equipmentType === 'ROBOT');
  if (robot === undefined) {
    throw new Error('テストの前提');
  }
  await context.container.repositories.equipment.save({ ...robot, sourceFilePath });
}

async function robotSource(context: TestContext) {
  const body = IngestionSettingsResponseSchema.parse(
    await (await send(context, 'GET', '/ingestion/settings')).json(),
  );
  return body.sources[0];
}

describe('接続設定の保存', () => {
  it('既定の取り込み元は、接続方式 MOCK', async () => {
    const context = await withEquipment();

    expect((await robotSource(context))?.connection).toEqual({ type: 'MOCK' });
  });

  it('HTTP の接続設定を保存でき、変更履歴に残る。値（パスワードなど）は、含まれない', async () => {
    const context = await withEquipment();

    const response = await update(context, httpConnection({ port: 8443 }));

    expect(response.status).toBe(200);
    expect((await robotSource(context))?.connection).toEqual({
      type: 'HTTP',
      protocol: 'HTTPS',
      host: 'fileserver.example.ac.jp',
      port: 8443,
      authMethod: 'BASIC',
      apiKeyHeaderName: 'X-API-Key',
    });
    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?targetType=ingestion-settings')).json(),
    );
    expect(audit.items).toHaveLength(1);
    expect(JSON.stringify(audit.items[0]?.after)).toContain('fileserver.example.ac.jp');
  });

  it('connection を省略すると、現在の接続設定を保つ', async () => {
    const context = await withEquipment();
    await update(context, httpConnection());

    const response = await update(context);

    expect(response.status).toBe(200);
    expect((await robotSource(context))?.connection).toMatchObject({
      type: 'HTTP',
      host: 'fileserver.example.ac.jp',
    });
  });

  it('MOCK に戻せる', async () => {
    const context = await withEquipment();
    await update(context, httpConnection());

    await update(context, { type: 'MOCK' });

    expect((await robotSource(context))?.connection).toEqual({ type: 'MOCK' });
  });

  it.each([
    ['スキームを含むホスト', { host: 'https://fileserver.example.ac.jp' }, 'host'],
    ['ポートの範囲外', { port: 70000 }, 'port'],
    ['未知の認証方式', { authMethod: 'DIGEST' }, 'authMethod'],
    [
      '予約済みの API キーのヘッダー名',
      { authMethod: 'API_KEY', apiKeyHeaderName: 'Host' },
      'apiKeyHeaderName',
    ],
  ])('不正な接続設定（%s）は、保存しない', async (_name, override, field) => {
    const context = await withEquipment();

    const response = await update(context, httpConnection(override));

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((item) => item.name)).toContain(
      `sources.0.connection.${field}`,
    );
    expect((await robotSource(context))?.connection).toEqual({ type: 'MOCK' });
  });

  it.each([
    ['ループバック', '127.0.0.1'],
    ['AWS のメタデータ', '169.254.169.254'],
    ['プライベート', '192.168.0.10'],
    ['localhost', 'localhost'],
    ['内部の名前', 'files.internal'],
    ['IPv6 のループバック', '[::1]'],
  ])('内部のアドレス（%s）は、接続先に指定できない（SSRF の対策）', async (_name, host) => {
    const context = await withEquipment();

    const response = await update(context, httpConnection({ host }));

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((item) => item.name)).toContain(
      'sources.0.connection.host',
    );
    expect((await robotSource(context))?.connection).toEqual({ type: 'MOCK' });
  });

  it('HTTP_FILE_SOURCE_ALLOW_PRIVATE を指定すると、内部のアドレスも指定できる（ローカル・テスト用）', async () => {
    const context = await createTestContext({ env: { HTTP_FILE_SOURCE_ALLOW_PRIVATE: 'true' } });

    const response = await update(context, httpConnection({ host: '127.0.0.1' }));

    expect(response.status).toBe(200);
  });
});

describe('接続テスト（HTTP）', () => {
  async function setup(status: number | ((request: IncomingMessage) => number)) {
    const context = await withEquipment({ env: { HTTP_FILE_SOURCE_ALLOW_PRIVATE: 'true' } });
    await withRobotFilePath(context, '/data/robot-01.json');
    const server = await startServer((request) => ({
      status: typeof status === 'function' ? status(request) : status,
    }));
    return { context, server };
  }

  function configure(context: TestContext, port: number, overrides: Record<string, unknown> = {}) {
    return update(
      context,
      httpConnection({ protocol: 'HTTP', host: '127.0.0.1', port, ...overrides }),
    );
  }

  it('認証なし: 接続できれば、成功', async () => {
    const { context, server } = await setup(200);
    await configure(context, server.port, { authMethod: 'NONE' });

    const response = await send(context, 'POST', '/ingestion/robot/test');

    expect(await response.json()).toEqual({ ok: true, message: '接続できました' });
    expect(server.requests[0]?.authorization).toBeUndefined();
  });

  it('Basic 認証: 秘密情報のユーザー名・パスワードで、接続できる', async () => {
    const { context, server } = await setup(200);
    await configure(context, server.port, { authMethod: 'BASIC' });
    await context.container.secrets.set(
      'file-server/robot',
      JSON.stringify({ username: 'dummy-user', password: 'dummy-pass' }),
    );

    const response = await send(context, 'POST', '/ingestion/robot/test');

    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
    expect(server.requests[0]?.authorization).toBe(
      `Basic ${Buffer.from('dummy-user:dummy-pass').toString('base64')}`,
    );
  });

  it('Bearer トークン・API キーも、送れる', async () => {
    const { context, server } = await setup(200);
    await context.container.secrets.set('file-server/robot', 'dummy-token');

    await configure(context, server.port, { authMethod: 'BEARER' });
    await send(context, 'POST', '/ingestion/robot/test');
    await configure(context, server.port, {
      authMethod: 'API_KEY',
      apiKeyHeaderName: 'X-Auth-Token',
    });
    await send(context, 'POST', '/ingestion/robot/test');

    expect(server.requests[0]?.authorization).toBe('Bearer dummy-token');
    expect(server.requests[1]?.['x-auth-token']).toBe('dummy-token');
  });

  it('認証情報が未設定なら、接続せずに、理由を示す（値・接続先を含めない）', async () => {
    const { context, server } = await setup(200);
    await configure(context, server.port, { authMethod: 'BASIC' });

    const response = await send(context, 'POST', '/ingestion/robot/test');

    const body = (await response.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain('認証情報が設定されていません');
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    [401, '認証に失敗しました'],
    [404, 'ファイルが見つかりません'],
    [500, 'ファイルサーバーがエラーを返しました'],
    [302, 'リダイレクトには従いません'],
  ])(
    'HTTP %i は、失敗の理由を示す（接続先・ファイルパス・認証情報を含めない）',
    async (status, text) => {
      const { context, server } = await setup(status);
      await configure(context, server.port, { authMethod: 'BEARER' });
      await context.container.secrets.set('file-server/robot', 'dummy-token-value');

      const response = await send(context, 'POST', '/ingestion/robot/test');

      const body = (await response.json()) as { ok: boolean; message: string };
      expect(body.ok).toBe(false);
      expect(body.message).toContain(text);
      expect(body.message).not.toContain('dummy-token-value');
      expect(body.message).not.toContain('127.0.0.1');
      expect(body.message).not.toContain('/data/robot-01.json');
    },
  );

  it('認証情報を更新すると、すぐ、新しい値で接続できる（キャッシュに残った古い値で、失敗し続けない）', async () => {
    const { context, server } = await setup((request) =>
      request.headers.authorization === 'Bearer new-token' ? 200 : 401,
    );
    await configure(context, server.port, { authMethod: 'BEARER' });
    await context.container.secrets.set('file-server/robot', 'old-token');
    expect(
      ((await (await send(context, 'POST', '/ingestion/robot/test')).json()) as { ok: boolean }).ok,
    ).toBe(false);

    await context.container.secrets.set('file-server/robot', 'new-token');

    expect(
      ((await (await send(context, 'POST', '/ingestion/robot/test')).json()) as { ok: boolean }).ok,
    ).toBe(true);
  });

  it('内部のアドレスは、既定では、接続テストでも拒否する（保存済みの設定が、あとから内部のアドレスだった場合）', async () => {
    const context = await withEquipment({ env: { HTTP_FILE_SOURCE_ALLOW_PRIVATE: 'true' } });
    await withRobotFilePath(context, '/data/robot-01.json');
    const server = await startServer(() => ({ status: 200 }));
    await configure(context, server.port, { authMethod: 'NONE' });
    // 同じ保存済みの設定を、内部のアドレスを許可しない組み立てで読む（設備も、同じものにする）
    const strict = await withEquipment();
    await withRobotFilePath(strict, '/data/robot-01.json');
    await strict.container.repositories.settings.set(
      'ingestion.sources',
      await context.container.repositories.settings.get('ingestion.sources'),
    );

    const response = await send(strict, 'POST', '/ingestion/robot/test');

    const body = (await response.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain('内部のアドレスには接続できません');
    expect(server.requests).toHaveLength(0);
  });

  it('MOCK の取り込み元は、これまでどおり（ファイルサーバーのモックで接続テスト）', async () => {
    const context = await withEquipment();
    context.placeFile('robot', 'placeholder.txt', 'x');

    const response = await send(context, 'POST', '/ingestion/robot/test');

    expect(await response.json()).toEqual({ ok: true, message: '接続できました' });
  });
});

describe('取り込み（HTTP。設備ごとのファイルパス。Issue #119。ADR-0023）', () => {
  const ROBOT_FILE = readFileSync(
    new URL('../fixtures/file-server/robot/robot-sample-001.json', import.meta.url),
    'utf8',
  );
  const PATH = '/data/robot-01.json';
  const MODIFIED = STUB_MODIFIED_AT.toUTCString();

  interface FileEntry {
    content: string;
    lastModified?: string | undefined;
    /** HEAD の Content-Length を、実際の大きさと違う値にする（大きさの上限の確認用）。 */
    declaredSize?: number;
  }

  /** 設備のファイルを配信する、手元の HTTP サーバー。`authorization` を指定すると、その値が付いたリクエストだけを受け付ける。 */
  async function startFileServer(
    files: Map<string, FileEntry>,
    options: { authorization?: string } = {},
  ): Promise<{ port: number; requests: { method: string; url: string }[] }> {
    const requests: { method: string; url: string }[] = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method ?? '', url: request.url ?? '' });
      if (
        options.authorization !== undefined &&
        request.headers.authorization !== options.authorization
      ) {
        response.writeHead(401);
        response.end();
        return;
      }
      const file = files.get(request.url ?? '');
      if (file === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = Buffer.from(file.content, 'utf8');
      response.writeHead(200, {
        'Content-Length': String(file.declaredSize ?? body.length),
        ...(file.lastModified === undefined ? {} : { 'Last-Modified': file.lastModified }),
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, requests };
  }

  /** ロボットに、ファイルパスを設定し、取り込み元（ロボット）を、手元のサーバーの HTTP 接続にする。 */
  async function setup(
    files: Map<string, FileEntry>,
    options: { authorization?: string; connection?: Record<string, unknown> } = {},
  ) {
    const context = await withEquipment({ env: { HTTP_FILE_SOURCE_ALLOW_PRIVATE: 'true' } });
    const robot = equipmentSet().find((item) => item.equipmentType === 'ROBOT');
    if (robot === undefined) {
      throw new Error('テストの前提');
    }
    await context.container.repositories.equipment.save({ ...robot, sourceFilePath: PATH });
    const server = await startFileServer(files, options);
    await update(
      context,
      httpConnection({
        protocol: 'HTTP',
        host: '127.0.0.1',
        port: server.port,
        authMethod: 'NONE',
        ...options.connection,
      }),
    );
    return { context, server };
  }

  async function run(context: TestContext) {
    return (await send(context, 'POST', '/ingestion/robot/run')).json() as Promise<{
      result: string;
      recordCount: number;
      filesProcessed: number;
    }>;
  }

  /** 取り込んだ観測値（ロボットの 1 件目の収穫数）の値。取り込まれていなければ、undefined。 */
  async function importedHarvestCount(context: TestContext): Promise<unknown> {
    return (
      await context.container.repositories.observations.findByKey(
        ROBOT_ID,
        'harvestCount',
        '2026-10-09T01:00:00.000Z',
        'AUTO_IMPORT',
      )
    )?.value;
  }

  it('設備のファイルを取得して、取り込める。接続テストも、同じファイルで成功する', async () => {
    const { context, server } = await setup(
      new Map([[PATH, { content: ROBOT_FILE, lastModified: MODIFIED }]]),
    );

    const test = await (await send(context, 'POST', '/ingestion/robot/test')).json();
    const summary = await run(context);

    expect(test).toEqual({ ok: true, message: '接続できました' });
    expect(summary).toMatchObject({ result: 'SUCCESS', filesProcessed: 1 });
    expect(summary.recordCount).toBeGreaterThan(0);
    expect(await importedHarvestCount(context)).toBe(12);
    expect(server.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `HEAD ${PATH}`,
      `HEAD ${PATH}`,
      `GET ${PATH}`,
    ]);
  });

  it('Last-Modified を返さないサーバー（公開のサーバーなど）でも、取り込める（書き換え直後とみなして、回さない）', async () => {
    const { context } = await setup(new Map([[PATH, { content: ROBOT_FILE }]]));

    const summary = await run(context);

    expect(summary).toMatchObject({ result: 'SUCCESS', filesProcessed: 1 });
    expect(summary.recordCount).toBeGreaterThan(0);
  });

  it('内容が同じなら、取り込み直さない。ファイルが書き換わったら、変わった分だけ取り込む', async () => {
    const files = new Map<string, FileEntry>([
      [PATH, { content: ROBOT_FILE, lastModified: MODIFIED }],
    ]);
    const { context } = await setup(files);
    const first = await run(context);
    const valueAfterFirst = await importedHarvestCount(context);

    const second = await run(context);
    files.set(PATH, {
      content: ROBOT_FILE.replace('"harvestCount": 12', '"harvestCount": 99'),
      lastModified: MODIFIED,
    });
    const third = await run(context);

    expect(first.recordCount).toBeGreaterThan(0);
    expect(second.recordCount).toBe(0);
    expect(third.recordCount).toBe(1);
    expect(valueAfterFirst).toBe(12);
    expect(await importedHarvestCount(context)).toBe(99);
  });

  it('認証（Bearer）: 秘密情報のトークンを付けて取得する。トークンがなければ、取り込みは失敗として記録され、理由に値・接続先を含めない', async () => {
    const files = new Map<string, FileEntry>([
      [PATH, { content: ROBOT_FILE, lastModified: MODIFIED }],
    ]);
    const { context } = await setup(files, {
      authorization: 'Bearer dummy-token',
      connection: { authMethod: 'BEARER' },
    });

    const withoutSecret = await run(context);
    await context.container.secrets.set('file-server/robot', 'dummy-token');
    const withSecret = await run(context);

    expect(withoutSecret).toMatchObject({ result: 'FAILURE', recordCount: 0 });
    expect(withSecret).toMatchObject({ result: 'SUCCESS' });
    expect(withSecret.recordCount).toBeGreaterThan(0);
    const logs = (await (await send(context, 'GET', '/ingestion/logs')).json()) as {
      items: { errorMessage?: string }[];
    };
    const messages = logs.items.map((item) => item.errorMessage ?? '').join('\n');
    expect(messages).not.toContain('dummy-token');
    expect(messages).not.toContain('127.0.0.1');
    expect(messages).not.toContain(PATH);
  });

  it('認証情報が間違っている（401）とき: 取り込みは失敗として記録され、何も取り込まない', async () => {
    const { context } = await setup(
      new Map([[PATH, { content: ROBOT_FILE, lastModified: MODIFIED }]]),
      { authorization: 'Bearer right-token', connection: { authMethod: 'BEARER' } },
    );
    await context.container.secrets.set('file-server/robot', 'wrong-token');

    const summary = await run(context);

    expect(summary).toMatchObject({ result: 'FAILURE', recordCount: 0 });
    expect(await importedHarvestCount(context)).toBeUndefined();
  });

  it('サーバーにまだファイルがない設備は、取り込みの対象にならない（取り込む記録がなく、失敗にもしない）', async () => {
    const { context } = await setup(new Map());

    const summary = await run(context);

    expect(summary).toMatchObject({ result: 'SUCCESS', recordCount: 0, filesProcessed: 0 });
  });

  it('大きさの上限（10 MiB）を超えるファイルは、取得せずに、失敗として扱う', async () => {
    const { context, server } = await setup(
      new Map([[PATH, { content: '{}', lastModified: MODIFIED, declaredSize: 11 * 1024 * 1024 }]]),
    );

    const summary = await run(context);

    expect(summary.recordCount).toBe(0);
    expect(summary.result).toBe('FAILURE');
    expect(server.requests.some((request) => request.method === 'GET')).toBe(false);
  });

  it('ファイルパスが設定された設備がなければ、接続テストは、その旨で失敗する（接続しない）', async () => {
    const context = await withEquipment({ env: { HTTP_FILE_SOURCE_ALLOW_PRIVATE: 'true' } });
    const server = await startFileServer(new Map());
    await update(
      context,
      httpConnection({
        protocol: 'HTTP',
        host: '127.0.0.1',
        port: server.port,
        authMethod: 'NONE',
      }),
    );

    const body = (await (await send(context, 'POST', '/ingestion/robot/test')).json()) as {
      ok: boolean;
      message: string;
    };

    expect(body.ok).toBe(false);
    expect(body.message).toContain('ファイルパスが設定された設備がありません');
    expect(server.requests).toHaveLength(0);
  });
});
