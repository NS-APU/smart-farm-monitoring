/**
 * 連携キューの 1 項目の大きさ（#195 の #205。ADR-0016 の D-06）の結合テスト。
 * DynamoDB の 1 項目の上限（約 400 KB）を超える観測値（1 つのファイル分）は、複数の項目に分けて積む。
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import { createFederationService } from '../../src/backend/application/federation/federation-service.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import type { FederationItem } from '@smart-farm/shared/schemas/ingestion';
import { DEFAULT_APP_SETTINGS } from '../../src/backend/application/settings.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { createDynamoRepositories } from '../../src/backend/infrastructure/dynamodb/dynamodb-repositories.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import { equipmentSet, ROBOT_ID, SENSOR_EXTERNAL_ID } from '../support/builders.ts';
import {
  createDynamoTestDatabase,
  dropDynamoTestTables,
} from '../support/dynamodb-test-database.ts';
import { createTestContext, TEST_NOW } from '../support/test-context.ts';

afterAll(dropDynamoTestTables);

/** 実際の取り込みの観測値と同じ形（1 件が、JSON で約 300 バイト）。 */
function observations(count: number): Observation[] {
  return Array.from({ length: count }, (_, index) => ({
    equipmentId: ROBOT_ID,
    category: 'OPERATION',
    itemKey: 'batteryLevel',
    observedAt: new Date(Date.UTC(2026, 9, 9, 3, 0, 0) + index * 1000).toISOString(),
    value: 87.5 + index / 1000,
    source: 'AUTO_IMPORT',
    quality: 'VALID',
    receivedAt: '2026-10-09T03:00:05.000Z',
    sourceFileId: '4f1c2d3e-aaaa-bbbb-cccc-1234567890ab',
    formatProfileVersion: 'v1',
    isDeleted: false,
  }));
}

function serviceWith(federation: Parameters<typeof createFederationService>[0]['federation']) {
  const sent: FederationItem[] = [];
  const service = createFederationService({
    federation,
    notifications: { notifyFederationExpired: () => Promise.resolve(null) },
    port: {
      send: (items) => {
        sent.push(...items);
        return Promise.resolve();
      },
    },
    clock: createControllableClock(TEST_NOW),
    ids: createSequentialIdGenerator(),
    settings: DEFAULT_APP_SETTINGS.federation,
    logger: NULL_LOGGER,
  });
  return { service, sent };
}

const enqueueFile = (service: ReturnType<typeof serviceWith>['service'], count: number) =>
  service.enqueue({
    targetType: 'OBSERVATION',
    targetRef: 'robot#big.json',
    payload: { sourceId: 'robot', fileId: 'big.json', observations: observations(count) },
  });

describe('連携キューの 1 項目の大きさ（#205）', () => {
  it('DynamoDB の 1 項目の上限（約 400 KB）を超える観測値（3,500 件。約 1 MB）も、複数の項目に分けて、積める', async () => {
    const database = createDynamoTestDatabase();
    await database.ready;
    const { federation } = createDynamoRepositories({
      client: database.client,
      tables: database.tables,
    });
    const { service, sent } = serviceWith(federation);

    await enqueueFile(service, 3500);

    expect(await federation.countByStatus()).toMatchObject({ PENDING: 4 });
    const summary = await service.runPending();
    expect(summary).toMatchObject({ sent: 4, failed: 0, held: 0 });
    expect(sent.map((item) => item.targetRef)).toEqual([
      'robot#big.json#part-1-of-4',
      'robot#big.json#part-2-of-4',
      'robot#big.json#part-3-of-4',
      'robot#big.json#part-4-of-4',
    ]);
    const total = sent.flatMap((item) => item.payload.observations as unknown[]);
    expect(total).toHaveLength(3500);
    expect(new Set(sent.map((item) => item.federationItemId)).size).toBe(4);
  });

  it('上限以下の件数（1,000 件）は、分割せず、1 項目で、これまでと同じ参照・内容で積む', async () => {
    const { repositories } = createLocalRepositories();
    const { service, sent } = serviceWith(repositories.federation);

    await enqueueFile(service, 1000);
    await service.runPending();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.targetRef).toBe('robot#big.json');
    expect(sent[0]?.payload).not.toHaveProperty('part');
  });

  it('取り込み: 観測値が多いファイル（環境センサーの JSON。700 記録 × 4 項目 = 2,800 件）は、複数の項目に分けて積み、農業情報基盤へ、すべての観測値を送る', async () => {
    const context = await createTestContext();
    for (const equipment of equipmentSet()) {
      await context.container.repositories.equipment.save(equipment);
    }
    const records = Array.from({ length: 700 }, (_, minute) => ({
      timestamp: new Date(TEST_NOW.getTime() - (minute + 1) * 60_000).toISOString(),
      temperatureCelsius: 25 + (minute % 5),
      humidityPercent: 60,
      illuminanceLux: 30000,
      co2Ppm: 900,
    }));
    context.placeFile(
      'environment-sensor',
      'big.json',
      JSON.stringify({ sensorId: SENSOR_EXTERNAL_ID, records }),
    );

    const ingestion = await context.container.ingestionService.runSource('environment-sensor');
    const queue = await context.container.repositories.federation.countByStatus();
    await context.container.jobRunner.run('JB-03');

    expect(ingestion).toMatchObject({ result: 'SUCCESS', recordCount: 2800 });
    // 取り込みの観測値の項目: 1 つのファイル → 1,000・1,000・800 件の 3 項目（評価の結果の項目を除く）
    const received = context.container.dev?.mocks.federation.received() ?? [];
    const parts = received.filter((item) =>
      item.targetRef.startsWith('environment-sensor#big.json'),
    );
    expect(parts.map((item) => item.targetRef)).toEqual([
      'environment-sensor#big.json#part-1-of-3',
      'environment-sensor#big.json#part-2-of-3',
      'environment-sensor#big.json#part-3-of-3',
    ]);
    expect(parts.map((item) => (item.payload.observations as unknown[]).length)).toEqual([
      1000, 1000, 800,
    ]);
    expect(queue.PENDING).toBeGreaterThanOrEqual(3);
    expect(await context.container.repositories.federation.countByStatus()).toMatchObject({
      PENDING: 0,
      FAILED: 0,
      HELD: 0,
    });
  });
});
