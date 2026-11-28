/**
 * 自前のファイルサーバー（Issue #298。ADR-0027）の結合テスト。ロボットが `PUT`（書き込み用のトークン）で置いたファイルを、
 * 取り込み（JB-01）の HTTP アダプタが、設備ごとの接続（Bearer。読み取り用のトークン）で `HEAD`・`GET` して、観測値を保存することを確かめる。
 * HTTP サーバーは、手元（127.0.0.1）で、Lambda の入り口を呼ぶだけ。保管先・秘密情報は、メモリ。実際の AWS には、接続しない。
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHostedFileServer,
  HOSTED_FILE_READ_TOKEN_REFERENCE,
  HOSTED_FILE_WRITE_TOKEN_REFERENCE,
} from '../../src/backend/application/hosted-file-server/hosted-file-server.ts';
import { fileServerEquipmentSecretReference } from '../../src/backend/application/ingestion/file-server-credentials.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createMemorySecretPort } from '../../src/backend/infrastructure/local/env-secret.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import {
  buildDemoEquipment,
  DEMO_ROBOT_ID,
  DEMO_SENSOR_ID,
} from '../../src/backend/infrastructure/local/synthetic-data.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { createHostedFileServerLambdaHandler } from '../../src/backend/runtime/hosted-file-server-lambda.ts';
import { FileServerConnectionSchema } from '../../src/shared/schemas/ingestion.ts';
import { FIXTURES_DIRECTORY } from '../support/fixtures-path.ts';
import { createMemoryHostedFileStore } from '../support/memory-hosted-file-store.ts';

const READ_TOKEN = 'dummy-read-token';
const WRITE_TOKEN = 'dummy-write-token';
const NOW = new Date('2026-11-25T04:22:30.000Z');
const ROBOT_PATH = '/robot/robot-a/latest.json';
const SENSOR_PATH = '/environment-sensor/sensor-a/latest.json';

const robotFile = (name: string): string =>
  readFileSync(join(FIXTURES_DIRECTORY, 'file-server', 'robot', name), 'utf8');

describe('自前のファイルサーバーに、ロボットが置き、取り込みが読む', () => {
  let server: Server | undefined;

  afterEach(async () => {
    const closing = server;
    server = undefined;
    if (closing !== undefined) {
      closing.closeAllConnections();
      await new Promise<void>((resolve) => {
        closing.close(() => {
          resolve();
        });
      });
    }
  });

  /** サーバー（Lambda の入り口を呼ぶだけ）を立て、取り込みの設定（設備・接続・読み取り用のトークン）を、そのサーバーに向けたコンテナを作る。 */
  async function setup(options: { readToken?: string } = {}) {
    const clock = createControllableClock(NOW);
    clock.freeze(NOW);
    const store = createMemoryHostedFileStore(() => clock.now());
    const lambda = createHostedFileServerLambdaHandler(
      createHostedFileServer({
        store,
        secrets: createMemorySecretPort({
          [HOSTED_FILE_READ_TOKEN_REFERENCE]: READ_TOKEN,
          [HOSTED_FILE_WRITE_TOKEN_REFERENCE]: WRITE_TOKEN,
        }),
        logger: NULL_LOGGER,
      }),
    );
    const listening = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        void lambda({
          rawPath: (request.url ?? '').split('?')[0] ?? '',
          requestContext: { http: { method: request.method ?? '' } },
          headers: { ...(request.headers as Record<string, string>) },
          ...(body.length === 0 ? {} : { body: body.toString('base64'), isBase64Encoded: true }),
        }).then((result) => {
          response.writeHead(result.statusCode, result.headers);
          response.end(request.method === 'HEAD' ? undefined : result.body);
        });
      });
    });
    server = listening;
    const port = await new Promise<number>((resolve) => {
      listening.listen(0, '127.0.0.1', () => {
        resolve((listening.address() as AddressInfo).port);
      });
    });
    const container = createContainer(
      parseConfig({
        APP_MODE: 'test',
        PERSISTENCE: 'memory',
        HTTP_FILE_SOURCE_ALLOW_PRIVATE: 'true',
      }),
      { clock, ids: createSequentialIdGenerator('test'), logger: NULL_LOGGER },
    );
    await container.initialize();
    const paths = { [DEMO_ROBOT_ID]: ROBOT_PATH, [DEMO_SENSOR_ID]: SENSOR_PATH };
    for (const equipment of buildDemoEquipment(NOW)) {
      const sourceFilePath = paths[equipment.equipmentId as keyof typeof paths];
      if (sourceFilePath !== undefined) {
        await container.repositories.equipment.save({ ...equipment, sourceFilePath });
      }
    }
    // 設備ごとの接続（Bearer）と、読み取り用のトークン（SC-10 の「認証情報」が登録するものと同じ場所）
    const connection = FileServerConnectionSchema.parse({
      type: 'HTTP',
      protocol: 'HTTP',
      host: '127.0.0.1',
      port,
      authMethod: 'BEARER',
    });
    for (const equipmentId of [DEMO_ROBOT_ID, DEMO_SENSOR_ID]) {
      await container.equipmentConnections.save(equipmentId, { ...connection });
      await container.secrets.set(
        fileServerEquipmentSecretReference(equipmentId),
        options.readToken ?? READ_TOKEN,
      );
    }
    const robotPut = (path: string, body: string, token: string = WRITE_TOKEN) =>
      fetch(`http://127.0.0.1:${String(port)}${path}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
      });
    return { container, clock, store, robotPut };
  }

  const observationCount = async (
    container: Awaited<ReturnType<typeof setup>>['container'],
    equipmentId: typeof DEMO_ROBOT_ID,
  ) =>
    (
      await container.repositories.observations.query(
        { equipmentIds: [equipmentId], includeDeleted: true },
        { limit: 200 },
      )
    ).items.length;

  it('ロボットが PUT したファイルを、取り込み（Bearer の GET・HEAD）が読み、観測値を保存する。接続テストも成功する', async () => {
    const { container, clock, robotPut } = await setup();
    const put = await robotPut(ROBOT_PATH, robotFile('robot-sample-001.json'));
    // 書き換えの直後（更新日時が 1 秒以内）のファイルは、次の周期に回すため、時間を進める
    clock.freeze(new Date(NOW.getTime() + 5_000));

    const summary = await container.ingestionService.runSource('robot');
    const test = await container.ingestionService.testEquipmentConnection(DEMO_ROBOT_ID);

    expect(put.status).toBe(204);
    expect(summary).toMatchObject({ result: 'SUCCESS', filesProcessed: 1 });
    expect(await observationCount(container, DEMO_ROBOT_ID)).toBeGreaterThan(0);
    expect(test).toMatchObject({ ok: true });
  });

  it('同じ内容のままなら、もう一度取り込んでも観測値は増えない。ロボットが内容を更新して PUT すると、新しい値を取り込む', async () => {
    const { container, clock, robotPut } = await setup();
    await robotPut(ROBOT_PATH, robotFile('robot-sample-001.json'));
    clock.freeze(new Date(NOW.getTime() + 5_000));
    await container.ingestionService.runSource('robot');
    const first = await observationCount(container, DEMO_ROBOT_ID);

    const unchanged = await container.ingestionService.runSource('robot');
    const afterUnchanged = await observationCount(container, DEMO_ROBOT_ID);
    // ロボットが、次の計測のスナップショットで、ファイルを上書きする
    const updated = JSON.stringify({
      ...(JSON.parse(robotFile('robot-sample-001.json')) as Record<string, unknown>),
      timestamp: '2026-10-09T01:01:00Z',
      harvestCount: 13,
    });
    const overwrite = await robotPut(ROBOT_PATH, updated);
    clock.freeze(new Date(NOW.getTime() + 10_000));
    const changed = await container.ingestionService.runSource('robot');

    expect(unchanged.filesProcessed).toBe(0);
    expect(afterUnchanged).toBe(first);
    expect(overwrite.status).toBe(204);
    expect(changed.filesProcessed).toBe(1);
    expect(await observationCount(container, DEMO_ROBOT_ID)).toBeGreaterThan(first);
  });

  it('ファイルがまだ置かれていない設備は、取り込みの対象にならない（失敗にしない）。置かれた設備のファイルは、取り込む', async () => {
    const { container, clock, robotPut } = await setup();
    await robotPut(ROBOT_PATH, robotFile('robot-sample-001.json'));
    clock.freeze(new Date(NOW.getTime() + 5_000));

    const sensor = await container.ingestionService.runSource('environment-sensor');
    const robot = await container.ingestionService.runSource('robot');

    expect(sensor).toMatchObject({ result: 'SUCCESS', filesProcessed: 0 });
    expect(robot).toMatchObject({ result: 'SUCCESS', filesProcessed: 1 });
  });

  it('読み取り用のトークンが違うと、接続テストは「認証に失敗しました」。書き込み用のトークンを、読み取りに登録しても通らない', async () => {
    const wrong = await setup({ readToken: 'dummy-wrong-token' });
    const writeAsRead = await setup({ readToken: WRITE_TOKEN });

    const wrongResult =
      await wrong.container.ingestionService.testEquipmentConnection(DEMO_ROBOT_ID);
    const writeAsReadResult =
      await writeAsRead.container.ingestionService.testEquipmentConnection(DEMO_ROBOT_ID);

    expect(wrongResult).toMatchObject({
      ok: false,
      message: expect.stringContaining('認証に失敗'),
    });
    expect(writeAsReadResult).toMatchObject({
      ok: false,
      message: expect.stringContaining('認証に失敗'),
    });
  });

  it('JSON でないファイルは、置けない（PUT が 400）。すでに置いたファイルは、そのまま取り込める', async () => {
    const { container, clock, robotPut } = await setup();
    await robotPut(ROBOT_PATH, robotFile('robot-sample-001.json'));

    const broken = await robotPut(ROBOT_PATH, '{"timestamp":');
    clock.freeze(new Date(NOW.getTime() + 5_000));
    const summary = await container.ingestionService.runSource('robot');

    expect(broken.status).toBe(400);
    expect(summary).toMatchObject({ result: 'SUCCESS', filesProcessed: 1 });
  });
});
