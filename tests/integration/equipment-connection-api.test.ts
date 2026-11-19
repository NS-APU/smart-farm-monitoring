/**
 * 設備ごとのファイルサーバーの接続（Issue #367。ADR-0026。UC-12・UC-15）の管理 API・管理サービスの結合テスト。
 * - `PUT・DELETE /ingestion/equipment/{equipmentId}/connection`・`PUT .../credentials`・`POST .../test`
 * - `GET /ingestion/settings` の設備ごとの項目（ファイルのパス・接続・出どころ・認証情報の状態）
 * - 設備の削除で、設備ごとの接続も削除する。認証情報の値は、応答・ログ・変更履歴に残さない（NFR-5.4）
 * データはメモリ（実際の AWS には、接続しない）。認証情報は、明らかにダミーとわかる値。
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import {
  EquipmentConnectionResponseSchema,
  IngestionCredentialStatusSchema,
  IngestionSettingsResponseSchema,
} from '@smart-farm/shared/schemas/ingestion';
import { fileServerEquipmentSecretReference } from '../../src/backend/application/ingestion/file-server-credentials.ts';
import { createJsonLogger } from '../../src/backend/infrastructure/logging/json-logger.ts';
import { FACILITY_ID, must, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import {
  addUserAndLogin,
  errorOf,
  withEquipment,
  type TestContext,
} from '../support/test-context.ts';

const DUMMY_PASSWORD = 'dummy-password-0123';
const DUMMY_TOKEN = 'dummy-token-4567';
const DUMMY_HOST = 'dummy-files.example.invalid';

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

async function startServer(respond: (request: IncomingMessage) => number): Promise<number> {
  const server = createServer((request, response) => {
    response.writeHead(respond(request));
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

interface Harness {
  readonly context: TestContext;
  readonly logs: string[];
}

/** 設備の一式（ハウス・ロボット・センサー）を登録した組み立て。内部のアドレスの許可は、指定する（既定は、拒否）。 */
async function setup(options: { allowPrivate?: boolean } = {}): Promise<Harness> {
  const logs: string[] = [];
  const logger = createJsonLogger({
    sink: { write: (line: string) => logs.push(line) },
    minimumLevel: 'debug',
  });
  const context = await withEquipment({
    env: options.allowPrivate === true ? { HTTP_FILE_SOURCE_ALLOW_PRIVATE: 'true' } : {},
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

function connection(authMethod = 'NONE', overrides: Record<string, unknown> = {}) {
  return { type: 'HTTP', protocol: 'HTTPS', host: DUMMY_HOST, authMethod, ...overrides };
}

const connectionPath = (equipmentId: string) => `/ingestion/equipment/${equipmentId}/connection`;
const credentialsPath = (equipmentId: string) => `/ingestion/equipment/${equipmentId}/credentials`;
const testPath = (equipmentId: string) => `/ingestion/equipment/${equipmentId}/test`;

async function putConnection(
  context: TestContext,
  equipmentId: string,
  value: Record<string, unknown> = connection(),
) {
  return send(context, 'PUT', connectionPath(equipmentId), { connection: value });
}

/** 取り込み元（ロボット・センサー）の共通の接続を設定する（移行期間の共通の接続）。 */
async function setSharedConnection(
  context: TestContext,
  sourceId: 'robot' | 'environment-sensor',
  value: Record<string, unknown>,
) {
  const response = await send(context, 'PUT', '/ingestion/settings', {
    sources: [
      {
        sourceId,
        connectionRef: 'FILE_SERVER_MOCK',
        isEnabled: true,
        connection: value,
      },
    ],
  });
  expect(response.status).toBe(200);
}

async function describeEquipment(context: TestContext, sourceId: string, equipmentId: string) {
  const body = IngestionSettingsResponseSchema.parse(
    await (await send(context, 'GET', '/ingestion/settings')).json(),
  );
  const item = body.sources
    .find((source) => source.sourceId === sourceId)
    ?.equipment.find((candidate) => candidate.equipmentId === equipmentId);
  if (item === undefined) {
    throw new Error('テストの前提: 設備が、設定の応答にあります');
  }
  return item;
}

describe('PUT /ingestion/equipment/{equipmentId}/connection（設備ごとの接続の保存）', () => {
  it('ロボットの接続を保存し、応答は、出どころ EQUIPMENT・接続・認証情報の状態を示す。保存先に、その設備の接続が入る', async () => {
    const { context } = await setup();

    const response = await putConnection(context, ROBOT_ID, connection('NONE', { port: 8443 }));

    expect(response.status).toBe(200);
    const body = EquipmentConnectionResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      equipmentId: ROBOT_ID,
      connectionOrigin: 'EQUIPMENT',
      connection: { type: 'HTTP', protocol: 'HTTPS', host: DUMMY_HOST, port: 8443 },
      credentials: { state: 'NOT_REQUIRED' },
    });
    const saved = await context.container.equipmentConnections.list();
    expect(saved.get(ROBOT_ID)).toMatchObject({ host: DUMMY_HOST, port: 8443 });
    expect(saved.has(SENSOR_ID)).toBe(false);
  });

  it('センサーも保存できる。上書きできる。もう一方の設備の接続は、変わらない', async () => {
    const { context } = await setup();
    await putConnection(context, ROBOT_ID);

    await putConnection(context, SENSOR_ID, connection('BEARER'));
    const overwritten = await putConnection(context, SENSOR_ID, connection('NONE', { port: 9000 }));

    expect(overwritten.status).toBe(200);
    const saved = await context.container.equipmentConnections.list();
    expect(saved.get(SENSOR_ID)).toMatchObject({ authMethod: 'NONE', port: 9000 });
    expect(saved.get(ROBOT_ID)).toMatchObject({ authMethod: 'NONE', host: DUMMY_HOST });
  });

  it('認証が必要な接続を保存すると、認証情報は、未設定（NOT_CONFIGURED）', async () => {
    const { context } = await setup();

    const response = await putConnection(context, ROBOT_ID, connection('BASIC'));

    expect(EquipmentConnectionResponseSchema.parse(await response.json()).credentials).toEqual({
      state: 'NOT_CONFIGURED',
    });
  });

  it.each([
    ['ホストが空', { host: '' }, 'connection.host'],
    ['ホストにスキームを含む', { host: 'https://dummy-files.example.invalid' }, 'connection.host'],
    ['ホストに空白を含む', { host: 'dummy files' }, 'connection.host'],
    ['ポートが範囲外', { port: 70000 }, 'connection.port'],
    ['接続方式 MOCK（廃止）', { type: 'MOCK' }, 'connection.type'],
    ['未知の認証方式', { authMethod: 'DIGEST' }, 'connection.authMethod'],
  ])('不正な入力（%s）は、保存せず、400', async (_name, overrides, field) => {
    const { context } = await setup();

    const response = await putConnection(context, ROBOT_ID, connection('NONE', overrides));

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((item) => item.name)).toContain(field);
    expect((await context.container.equipmentConnections.list()).size).toBe(0);
  });

  it('本文に connection がなければ、400', async () => {
    const { context } = await setup();

    const response = await send(context, 'PUT', connectionPath(ROBOT_ID), {});

    expect(response.status).toBe(400);
  });

  it.each([
    ['ループバック', '127.0.0.1'],
    ['AWS のメタデータ', '169.254.169.254'],
    ['プライベート', '192.168.0.10'],
    ['localhost', 'localhost'],
    ['内部の名前', 'files.internal'],
    ['IPv6 のループバック', '[::1]'],
  ])(
    '内部のアドレス（%s）は、接続先に指定できない（取り込み元と同じ。connection.host のエラー）',
    async (_name, host) => {
      const { context } = await setup();

      const response = await putConnection(context, ROBOT_ID, connection('NONE', { host }));

      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.fields?.map((item) => item.name)).toContain('connection.host');
      expect(error.fields?.[0]?.message).toContain('内部のアドレス');
      expect((await context.container.equipmentConnections.list()).size).toBe(0);
    },
  );

  it('HTTP_FILE_SOURCE_ALLOW_PRIVATE を指定すると、内部のアドレスも保存できる（ローカル・テスト用）', async () => {
    const { context } = await setup({ allowPrivate: true });

    const response = await putConnection(
      context,
      ROBOT_ID,
      connection('NONE', { host: '127.0.0.1' }),
    );

    expect(response.status).toBe(200);
  });

  it('存在しない設備は 404。保存しない', async () => {
    const { context } = await setup();

    const response = await putConnection(context, 'ROBOT-NONE');

    expect(response.status).toBe(404);
    expect((await context.container.equipmentConnections.list()).size).toBe(0);
  });

  it('ハウスには、設定できない（400。設備の ID の項目のエラー）', async () => {
    const { context } = await setup();

    const response = await putConnection(context, FACILITY_ID);

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((item) => item.name)).toContain('equipmentId');
    expect((await context.container.equipmentConnections.list()).size).toBe(0);
  });

  it('削除済みの設備には、設定できない（404）', async () => {
    const { context } = await setup();
    await send(context, 'DELETE', `/equipment/${ROBOT_ID}`);

    const response = await putConnection(context, ROBOT_ID);

    expect(response.status).toBe(404);
    expect((await context.container.equipmentConnections.list()).size).toBe(0);
  });

  it('設備の ID の形式が正しくなければ、400', async () => {
    const { context } = await setup();

    const response = await putConnection(context, 'bad%20id');

    expect(response.status).toBe(400);
  });
});

describe('DELETE /ingestion/equipment/{equipmentId}/connection（共通の接続に戻る）', () => {
  it('設備ごとの接続を削除する。共通の接続がなければ NONE、あれば SHARED（共通の接続と、共通の認証情報の状態）', async () => {
    const { context } = await setup();
    await putConnection(
      context,
      ROBOT_ID,
      connection('NONE', { host: 'dummy-own.example.invalid' }),
    );

    const cleared = await send(context, 'DELETE', connectionPath(ROBOT_ID));
    const clearedBody = EquipmentConnectionResponseSchema.parse(await cleared.json());

    expect(cleared.status).toBe(200);
    expect(clearedBody).toEqual({
      equipmentId: ROBOT_ID,
      connectionOrigin: 'NONE',
      credentials: { state: 'NOT_REQUIRED' },
    });
    expect((await context.container.equipmentConnections.list()).has(ROBOT_ID)).toBe(false);

    await setSharedConnection(
      context,
      'robot',
      connection('BEARER', { host: 'dummy-shared.example.invalid' }),
    );
    await putConnection(
      context,
      ROBOT_ID,
      connection('NONE', { host: 'dummy-own.example.invalid' }),
    );
    const back = await send(context, 'DELETE', connectionPath(ROBOT_ID));

    expect(EquipmentConnectionResponseSchema.parse(await back.json())).toMatchObject({
      connectionOrigin: 'SHARED',
      connection: { host: 'dummy-shared.example.invalid', authMethod: 'BEARER' },
      credentials: { state: 'NOT_CONFIGURED' },
    });
  });

  it('設備ごとの接続がなくても、成功する（何度でも）。もう一方の設備の接続は、残る', async () => {
    const { context } = await setup();
    await putConnection(context, SENSOR_ID);

    const first = await send(context, 'DELETE', connectionPath(ROBOT_ID));
    const second = await send(context, 'DELETE', connectionPath(ROBOT_ID));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await context.container.equipmentConnections.list()).has(SENSOR_ID)).toBe(true);
  });

  it('存在しない設備は 404。ハウスは 400。削除済みの設備は 404', async () => {
    const { context } = await setup();
    await send(context, 'DELETE', `/equipment/${SENSOR_ID}`);

    expect((await send(context, 'DELETE', connectionPath('ROBOT-NONE'))).status).toBe(404);
    expect((await send(context, 'DELETE', connectionPath(FACILITY_ID))).status).toBe(400);
    expect((await send(context, 'DELETE', connectionPath(SENSOR_ID))).status).toBe(404);
  });
});

describe('PUT /ingestion/equipment/{equipmentId}/credentials（設備ごとの認証情報。書き込み専用）', () => {
  it('Basic: 設備ごとの参照名に、JSON で保存する。応答は、状態だけ（値を含めない）。取り込み元の共通の保存名・もう一方の設備は、変わらない', async () => {
    const { context } = await setup();
    await putConnection(context, ROBOT_ID, connection('BASIC'));

    const response = await send(context, 'PUT', credentialsPath(ROBOT_ID), {
      authMethod: 'BASIC',
      username: 'dummy-user',
      password: DUMMY_PASSWORD,
    });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(IngestionCredentialStatusSchema.parse(JSON.parse(text))).toMatchObject({
      state: 'CONFIGURED',
    });
    expect(text).not.toContain(DUMMY_PASSWORD);
    expect(text).not.toContain('dummy-user');
    const stored = await context.container.secrets.get(
      fileServerEquipmentSecretReference(ROBOT_ID),
    );
    expect(JSON.parse(stored ?? '')).toEqual({ username: 'dummy-user', password: DUMMY_PASSWORD });
    expect(await context.container.secrets.get('file-server/robot')).toBeUndefined();
    expect(
      await context.container.secrets.get(fileServerEquipmentSecretReference(SENSOR_ID)),
    ).toBeUndefined();
  });

  it('Bearer・API キー: 文字列を保存する。上書きで、更新日時が変わる', async () => {
    const { context } = await setup();
    await putConnection(context, SENSOR_ID, connection('BEARER'));

    await send(context, 'PUT', credentialsPath(SENSOR_ID), {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });
    const first = await describeEquipment(context, 'environment-sensor', SENSOR_ID);
    context.clock.advance(60_000);
    await send(context, 'PUT', credentialsPath(SENSOR_ID), {
      authMethod: 'BEARER',
      token: `${DUMMY_TOKEN}-2`,
    });
    const second = await describeEquipment(context, 'environment-sensor', SENSOR_ID);

    expect(first.credentials.state).toBe('CONFIGURED');
    expect(second.credentials.updatedAt).not.toBe(first.credentials.updatedAt);
    expect(await context.container.secrets.get(fileServerEquipmentSecretReference(SENSOR_ID))).toBe(
      `${DUMMY_TOKEN}-2`,
    );

    await putConnection(context, SENSOR_ID, connection('API_KEY'));
    await send(context, 'PUT', credentialsPath(SENSOR_ID), {
      authMethod: 'API_KEY',
      apiKey: 'dummy-api-key-89ab',
    });
    expect(await context.container.secrets.get(fileServerEquipmentSecretReference(SENSOR_ID))).toBe(
      'dummy-api-key-89ab',
    );
  });

  it('認証方式が、保存済みの接続と違えば 400。保存しない', async () => {
    const { context } = await setup();
    await putConnection(context, ROBOT_ID, connection('BASIC'));

    const response = await send(context, 'PUT', credentialsPath(ROBOT_ID), {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });

    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.fields?.map((item) => item.name)).toContain('authMethod');
    expect(JSON.stringify(error)).not.toContain(DUMMY_TOKEN);
    expect(
      await context.container.secrets.get(fileServerEquipmentSecretReference(ROBOT_ID)),
    ).toBeUndefined();
  });

  it('設備ごとの接続が未設定なら 400（取り込み元の共通の接続があっても、設備ごとの接続の保存が先に必要）', async () => {
    const { context } = await setup();
    await setSharedConnection(context, 'robot', connection('BEARER'));

    const response = await send(context, 'PUT', credentialsPath(ROBOT_ID), {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((item) => item.name)).toContain('authMethod');
  });

  it('認証なし（NONE）の接続には、登録できない（400）', async () => {
    const { context } = await setup();
    await putConnection(context, ROBOT_ID, connection('NONE'));

    const response = await send(context, 'PUT', credentialsPath(ROBOT_ID), {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });

    expect(response.status).toBe(400);
  });

  it.each([
    ['ユーザー名が空', { authMethod: 'BASIC', username: '', password: DUMMY_PASSWORD }],
    ['トークンに空白を含む', { authMethod: 'BEARER', token: 'dummy token' }],
    ['認証方式なし（NONE）', { authMethod: 'NONE' }],
  ])('不正な入力（%s）は、400。応答に値を含めない', async (_name, body) => {
    const { context } = await setup();
    await putConnection(context, ROBOT_ID, connection(body.authMethod));

    const response = await send(context, 'PUT', credentialsPath(ROBOT_ID), body);

    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).not.toContain(DUMMY_PASSWORD);
    expect(text).not.toContain('dummy token');
  });

  it('存在しない設備は 404・ハウスは 400・削除済みの設備は 404', async () => {
    const { context } = await setup();
    await putConnection(context, SENSOR_ID, connection('BEARER'));
    await send(context, 'DELETE', `/equipment/${SENSOR_ID}`);
    const input = { authMethod: 'BEARER', token: DUMMY_TOKEN };

    expect((await send(context, 'PUT', credentialsPath('ROBOT-NONE'), input)).status).toBe(404);
    expect((await send(context, 'PUT', credentialsPath(FACILITY_ID), input)).status).toBe(400);
    expect((await send(context, 'PUT', credentialsPath(SENSOR_ID), input)).status).toBe(404);
  });

  it('秘密情報の保管先が失敗したら 503。原因・値を、応答・ログに出さない', async () => {
    const { context, logs } = await setup();
    await putConnection(context, ROBOT_ID, connection('BEARER'));
    vi.spyOn(context.container.secrets, 'set').mockRejectedValue(
      new Error(`AccessDenied ${DUMMY_TOKEN}`),
    );

    const response = await send(context, 'PUT', credentialsPath(ROBOT_ID), {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });

    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).not.toContain(DUMMY_TOKEN);
    expect(text).not.toContain('AccessDenied');
    expect(logs.join('\n')).not.toContain(DUMMY_TOKEN);
  });
});

describe('GET /ingestion/settings の設備ごとの項目（出どころ・接続・認証情報の状態）', () => {
  it('どちらの接続もない設備は、出どころ NONE（接続なし・認証情報は不要）。ファイルのパスを示す', async () => {
    const { context } = await setup();
    const robot = await context.container.repositories.equipment.get(ROBOT_ID);
    if (robot === undefined) {
      throw new Error('テストの前提');
    }
    await context.container.repositories.equipment.save({
      ...robot,
      sourceFilePath: '/dummy/robot-01.json',
    });

    const item = await describeEquipment(context, 'robot', ROBOT_ID);

    expect(item).toMatchObject({
      sourceFilePath: '/dummy/robot-01.json',
      connectionOrigin: 'NONE',
      credentials: { state: 'NOT_REQUIRED' },
    });
    expect(item.connection).toBeUndefined();
    expect((await describeEquipment(context, 'environment-sensor', SENSOR_ID)).sourceFilePath).toBe(
      undefined,
    );
  });

  it('取り込み元の共通の接続だけがあれば、SHARED（共通の接続と、共通の認証情報の状態）。取り込み元の項目の共通の接続・認証情報は、そのまま', async () => {
    const { context } = await setup();
    await setSharedConnection(
      context,
      'robot',
      connection('BEARER', { host: 'dummy-shared.example.invalid' }),
    );

    const item = await describeEquipment(context, 'robot', ROBOT_ID);
    const settings = IngestionSettingsResponseSchema.parse(
      await (await send(context, 'GET', '/ingestion/settings')).json(),
    );
    const source = settings.sources.find((candidate) => candidate.sourceId === 'robot');

    expect(item).toMatchObject({
      connectionOrigin: 'SHARED',
      connection: { host: 'dummy-shared.example.invalid', authMethod: 'BEARER' },
      credentials: { state: 'NOT_CONFIGURED' },
    });
    expect(source?.connection).toMatchObject({ host: 'dummy-shared.example.invalid' });
    expect(source?.credentials).toEqual({ state: 'NOT_CONFIGURED' });

    await send(context, 'PUT', '/ingestion/robot/credentials', {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });
    expect((await describeEquipment(context, 'robot', ROBOT_ID)).credentials.state).toBe(
      'CONFIGURED',
    );
  });

  it('設備ごとの接続があれば、共通の接続があっても、EQUIPMENT（設備の接続と、設備の認証情報の状態）。もう一方の種別・設備は、影響を受けない', async () => {
    const { context } = await setup();
    await setSharedConnection(
      context,
      'robot',
      connection('BEARER', { host: 'dummy-shared.example.invalid' }),
    );
    await putConnection(
      context,
      ROBOT_ID,
      connection('BASIC', { host: 'dummy-own.example.invalid' }),
    );

    const before = await describeEquipment(context, 'robot', ROBOT_ID);
    await send(context, 'PUT', credentialsPath(ROBOT_ID), {
      authMethod: 'BASIC',
      username: 'dummy-user',
      password: DUMMY_PASSWORD,
    });
    const after = await describeEquipment(context, 'robot', ROBOT_ID);
    const sensor = await describeEquipment(context, 'environment-sensor', SENSOR_ID);

    expect(before).toMatchObject({
      connectionOrigin: 'EQUIPMENT',
      connection: { host: 'dummy-own.example.invalid', authMethod: 'BASIC' },
      credentials: { state: 'NOT_CONFIGURED' },
    });
    expect(after.credentials.state).toBe('CONFIGURED');
    expect(sensor).toMatchObject({
      connectionOrigin: 'NONE',
      credentials: { state: 'NOT_REQUIRED' },
    });
  });

  it('認証なし（NONE）の設備ごとの接続は、認証情報が不要。保管先は、読まない', async () => {
    const { context } = await setup();
    await putConnection(context, ROBOT_ID, connection('NONE'));
    const status = vi.spyOn(context.container.secrets, 'status');

    const item = await describeEquipment(context, 'robot', ROBOT_ID);

    expect(item.credentials).toEqual({ state: 'NOT_REQUIRED' });
    expect(status).not.toHaveBeenCalled();
  });

  it('保管先の読み出しは、認証が必要な設備ごとに 1 回（設備ごとの接続が EQUIPMENT の設備）。保管先の障害は、UNAVAILABLE（設定は、読める）', async () => {
    const { context } = await setup();
    await putConnection(context, ROBOT_ID, connection('BASIC'));
    await putConnection(context, SENSOR_ID, connection('BEARER'));
    const status = vi
      .spyOn(context.container.secrets, 'status')
      .mockRejectedValue(new Error('down'));

    const settings = await send(context, 'GET', '/ingestion/settings');

    expect(settings.status).toBe(200);
    expect(status).toHaveBeenCalledTimes(2);
    expect((await describeEquipment(context, 'robot', ROBOT_ID)).credentials).toEqual({
      state: 'UNAVAILABLE',
    });
  });

  it('設備の一覧（GET /equipment）には、接続・接続先を含めない（全ログインユーザーが読めるため）', async () => {
    const { context } = await setup();
    await putConnection(
      context,
      ROBOT_ID,
      connection('NONE', { host: 'dummy-own.example.invalid' }),
    );

    const text = await (await send(context, 'GET', '/equipment')).text();

    expect(text).not.toContain('dummy-own.example.invalid');
    expect(text).not.toContain('"connection"');
  });
});

describe('GET /ingestion/settings の設備ごとの「データが古い」の基準（staleThresholdMinutes）', () => {
  it('取得間隔の既定の設備は、間隔 × 3（ロボット 1 分は、最低の 3 分。センサー 5 分は、15 分）。ハウスは、設備の一覧に含まれない（基準を持たない）', async () => {
    const { context } = await setup();

    const robot = await describeEquipment(context, 'robot', ROBOT_ID);
    const sensor = await describeEquipment(context, 'environment-sensor', SENSOR_ID);
    const settings = IngestionSettingsResponseSchema.parse(
      await (await send(context, 'GET', '/ingestion/settings')).json(),
    );

    expect(robot.staleThresholdMinutes).toBe(3);
    expect(sensor.staleThresholdMinutes).toBe(15);
    const listed = settings.sources.flatMap((source) =>
      source.equipment.map((item) => item.equipmentId),
    );
    expect(listed).not.toContain(FACILITY_ID);
  });

  it('設備の取得間隔を変えると、基準も変わる（間隔 × 3。もう一方の設備は、変わらない）', async () => {
    const { context } = await setup();
    const { equipment } = context.container.repositories;
    await equipment.save({ ...must(await equipment.get(ROBOT_ID)), intervalMinutes: 10 });
    await equipment.save({ ...must(await equipment.get(SENSOR_ID)), intervalMinutes: 1 });

    expect((await describeEquipment(context, 'robot', ROBOT_ID)).staleThresholdMinutes).toBe(30);
    // 1 分 × 3 = 3 分（最低の 3 分と同じ）
    expect(
      (await describeEquipment(context, 'environment-sensor', SENSOR_ID)).staleThresholdMinutes,
    ).toBe(3);
  });

  it('倍数の設定（STALE_AFTER_INTERVALS）に従う', async () => {
    const context = await withEquipment({ env: { STALE_AFTER_INTERVALS: '4' } });

    expect(
      (await describeEquipment(context, 'environment-sensor', SENSOR_ID)).staleThresholdMinutes,
    ).toBe(20);
    expect((await describeEquipment(context, 'robot', ROBOT_ID)).staleThresholdMinutes).toBe(4);
  });
});

describe('変更履歴・ログに、認証情報の値を残さない', () => {
  it('接続の保存・上書き・削除を記録する（接続先を含む）。認証情報の更新は、「更新した」事実と認証方式だけ（値・ユーザー名を含めない）', async () => {
    const { context, logs } = await setup();
    await putConnection(context, ROBOT_ID, connection('BASIC'));
    await putConnection(context, ROBOT_ID, connection('BASIC', { port: 8443 }));
    await send(context, 'PUT', credentialsPath(ROBOT_ID), {
      authMethod: 'BASIC',
      username: 'dummy-user',
      password: DUMMY_PASSWORD,
    });
    await send(context, 'DELETE', connectionPath(ROBOT_ID));

    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?targetType=ingestion-settings')).json(),
    );

    const connectionEntries = audit.items.filter(
      (item) => item.targetId === `equipment-connections/${ROBOT_ID}`,
    );
    expect(connectionEntries.map((item) => item.operation).sort()).toEqual([
      'CREATE',
      'DELETE',
      'UPDATE',
    ]);
    expect(connectionEntries.find((item) => item.operation === 'CREATE')?.after).toMatchObject({
      host: DUMMY_HOST,
    });
    expect(connectionEntries.find((item) => item.operation === 'UPDATE')).toMatchObject({
      before: { host: DUMMY_HOST },
      after: { port: 8443 },
    });
    expect(
      audit.items.find((item) => item.targetId === `credentials/equipment/${ROBOT_ID}`),
    ).toMatchObject({
      operation: 'UPDATE',
      after: { credentialsUpdated: true, authMethod: 'BASIC' },
    });
    for (const text of [JSON.stringify(audit), logs.join('\n')]) {
      expect(text).not.toContain(DUMMY_PASSWORD);
      expect(text).not.toContain('dummy-user');
    }
  });

  it('保存できなかった（検証エラー）操作は、記録しない', async () => {
    const { context } = await setup();

    await putConnection(context, ROBOT_ID, connection('NONE', { host: '127.0.0.1' }));
    await putConnection(context, FACILITY_ID);
    await send(context, 'PUT', credentialsPath(ROBOT_ID), {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });

    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?targetType=ingestion-settings')).json(),
    );
    expect(audit.items).toEqual([]);
  });
});

describe('権限（ingestion:configure・ingestion:run）', () => {
  async function general(context: TestContext): Promise<string> {
    return addUserAndLogin(context, { userId: 'general-1', role: 'general' });
  }

  it.each([
    ['PUT', connectionPath(ROBOT_ID), { connection: connection() }],
    ['DELETE', connectionPath(ROBOT_ID), undefined],
    ['PUT', credentialsPath(ROBOT_ID), { authMethod: 'BEARER', token: DUMMY_TOKEN }],
    ['POST', testPath(ROBOT_ID), undefined],
  ])('一般ユーザーは、%s %s を使えない（403。何も保存しない）', async (method, path, body) => {
    const { context } = await setup();
    await putConnection(context, SENSOR_ID, connection('BEARER'));
    const token = await general(context);

    const response = await send(context, method, path, body, token);

    expect(response.status).toBe(403);
    expect((await context.container.equipmentConnections.list()).size).toBe(1);
    expect(
      await context.container.secrets.get(fileServerEquipmentSecretReference(ROBOT_ID)),
    ).toBeUndefined();
  });

  it.each([
    ['PUT', connectionPath(ROBOT_ID)],
    ['DELETE', connectionPath(ROBOT_ID)],
    ['PUT', credentialsPath(ROBOT_ID)],
    ['POST', testPath(ROBOT_ID)],
  ])('未ログインは、%s %s を使えない（401）', async (method, path) => {
    const { context } = await setup();

    const response = await context.app.request(`/api/v1${path}`, { method });

    expect(response.status).toBe(401);
  });

  it('管理者は、4 つの操作とも使える', async () => {
    const { context } = await setup({ allowPrivate: true });
    const port = await startServer(() => 200);
    await context.container.repositories.equipment.save({
      ...must(await context.container.repositories.equipment.get(ROBOT_ID)),
      sourceFilePath: '/dummy/robot-01.json',
    });

    const put = await putConnection(
      context,
      ROBOT_ID,
      connection('BEARER', { protocol: 'HTTP', host: '127.0.0.1', port }),
    );
    const credentials = await send(context, 'PUT', credentialsPath(ROBOT_ID), {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });
    const test = await send(context, 'POST', testPath(ROBOT_ID));
    const del = await send(context, 'DELETE', connectionPath(ROBOT_ID));

    expect([put.status, credentials.status, test.status, del.status]).toEqual([200, 200, 200, 200]);
  });
});

describe('POST /ingestion/equipment/{equipmentId}/test（設備 1 つの接続テスト）', () => {
  async function ready() {
    const harness = await setup({ allowPrivate: true });
    const { context } = harness;
    const robot = await context.container.repositories.equipment.get(ROBOT_ID);
    if (robot === undefined) {
      throw new Error('テストの前提');
    }
    await context.container.repositories.equipment.save({
      ...robot,
      sourceFilePath: '/dummy/robot-01.json',
    });
    return harness;
  }

  it('設備ごとの接続・認証情報で、その設備のファイルに接続できれば、ok。失敗は、理由だけを message に示す（接続先・認証情報を含めない）', async () => {
    const { context } = await ready();
    const seen: (string | undefined)[] = [];
    const port = await startServer((request) => {
      seen.push(request.headers.authorization);
      return request.headers.authorization === `Bearer ${DUMMY_TOKEN}` ? 200 : 401;
    });
    await putConnection(
      context,
      ROBOT_ID,
      connection('BEARER', { protocol: 'HTTP', host: '127.0.0.1', port }),
    );

    const before = await (await send(context, 'POST', testPath(ROBOT_ID))).json();
    await send(context, 'PUT', credentialsPath(ROBOT_ID), {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });
    const after = await (await send(context, 'POST', testPath(ROBOT_ID))).json();

    expect(before).toMatchObject({ ok: false });
    expect(JSON.stringify(before)).not.toContain('127.0.0.1');
    expect(JSON.stringify(before)).not.toContain(DUMMY_TOKEN);
    expect(after).toEqual({ ok: true, message: '接続できました' });
    expect(seen).toContain(`Bearer ${DUMMY_TOKEN}`);
  });

  it('存在しない設備・削除済みの設備は 404', async () => {
    const { context } = await ready();
    await send(context, 'DELETE', `/equipment/${SENSOR_ID}`);

    expect((await send(context, 'POST', testPath('ROBOT-NONE'))).status).toBe(404);
    expect((await send(context, 'POST', testPath(SENSOR_ID))).status).toBe(404);
  });
});

describe('設備の削除と、データのリセット', () => {
  it('設備を削除すると、その設備ごとの接続も削除する（もう一方の設備の接続は、残る）。認証情報は、保管先に削除の機能がないため、残す', async () => {
    const { context } = await setup();
    await putConnection(context, ROBOT_ID, connection('BEARER'));
    await putConnection(context, SENSOR_ID, connection('NONE'));
    await send(context, 'PUT', credentialsPath(ROBOT_ID), {
      authMethod: 'BEARER',
      token: DUMMY_TOKEN,
    });

    const response = await send(context, 'DELETE', `/equipment/${ROBOT_ID}`);

    expect(response.status).toBe(204);
    const saved = await context.container.equipmentConnections.list();
    expect(saved.has(ROBOT_ID)).toBe(false);
    expect(saved.has(SENSOR_ID)).toBe(true);
    expect(await context.container.secrets.get(fileServerEquipmentSecretReference(ROBOT_ID))).toBe(
      DUMMY_TOKEN,
    );
  });

  it('ハウスを削除すると、配下のロボット・センサーの接続も、すべて削除する', async () => {
    const { context } = await setup();
    await putConnection(context, ROBOT_ID);
    await putConnection(context, SENSOR_ID);

    const response = await send(context, 'DELETE', `/equipment/${FACILITY_ID}`);

    expect(response.status).toBe(204);
    expect((await context.container.equipmentConnections.list()).size).toBe(0);
  });

  it('POST /dev/reset は、設備ごとの接続も消す（設定と同じ保存先を、すべて消すため）', async () => {
    const { context } = await setup();
    await putConnection(context, ROBOT_ID);
    expect((await context.container.equipmentConnections.list()).size).toBe(1);

    const reset = await send(context, 'POST', '/dev/reset');

    expect(reset.status).toBe(204);
    expect((await context.container.equipmentConnections.list()).size).toBe(0);
  });
});
