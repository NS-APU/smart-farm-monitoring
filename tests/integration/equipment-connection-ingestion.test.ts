/**
 * 設備ごとの接続での取り込み（Issue #367。ADR-0026）の結合テスト。
 * 接続は、設備ごと（認証情報も、設備ごと）。設備に接続がなければ、「接続先が設定されていません」の失敗にする（共通の接続は、廃止した）。
 * 1 台の接続の失敗（停止・認証の失敗・未設定）が、同じ取り込み元の、ほかの設備の取り込みを止めない（失敗の分離）。
 * 別々の HTTP のテスト用サーバー（tests/support/http-file-server.ts）に、設備ごとに接続する。認証情報は、明らかにダミーとわかる値。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@smart-farm/shared/errors';
import { toEquipmentId, toUserId, type EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { FileServerConnection, IngestionLog } from '@smart-farm/shared/schemas/ingestion';
import {
  createEquipmentConnections,
  type EquipmentConnections,
} from '../../src/backend/application/ingestion/equipment-connections.ts';
import {
  credentialsSecretValue,
  fileServerEquipmentSecretReference,
} from '../../src/backend/application/ingestion/file-server-credentials.ts';
import {
  FACILITY_ID,
  FACILITY_2_ID,
  ROBOT_2_ID,
  ROBOT_ID,
  secondHouseSet,
} from '../support/builders.ts';
import { createIngestionService } from '../../src/backend/application/ingestion/ingestion-service.ts';
import {
  FileSourceUnavailableError,
  type FileListFailure,
  type FileSourcePort,
  type ListFilesOptions,
} from '../../src/backend/application/ports/file-source-port.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { DEFAULT_APP_SETTINGS } from '../../src/backend/application/settings.ts';
import { createDefaultFormatProfileRegistry } from '../../src/backend/infrastructure/format-profiles/declarative-profile.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { startHttpFileServer, type HttpFileServer } from '../support/http-file-server.ts';
import { HTTP_FILES_ENV } from '../support/http-test-files.ts';
import { STUB_MODIFIED_AT } from '../support/test-constants.ts';
import { TEST_USER, withEquipment, type TestContext } from '../support/test-context.ts';

const FILE_A = '/robot/robot-a.json';
const FILE_B = '/robot/robot-b.json';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** ロボットのファイル（合成データ。記録 1 件）。 */
function robotFile(externalId: string): string {
  return JSON.stringify({
    robotId: externalId,
    records: [{ timestamp: '2026-10-09T02:59:00Z', harvestCount: 12 }],
  });
}

function connectionTo(
  port: number,
  overrides: Partial<FileServerConnection> = {},
): FileServerConnection {
  return {
    type: 'HTTP',
    protocol: 'HTTP',
    host: '127.0.0.1',
    port,
    authMethod: 'NONE',
    apiKeyHeaderName: 'X-API-Key',
    ...overrides,
  };
}

async function startFileServer(): Promise<HttpFileServer> {
  const server = await startHttpFileServer();
  closers.push(() => server.close());
  return server;
}

interface BasicRule {
  readonly username: string;
  readonly password: string;
  readonly body: string;
}

/** パスごとに、BASIC 認証の資格情報を検査する HTTP サーバー（HEAD・GET の記録つき）。資格情報が違えば 401。ファイルがなければ 404。 */
async function startBasicAuthServer(rules: Readonly<Record<string, BasicRule>>) {
  const requests: { method: string; path: string }[] = [];
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    requests.push({ method: request.method ?? '', path });
    const rule = rules[path];
    if (rule === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    const expected = `Basic ${Buffer.from(`${rule.username}:${rule.password}`, 'utf8').toString('base64')}`;
    if (request.headers.authorization !== expected) {
      response.writeHead(401);
      response.end();
      return;
    }
    response.writeHead(200, {
      'Content-Length': String(Buffer.byteLength(rule.body)),
      'Last-Modified': STUB_MODIFIED_AT.toUTCString(),
    });
    response.end(request.method === 'HEAD' ? undefined : rule.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, requests };
}

function headsOf(server: { requests: readonly { method: string; path: string }[] }, path: string) {
  return server.requests.filter((request) => request.method === 'HEAD' && request.path === path)
    .length;
}

interface Harness {
  readonly context: TestContext;
  readonly serverA: HttpFileServer;
  readonly serverB: HttpFileServer;
  readonly connections: EquipmentConnections;
}

/**
 * 2 つのハウスのロボットが、別々のサーバーにファイルを持つ組み立て。ロボット（ROBOT_ID）は FILE_A（サーバー A）、
 * ロボット 2（ROBOT_2_ID）は FILE_B（サーバー B）。設備ごとの接続は、まだ設定しない（テストが設定する）。
 */
async function setup(): Promise<Harness> {
  const context = await withEquipment({ env: HTTP_FILES_ENV });
  const { equipment, settings } = context.container.repositories;
  for (const item of secondHouseSet()) {
    await equipment.save(item);
  }
  for (const [equipmentId, path] of [
    [ROBOT_ID, FILE_A],
    [ROBOT_2_ID, FILE_B],
  ] as const) {
    const found = await equipment.get(equipmentId);
    if (found === undefined) {
      throw new Error('テストの前提: ロボットがいます');
    }
    await equipment.save({ ...found, sourceFilePath: path });
  }
  const serverA = await startFileServer();
  const serverB = await startFileServer();
  serverA.put(FILE_A, robotFile('ROBOT-SAMPLE-01'), { modifiedAt: STUB_MODIFIED_AT });
  serverB.put(FILE_B, robotFile('ROBOT-SAMPLE-02'), { modifiedAt: STUB_MODIFIED_AT });
  return { context, serverA, serverB, connections: createEquipmentConnections(settings) };
}

/** 設備ごとの接続を、ロボット → サーバー A、ロボット 2 → サーバー B にする。 */
async function connectEach({ serverA, serverB, connections }: Harness): Promise<void> {
  await connections.save(ROBOT_ID, connectionTo(serverA.port));
  await connections.save(ROBOT_2_ID, connectionTo(serverB.port));
}

async function logsOf(context: TestContext, equipmentId: EquipmentId): Promise<IngestionLog[]> {
  const logs = await context.container.repositories.ingestion.listLogs({}, { limit: 100 });
  return logs.items.filter((log) => log.equipmentId === equipmentId);
}

async function sourceLogsOf(context: TestContext): Promise<IngestionLog[]> {
  const logs = await context.container.repositories.ingestion.listLogs({}, { limit: 100 });
  return logs.items.filter((log) => log.equipmentId === undefined);
}

async function notificationsOf(context: TestContext) {
  return (
    await context.container.repositories.notifications.list(
      toUserId(TEST_USER.userId),
      {},
      { limit: 50 },
    )
  ).items
    .map((item) => item.notification)
    .filter((notification) => notification.kind === 'INGESTION_FAILURE');
}

async function runResultOf(context: TestContext, equipmentId: EquipmentId) {
  return (await context.container.repositories.ingestion.listEquipmentRuns()).get(equipmentId)
    ?.result;
}

describe('設備ごとの接続での取り込み', () => {
  it('2 台のロボットが、別々のサーバーに接続して、それぞれのファイルを取り込む。ほかの設備のサーバーには、問い合わせない', async () => {
    const harness = await setup();
    await connectEach(harness);

    const summary = await harness.context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({
      result: 'SUCCESS',
      filesProcessed: 2,
      recordCount: 2,
      attempts: 1,
    });
    expect(harness.serverA.requests.map((request) => request.path)).toEqual([FILE_A, FILE_A]);
    expect(harness.serverB.requests.map((request) => request.path)).toEqual([FILE_B, FILE_B]);
    expect(await logsOf(harness.context, ROBOT_ID)).toHaveLength(1);
    expect(await logsOf(harness.context, ROBOT_2_ID)).toHaveLength(1);
  });

  it('以前に保存された取り込み元の共通の接続（connection・connectionRef）があっても、接続のない設備は、使わない（共通の接続へのフォールバックは、ない）', async () => {
    const harness = await setup();
    const { context, serverA, serverB } = harness;
    // 以前の版が保存した形（取り込み元の共通の接続は、サーバー B）を、設定の保管先に直接置く。ロボットだけ、自分の接続（サーバー A）を持つ
    await harness.connections.save(ROBOT_ID, connectionTo(serverA.port));
    const sources = await context.container.ingestionSettings.listSources();
    await context.container.repositories.settings.set(
      'ingestion.sources',
      sources.map((source) => ({
        ...source,
        connectionRef: 'FILE_SERVER_MOCK',
        connection: connectionTo(serverB.port),
      })),
    );

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'PARTIAL', filesProcessed: 1, recordCount: 1 });
    // ロボットのファイル（FILE_A）は、サーバー A に問い合わせた。ロボット 2 は、共通の接続（サーバー B）に、問い合わせない
    expect(headsOf(serverA, FILE_A)).toBe(1);
    expect(serverB.requests).toEqual([]);
    expect(await logsOf(harness.context, ROBOT_2_ID)).toMatchObject([
      { result: 'FAILURE', errorMessage: '接続先が設定されていません' },
    ]);
  });

  it('設備に接続がない設備は、「接続先が設定されていません」で失敗する。接続のある設備は、取り込む', async () => {
    const harness = await setup();
    await harness.connections.save(ROBOT_ID, connectionTo(harness.serverA.port));

    const summary = await harness.context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'PARTIAL', filesProcessed: 1, recordCount: 1 });
    expect(await logsOf(harness.context, ROBOT_ID)).toMatchObject([
      { result: 'SUCCESS', recordCount: 1 },
    ]);
    expect(await logsOf(harness.context, ROBOT_2_ID)).toMatchObject([
      { result: 'FAILURE', errorMessage: '接続先が設定されていません' },
    ]);
    expect(harness.serverB.requests).toEqual([]);
  });

  it('設備ごとの認証情報（BASIC。設備ごとに別の値）で取得できる。別の設備の認証情報は、使わない', async () => {
    const harness = await setup();
    const { context, connections } = harness;
    const server = await startBasicAuthServer({
      [FILE_A]: {
        username: 'dummy-user-a',
        password: 'dummy-password-a',
        body: robotFile('ROBOT-SAMPLE-01'),
      },
      [FILE_B]: {
        username: 'dummy-user-b',
        password: 'dummy-password-b',
        body: robotFile('ROBOT-SAMPLE-02'),
      },
    });
    const basic = connectionTo(server.port, { authMethod: 'BASIC' });
    // ロボット・ロボット 2: 設備ごとの接続・認証情報（別の値）
    await connections.save(ROBOT_ID, basic);
    await connections.save(ROBOT_2_ID, basic);
    await context.container.secrets.set(
      fileServerEquipmentSecretReference(ROBOT_ID),
      credentialsSecretValue({
        authMethod: 'BASIC',
        username: 'dummy-user-a',
        password: 'dummy-password-a',
      }),
    );
    await context.container.secrets.set(
      fileServerEquipmentSecretReference(ROBOT_2_ID),
      credentialsSecretValue({
        authMethod: 'BASIC',
        username: 'dummy-user-b',
        password: 'dummy-password-b',
      }),
    );

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'SUCCESS', filesProcessed: 2, recordCount: 2 });
  });
});

describe('失敗の分離（1 台の接続の失敗が、ほかの設備の取り込みを止めない）', () => {
  it('一方のサーバーが停止（DOWN）していても、他方の設備は取り込まれる。失敗した設備に、設備ごとの失敗のログと、最終の実行（失敗）が残る', async () => {
    const harness = await setup();
    await connectEach(harness);
    const { context, serverA, serverB } = harness;
    serverB.faults.set({ mode: 'DOWN' });
    const before = context.clock.now().getTime();

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({
      result: 'PARTIAL',
      filesProcessed: 1,
      recordCount: 1,
      attempts: 3,
    });
    // 再試行の待ち時間: 1 秒 + 2 秒（間隔を広げる）
    expect(context.clock.now().getTime() - before).toBe(3000);
    expect(await logsOf(context, ROBOT_ID)).toMatchObject([{ result: 'SUCCESS', recordCount: 1 }]);
    expect(await logsOf(context, ROBOT_2_ID)).toEqual([
      expect.objectContaining({
        sourceId: 'robot',
        result: 'FAILURE',
        filesProcessed: 0,
        recordCount: 0,
        rejectedCount: 0,
        attempts: 3,
        errorMessage: 'ファイルサーバーに接続できません',
        facilities: [{ facilityId: FACILITY_2_ID, result: 'FAILURE', recordCount: 0 }],
      }),
    ]);
    // 取り込み元単位のログは、ない（設備ごとの失敗だけ）
    expect(await sourceLogsOf(context)).toEqual([]);
    expect(await runResultOf(context, ROBOT_ID)).toBe('SUCCESS');
    expect(await runResultOf(context, ROBOT_2_ID)).toBe('FAILURE');
    // 再試行は、失敗したパスだけ: 取得できた設備のサーバーには、1 回（再試行しない）。停止中のサーバーには、試行の回数だけ
    expect(headsOf(serverA, FILE_A)).toBe(1);
    expect(headsOf(serverB, FILE_B)).toBe(3);
  });

  it('認証に失敗した設備があっても、他方の設備は取り込まれる（理由は、固定の文言。値・接続先を含めない）', async () => {
    const harness = await setup();
    const { context, connections, serverA } = harness;
    const server = await startBasicAuthServer({
      [FILE_B]: {
        username: 'dummy-user-b',
        password: 'dummy-password-b',
        body: robotFile('ROBOT-SAMPLE-02'),
      },
    });
    await connections.save(ROBOT_ID, connectionTo(serverA.port));
    await connections.save(ROBOT_2_ID, connectionTo(server.port, { authMethod: 'BASIC' }));
    await context.container.secrets.set(
      fileServerEquipmentSecretReference(ROBOT_2_ID),
      credentialsSecretValue({
        authMethod: 'BASIC',
        username: 'dummy-user-b',
        password: 'dummy-password-wrong',
      }),
    );

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'PARTIAL', filesProcessed: 1, recordCount: 1 });
    const failureLog = (await logsOf(context, ROBOT_2_ID))[0];
    expect(failureLog).toMatchObject({
      result: 'FAILURE',
      errorMessage: 'ファイルサーバーの認証に失敗しました',
    });
    expect(JSON.stringify(failureLog)).not.toContain('dummy-password');
    expect(JSON.stringify(failureLog)).not.toContain(String(server.port));
    expect(await runResultOf(context, ROBOT_2_ID)).toBe('FAILURE');
    expect(await runResultOf(context, ROBOT_ID)).toBe('SUCCESS');
    // 認証の失敗は、1 回の取得の中で、取り直した上で、再試行の回数だけ問い合わせる。取得できた設備のサーバーには、再試行しない
    expect(headsOf(serverA, FILE_A)).toBe(1);
  });

  it('再試行の間に復旧すれば、失敗したパスだけを再試行して取り込む。成功したファイルは保たれ、失敗は残らない・通知もしない', async () => {
    const harness = await setup();
    await connectEach(harness);
    const { context, serverA, serverB } = harness;
    serverB.faults.set({ mode: 'DOWN' });
    // 1 回目の待ちで、サーバー B が復旧する
    vi.spyOn(context.clock, 'sleep').mockImplementation(() => {
      serverB.faults.set({ mode: 'UP' });
      return Promise.resolve();
    });

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({
      result: 'SUCCESS',
      filesProcessed: 2,
      recordCount: 2,
      attempts: 2,
    });
    expect(headsOf(serverA, FILE_A)).toBe(1);
    expect(headsOf(serverB, FILE_B)).toBe(2);
    expect((await logsOf(context, ROBOT_2_ID)).map((log) => log.result)).toEqual(['SUCCESS']);
    expect(await runResultOf(context, ROBOT_2_ID)).toBe('SUCCESS');
    expect(await notificationsOf(context)).toEqual([]);
  });

  it('回復すれば、次の回で取り込まれる（取り込み済みのファイルは、取り込み直さない）', async () => {
    const harness = await setup();
    await connectEach(harness);
    const { context, serverB } = harness;
    serverB.faults.set({ mode: 'DOWN' });
    await context.container.ingestionService.runSource('robot');
    serverB.faults.set({ mode: 'UP' });

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({
      result: 'SUCCESS',
      filesProcessed: 1,
      recordCount: 1,
      attempts: 1,
    });
    expect(await runResultOf(context, ROBOT_2_ID)).toBe('SUCCESS');
    expect(await runResultOf(context, ROBOT_ID)).toBe('SUCCESS');
    expect((await logsOf(context, ROBOT_2_ID)).map((log) => log.result).sort()).toEqual([
      'FAILURE',
      'SUCCESS',
    ]);
  });

  it('設備ごとの失敗は、取り込み元ごとに 1 回だけ通知する（設備の名前と固定の理由。接続先・パスを含めない）。抑制の期間内は、繰り返さない', async () => {
    const harness = await setup();
    await connectEach(harness);
    const { context, serverB } = harness;
    serverB.faults.set({ mode: 'DOWN' });

    await context.container.ingestionService.runSource('robot');
    await context.container.ingestionService.runSource('robot');

    const notifications = await notificationsOf(context);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: 'INGESTION_FAILURE',
      sourceId: 'robot',
      message:
        '【データ取得失敗】ロボットデータ: テストロボット2: ファイルサーバーに接続できません',
    });
    expect(notifications[0]?.message).not.toContain(FILE_B);
    expect(notifications[0]?.message).not.toContain(String(serverB.port));
  });

  it('失敗した設備が多いときは、通知に、先頭の 3 件と「ほか N 件」を載せる', async () => {
    const harness = await setup();
    const { context, serverA } = harness;
    await harness.connections.save(ROBOT_ID, connectionTo(serverA.port));
    // 接続のない設備を、4 台に増やす（ロボット 2〜5）。ロボット（接続あり）だけが、取り込まれる
    for (const number of [3, 4, 5]) {
      const extra: Equipment = {
        equipmentId: toEquipmentId(`ROBOT-T${String(number)}`),
        equipmentType: 'ROBOT',
        name: `テストロボット${String(number)}`,
        facilityId: FACILITY_ID,
        externalId: `ROBOT-SAMPLE-0${String(number)}`,
        sourceFilePath: `/robot/robot-${String(number)}.json`,
        isDeleted: false,
        createdAt: '2026-10-01T00:00:00.000Z',
      };
      await context.container.repositories.equipment.save(extra);
    }

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'PARTIAL', filesProcessed: 1 });
    const notifications = await notificationsOf(context);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toBe(
      '【データ取得失敗】ロボットデータ: テストロボット2: 接続先が設定されていません／テストロボット3: 接続先が設定されていません／テストロボット4: 接続先が設定されていません ほか 1 件',
    );
  });

  it('すべての設備が失敗なら、取り込み結果は失敗（取り込み元全体の失敗として、取り込み元のログ・通知）。設備ごとの最終の実行は、すべて失敗', async () => {
    const harness = await setup();
    await connectEach(harness);
    const { context, serverA, serverB } = harness;
    serverA.faults.set({ mode: 'DOWN' });
    serverB.faults.set({ mode: 'DOWN' });

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'FAILURE', filesProcessed: 0, attempts: 3 });
    expect(await sourceLogsOf(context)).toMatchObject([
      { result: 'FAILURE', errorMessage: 'ファイルサーバーに接続できませんでした' },
    ]);
    expect(await runResultOf(context, ROBOT_ID)).toBe('FAILURE');
    expect(await runResultOf(context, ROBOT_2_ID)).toBe('FAILURE');
    expect(await notificationsOf(context)).toHaveLength(1);
  });

  it('取り込める設備が 1 つもなく、一部が失敗（残りは、ファイルがまだない）のときも、取り込み結果は失敗。失敗した設備に、設備ごとのログ', async () => {
    const harness = await setup();
    await connectEach(harness);
    const { context, serverA, serverB } = harness;
    serverA.remove(FILE_A);
    serverB.faults.set({ mode: 'DOWN' });

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'FAILURE', filesProcessed: 0 });
    expect(await logsOf(context, ROBOT_ID)).toEqual([]);
    expect(await logsOf(context, ROBOT_2_ID)).toMatchObject([{ result: 'FAILURE' }]);
    expect(await runResultOf(context, ROBOT_ID)).toBe('SUCCESS');
    expect(await runResultOf(context, ROBOT_2_ID)).toBe('FAILURE');
  });

  it('失敗がなければ、これまでどおり（設備ごとの失敗のログ・通知は、ない）', async () => {
    const harness = await setup();
    await connectEach(harness);

    await harness.context.container.ingestionService.runSource('robot');

    expect(await notificationsOf(harness.context)).toEqual([]);
    expect(await sourceLogsOf(harness.context)).toEqual([]);
    expect(
      [
        ...(await logsOf(harness.context, ROBOT_ID)),
        ...(await logsOf(harness.context, ROBOT_2_ID)),
      ].map((log) => log.result),
    ).toEqual(['SUCCESS', 'SUCCESS']);
  });
});

describe('設備の接続テスト（testEquipment・testEquipmentConnection）', () => {
  it('成功: その設備の接続先に接続して、「接続できました」。ほかの設備のサーバーには、接続しない', async () => {
    const harness = await setup();
    await connectEach(harness);

    const result =
      await harness.context.container.ingestionService.testEquipmentConnection(ROBOT_2_ID);

    expect(result).toEqual({ ok: true, message: '接続できました' });
    expect(harness.serverA.requests).toEqual([]);
    expect(harness.serverB.requests.map((request) => request.path)).toEqual([FILE_B]);
  });

  it('ファイルパスのない設備は、NO_FILE_PATH の文言で失敗する（接続しない）', async () => {
    const harness = await setup();
    await connectEach(harness);
    const { context, serverB } = harness;
    const robot = await context.container.repositories.equipment.get(ROBOT_2_ID);
    if (robot === undefined) {
      throw new Error('テストの前提: ロボットがいます');
    }
    await context.container.repositories.equipment.save({ ...robot, sourceFilePath: undefined });

    const result = await context.container.ingestionService.testEquipmentConnection(ROBOT_2_ID);

    expect(result).toEqual({
      ok: false,
      message:
        '接続できませんでした（ファイルパスが設定された設備がありません）。接続先と認証情報の設定を確認してください',
    });
    expect(serverB.requests).toEqual([]);
  });

  it('接続が解決できない設備は、NOT_CONFIGURED の文言で失敗する', async () => {
    const harness = await setup();

    const result =
      await harness.context.container.ingestionService.testEquipmentConnection(ROBOT_ID);

    expect(result).toEqual({
      ok: false,
      message:
        '接続できませんでした（接続先が設定されていません）。接続先と認証情報の設定を確認してください',
    });
  });

  it('認証に失敗すれば、AUTH_FAILED の文言で失敗する（認証情報・接続先を含めない）。認証情報が正しければ、成功する', async () => {
    const harness = await setup();
    const { context, connections } = harness;
    const server = await startBasicAuthServer({
      [FILE_A]: {
        username: 'dummy-user-a',
        password: 'dummy-password-a',
        body: robotFile('ROBOT-SAMPLE-01'),
      },
    });
    await connections.save(ROBOT_ID, connectionTo(server.port, { authMethod: 'BASIC' }));
    const reference = fileServerEquipmentSecretReference(ROBOT_ID);
    await context.container.secrets.set(
      reference,
      credentialsSecretValue({
        authMethod: 'BASIC',
        username: 'dummy-user-a',
        password: 'dummy-password-wrong',
      }),
    );

    const failed = await context.container.ingestionService.testEquipmentConnection(ROBOT_ID);
    await context.container.secrets.set(
      reference,
      credentialsSecretValue({
        authMethod: 'BASIC',
        username: 'dummy-user-a',
        password: 'dummy-password-a',
      }),
    );
    const succeeded = await context.container.ingestionService.testEquipmentConnection(ROBOT_ID);

    expect(failed).toEqual({
      ok: false,
      message:
        '接続できませんでした（ファイルサーバーの認証に失敗しました）。接続先と認証情報の設定を確認してください',
    });
    expect(succeeded).toEqual({ ok: true, message: '接続できました' });
  });

  it('設備がない・削除済みの設備は、NOT_FOUND', async () => {
    const harness = await setup();
    await connectEach(harness);
    const { context } = harness;
    const robot = await context.container.repositories.equipment.get(ROBOT_2_ID);
    if (robot === undefined) {
      throw new Error('テストの前提: ロボットがいます');
    }
    await context.container.repositories.equipment.save({ ...robot, isDeleted: true });

    for (const equipmentId of ['ROBOT-NONE', ROBOT_2_ID]) {
      const error: unknown = await context.container.ingestionService
        .testEquipmentConnection(equipmentId)
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('NOT_FOUND');
    }
  });
});

describe('一覧の再試行（スタブのファイルソース）', () => {
  const meta = (path: string) => ({
    fileId: path,
    name: path,
    modifiedAt: STUB_MODIFIED_AT,
    sizeBytes: 1,
  });

  /** 取り込みサービス（ファイルソースは、一覧の呼び出しごとの振る舞いを指定するスタブ）。 */
  async function buildWithStub(
    listFiles: (
      call: number,
      options: ListFilesOptions | undefined,
    ) => Promise<ReturnType<typeof meta>[]>,
    settings: Partial<typeof DEFAULT_APP_SETTINGS.ingestion> = {},
  ) {
    const { context } = await setup();
    const calls: (readonly string[] | undefined)[] = [];
    const fileSource: FileSourcePort = {
      testEquipment: () => Promise.resolve(),
      listFiles: (_sourceId, options) => {
        calls.push(options?.paths);
        return listFiles(calls.length, options);
      },
      readFile: (_sourceId, fileId) =>
        Promise.resolve(robotFile(fileId === FILE_A ? 'ROBOT-SAMPLE-01' : 'ROBOT-SAMPLE-02')),
    };
    const { container } = context;
    const service = createIngestionService({
      repositories: container.repositories,
      ingestionSettings: container.ingestionSettings,
      fileSource,
      profiles: createDefaultFormatProfileRegistry(),
      evaluation: container.evaluationService,
      notifications: container.notificationService,
      federation: container.federationService,
      clock: context.clock,
      ids: createSequentialIdGenerator('stub'),
      settings: { ...DEFAULT_APP_SETTINGS.ingestion, retryBaseDelayMs: 0, ...settings },
      logger: NULL_LOGGER,
    });
    return { context, service, calls };
  }

  const unavailable = (message: string): FileListFailure => ({
    path: FILE_B,
    error: new FileSourceUnavailableError(message),
  });

  it('失敗したパスの再試行が、一覧そのものの失敗（時間切れ）になっても、取得できたファイルは取り込み、再試行したパスは、失敗のまま', async () => {
    const { context, service, calls } = await buildWithStub(
      (call, options) => {
        if (call === 1) {
          options?.onFailure?.(unavailable('一時的な失敗'));
          return Promise.resolve([meta(FILE_A)]);
        }
        // 一覧の呼び出しが、応答しない（時間切れ）
        return new Promise(() => undefined);
      },
      { ioTimeoutMs: 20 },
    );

    const summary = await service.runSource('robot');

    expect(summary).toMatchObject({ result: 'PARTIAL', filesProcessed: 1, attempts: 3 });
    // 2 回目以降の問い合わせは、失敗したパスだけ
    expect(calls).toEqual([undefined, [FILE_B], [FILE_B]]);
    expect(await logsOf(context, ROBOT_2_ID)).toMatchObject([
      { result: 'FAILURE', errorMessage: 'ファイルサーバーが応答しません' },
    ]);
    expect(await runResultOf(context, ROBOT_2_ID)).toBe('FAILURE');
  });

  it('失敗したパスの再試行が、想定外のエラーになったときは、取り込み元全体の失敗として扱う', async () => {
    const { context, service } = await buildWithStub((call, options) => {
      if (call === 1) {
        options?.onFailure?.(unavailable('一時的な失敗'));
        return Promise.resolve([meta(FILE_A)]);
      }
      return Promise.reject(new Error('想定外'));
    });

    const summary = await service.runSource('robot');

    expect(summary).toMatchObject({ result: 'FAILURE', filesProcessed: 0, attempts: 2 });
    expect(await sourceLogsOf(context)).toMatchObject([
      { result: 'FAILURE', errorMessage: 'ファイルの一覧を取得できませんでした' },
    ]);
  });

  it('失敗したパスの再試行で取得できたファイルは、前回の結果に加わる。持ち主のいないパスの失敗は、設備ごとの失敗にしない', async () => {
    const { context, service, calls } = await buildWithStub((call, options) => {
      if (call === 1) {
        options?.onFailure?.(unavailable('一時的な失敗'));
        options?.onFailure?.({
          path: '/robot/unknown.json',
          error: new FileSourceUnavailableError('持ち主がいない'),
        });
        return Promise.resolve([meta(FILE_A)]);
      }
      // 2 回目: ロボット 2 のファイルが取得できる。持ち主のいないパスは、失敗のまま
      options?.onFailure?.({
        path: '/robot/unknown.json',
        error: new FileSourceUnavailableError('持ち主がいない'),
      });
      return Promise.resolve(options?.paths?.includes(FILE_B) === true ? [meta(FILE_B)] : []);
    });

    const summary = await service.runSource('robot');

    expect(summary).toMatchObject({ result: 'SUCCESS', filesProcessed: 2, recordCount: 2 });
    expect(calls[1]).toEqual(expect.arrayContaining([FILE_B, '/robot/unknown.json']));
    expect(await runResultOf(context, ROBOT_2_ID)).toBe('SUCCESS');
    expect(await notificationsOf(context)).toEqual([]);
  });
});
