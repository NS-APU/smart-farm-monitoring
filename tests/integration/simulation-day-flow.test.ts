/**
 * シミュレーション（`pnpm simulate`。Issue #375）の一日の流れの結合テスト。仮想の時計で、標準シナリオの 12:00〜14:30 を高速に流し、
 * 実際のファイルサーバー（手元の HTTP サーバー。中核は、開発サイトと同じ）へ、シミュレーションが、ロボットと同じ `PUT` で置き、
 * 取り込み（JB-01）が読んで観測値にし、評価（JB-02）が、13:00 台の収穫異常と、13:20 前後の高温から、通知（STATUS_CHANGE）を作るところまでを確かめる。
 * 保管先・秘密情報は、メモリ。実際の AWS には、接続しない。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { toUserId } from '@smart-farm/shared/schemas/common';
import {
  createHostedFileServer,
  HOSTED_FILE_READ_TOKEN_REFERENCE,
  HOSTED_FILE_WRITE_TOKEN_REFERENCE,
} from '../../src/backend/application/hosted-file-server/hosted-file-server.ts';
import { fileServerEquipmentSecretReference } from '../../src/backend/application/ingestion/file-server-credentials.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { minutesOf, parseScenario } from '../../src/backend/application/simulation/scenario.ts';
import { runSimulation } from '../../src/backend/application/simulation/simulator.ts';
import { STANDARD_DAY_SCENARIO } from '../../src/backend/application/simulation/standard-day.ts';
import { createMemorySecretPort } from '../../src/backend/infrastructure/local/env-secret.ts';
import { createMemoryHostedFileStore } from '../../src/backend/infrastructure/local/memory-hosted-file-store.ts';
import { createHostedFileServerLambdaHandler } from '../../src/backend/runtime/hosted-file-server-lambda.ts';
import { createHttpPut } from '../../src/backend/runtime/simulate-cli.ts';
import { FileServerConnectionSchema } from '../../src/shared/schemas/ingestion.ts';
import { ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import { HTTP_FILES_ENV } from '../support/http-test-files.ts';
import { TEST_USER, withEquipment } from '../support/test-context.ts';

const READ_TOKEN = 'dummy-read-token';
const WRITE_TOKEN = 'dummy-write-token';
const NOW = new Date('2026-11-25T01:00:00.000Z');
const ROBOT_PATH = '/robot/sim-robot-1/latest.json';
const SENSOR_PATH = '/environment-sensor/sim-sensor-1/latest.json';
const SCENARIO = parseScenario(STANDARD_DAY_SCENARIO);

describe('シミュレーションの一日の流れ（置く → 取り込み → 評価 → 通知）', () => {
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

  async function setup() {
    const context = await withEquipment({ env: HTTP_FILES_ENV, now: NOW });
    const { container, clock } = context;
    clock.freeze(NOW);
    const lambda = createHostedFileServerLambdaHandler(
      createHostedFileServer({
        store: createMemoryHostedFileStore(clock),
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
    const paths = { [ROBOT_ID]: ROBOT_PATH, [SENSOR_ID]: SENSOR_PATH };
    for (const [equipmentId, sourceFilePath] of Object.entries(paths)) {
      const equipment = (await container.repositories.equipment.list()).find(
        (item) => item.equipmentId === equipmentId,
      );
      if (equipment !== undefined) {
        await container.repositories.equipment.save({ ...equipment, sourceFilePath });
      }
    }
    const connection = FileServerConnectionSchema.parse({
      type: 'HTTP',
      protocol: 'HTTP',
      host: '127.0.0.1',
      port,
      authMethod: 'BEARER',
    });
    for (const equipmentId of [ROBOT_ID, SENSOR_ID]) {
      await container.equipmentConnections.save(equipmentId, { ...connection });
      await container.secrets.set(fileServerEquipmentSecretReference(equipmentId), READ_TOKEN);
    }
    return { container, clock, port };
  }

  it('12:00〜14:30 を流すと、毎回の取り込みで新しい観測値が増え、昼の高温（注意 → 異常）と、13:00 台のロボットの異常が、通知になる', async () => {
    const { container, clock, port } = await setup();
    const user = toUserId(TEST_USER.userId);
    const processed: number[] = [];
    const robotStatuses: string[] = [];
    const notified: Record<string, [string, string][]> = {};

    const result = await runSimulation(
      {
        scenario: SCENARIO,
        equipment: [
          { kind: 'robot', path: ROBOT_PATH, index: 1 },
          { kind: 'sensor', path: SENSOR_PATH, index: 1 },
        ],
        speed: 10,
        tickSeconds: 60,
        startMinute: minutesOf('12:00'),
        endMinute: minutesOf('14:30'),
      },
      {
        now: () => clock.now(),
        sleep: (milliseconds) => clock.sleep(milliseconds),
        put: createHttpPut({
          baseUrl: `http://127.0.0.1:${String(port)}/`,
          token: WRITE_TOKEN,
          fetch: (input, init) => fetch(input, init),
        }),
        onTick: async (info) => {
          // 書き換えの直後（更新日時が 1 秒以内）のファイルは、次の周期に回すため、時間を進めてから、取り込む
          clock.freeze(new Date(clock.now().getTime() + 2_000));
          const robot = await container.ingestionService.runSource('robot');
          const sensor = await container.ingestionService.runSource('environment-sensor');
          processed.push(robot.filesProcessed + sensor.filesProcessed);
          robotStatuses.push(info.files.find((file) => file.path === ROBOT_PATH)?.status ?? '');
          if (['12:30', '13:40'].includes(info.clock)) {
            await container.evaluationService.evaluateAll('DEV');
            const items = (
              await container.repositories.notifications.list(user, {}, { limit: 100 })
            ).items;
            notified[info.clock] = items.map(({ notification }) => [
              `${notification.equipmentId}/${notification.viewpointId}`,
              `${notification.kind}:${notification.status}`,
            ]);
          }
        },
      },
    );

    expect(result).toMatchObject({ endedBy: 'completed', putFailures: 0, ticks: 16 });
    // 毎回、ロボット・センサーの 2 ファイルを、取り込む（計測日時は、置いた時刻。許容の範囲に収まる）
    expect(processed).toEqual(Array.from({ length: 16 }, () => 2));
    expect(robotStatuses).toContain('HARVEST_ERROR');
    expect(robotStatuses).toContain('STOPPED');
    expect(robotStatuses.at(-1)).toBe('HARVESTING');

    const observations = (
      await container.repositories.observations.query(
        { equipmentIds: [ROBOT_ID, SENSOR_ID], includeDeleted: true },
        { limit: 1000 },
      )
    ).items;
    const valuesOf = (itemKey: string) =>
      observations
        .filter((item) => item.itemKey === itemKey)
        .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
        .map((item) => Number(item.value));
    expect(valuesOf('temperatureCelsius')).toHaveLength(16);
    expect(Math.max(...valuesOf('temperatureCelsius'))).toBeGreaterThanOrEqual(35);
    const harvestCounts = valuesOf('harvestCount');
    expect(harvestCounts).toHaveLength(16);
    expect(harvestCounts).toEqual([...harvestCounts].sort((left, right) => left - right));
    expect(harvestCounts.at(-1)).toBeGreaterThan(harvestCounts[0] ?? 0);

    // 12:30（異常の前）: 昼の温度は「注意」。ロボットの通知は、まだない
    expect(notified['12:30']).toContainEqual([
      `${SENSOR_ID}/environmentalAdaptability`,
      'STATUS_CHANGE:CAUTION',
    ]);
    expect(notified['12:30']?.some(([target]) => target.startsWith(`${ROBOT_ID}/`))).toBe(false);
    // 13:40（異常の後）: 温度が 35℃ 以上で「異常」になり、1 台目のロボットの停止が、通知になる
    expect(notified['13:40']).toContainEqual([
      `${SENSOR_ID}/environmentalAdaptability`,
      'STATUS_CHANGE:ERROR',
    ]);
    expect(notified['13:40']).toContainEqual([`${ROBOT_ID}/harvestSpeed`, 'STATUS_CHANGE:ERROR']);
  }, 60_000);
});
