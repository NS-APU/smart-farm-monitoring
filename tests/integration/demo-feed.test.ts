/**
 * 合成データの定期生成（擬似のロボット・環境センサー。Issue #77。ADR-0012）のテスト。ファイルの生成の規則・Lambda のハンドラ・
 * 置いたファイルを、取り込み（JB-01）が読んで、観測値を保存することを確かめる。S3 は偽の S3、データはメモリ
 * （実際の AWS には、接続しない）。
 */

import { describe, expect, it } from 'vitest';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import {
  DEMO_FEED_BUCKETS,
  DEMO_FEED_INTERVAL_MINUTES,
} from '../../src/backend/application/demo/demo-feed-schedule.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { buildDemoFeedFiles } from '../../src/backend/infrastructure/local/demo-feed-files.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { createDemoFeedHandler } from '../../src/backend/runtime/demo-feed-lambda.ts';
import { equipmentSet, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import { createFakeS3 } from '../support/fake-s3.ts';

const BUCKET = 'dummy-file-server';
const OPTIONS = { intervalMinutes: DEMO_FEED_INTERVAL_MINUTES, buckets: DEMO_FEED_BUCKETS };
// 区間の途中の時刻（UTC 04:22）。区間の開始は、04:15
const NOW = new Date('2026-10-20T04:22:30.000Z');

describe('合成データのファイルの生成（buildDemoFeedFiles）', () => {
  it('取り込み元ごとに、1 つのファイル（latest.json）を作る。どちらも JSON で、直近の区間の記録を、古い順に持つ（1 つのファイルを随時上書きする方式。ADR-0016 の D-08）', () => {
    const files = buildDemoFeedFiles(NOW, OPTIONS);

    expect(files.map((file) => `${file.sourceId}/${file.name}`)).toEqual([
      'robot/latest.json',
      'environment-sensor/latest.json',
    ]);
    expect(files.every((file) => file.contentType === 'application/json')).toBe(true);
    const timestamps = files.map((file) =>
      (JSON.parse(file.content) as { records: { timestamp: string }[] }).records.map(
        (record) => record.timestamp,
      ),
    );
    const expected = [
      '2026-10-20T03:30:00.000Z',
      '2026-10-20T03:45:00.000Z',
      '2026-10-20T04:00:00.000Z',
      '2026-10-20T04:15:00.000Z',
    ];
    expect(timestamps).toEqual([expected, expected]);
  });

  it('内容は、区間の時刻から決まる（同じ区間は同じ内容。実行の時刻が違っても、同じ区間は同じ）。区間が変われば、最も古い記録が外れ、新しい記録が増える', () => {
    const first = buildDemoFeedFiles(NOW, OPTIONS);
    const sameBucketLater = buildDemoFeedFiles(new Date('2026-10-20T04:29:59.000Z'), OPTIONS);
    const nextBucket = buildDemoFeedFiles(new Date('2026-10-20T04:31:00.000Z'), OPTIONS);

    expect(sameBucketLater).toEqual(first);
    const recordsOf = (files: typeof first) =>
      new Map(
        (
          JSON.parse(files[0]?.content ?? '{}') as {
            records: { timestamp: string }[];
          }
        ).records.map((record) => [record.timestamp, JSON.stringify(record)]),
      );
    const before = recordsOf(first);
    const after = recordsOf(nextBucket);
    // 重なる区間（04:15 など）の記録は、同じ内容。最も古い区間（03:30）は、外れる（消えた行は、取り込みで反映しない）
    expect(after.get('2026-10-20T04:15:00.000Z')).toBe(before.get('2026-10-20T04:15:00.000Z'));
    expect(after.has('2026-10-20T04:30:00.000Z')).toBe(true);
    expect(after.has('2026-10-20T03:30:00.000Z')).toBe(false);
    expect(before.get('2026-10-20T04:00:00.000Z')).not.toBe(before.get('2026-10-20T04:15:00.000Z'));
  });

  it('ロボットは robotId、センサーは sensorId と、記録の配列を持つ（FormatProfile が読める形）', () => {
    const files = buildDemoFeedFiles(NOW, { intervalMinutes: 15, buckets: 1 });
    const robot = JSON.parse(files[0]?.content ?? '{}') as {
      robotId: string;
      records: Record<string, unknown>[];
    };
    const sensor = JSON.parse(files[1]?.content ?? '{}') as {
      sensorId: string;
      records: Record<string, unknown>[];
    };

    expect(robot.robotId).toBe('ROBOT-SAMPLE-01');
    expect(robot.records).toHaveLength(1);
    expect(robot.records[0]).toMatchObject({ timestamp: '2026-10-20T04:15:00.000Z' });
    expect(sensor.sensorId).toBe('SENSOR-SAMPLE-01');
    expect(sensor.records).toHaveLength(1);
    expect(Object.keys(sensor.records[0] ?? {}).sort()).toEqual(
      ['co2Ppm', 'humidityPercent', 'illuminanceLux', 'temperatureCelsius', 'timestamp'].sort(),
    );
  });
});

describe('合成データを生成する Lambda のハンドラ（createDemoFeedHandler）', () => {
  function setup() {
    const s3 = createFakeS3({ bucket: BUCKET });
    const clock = createControllableClock(NOW);
    clock.freeze(NOW);
    const handler = createDemoFeedHandler(
      { FILE_SERVER_S3_BUCKET: BUCKET },
      { client: s3, clock, logger: NULL_LOGGER },
    );
    return { s3, handler };
  }

  it('取り込み元ごとの場所（<バケット>/<取り込み元>/）に、ファイルを置き、置いた数を返す。内容の種類も指定する', async () => {
    const { s3, handler } = setup();

    const result = await handler();

    expect(result).toEqual({ files: 2 });
    expect(s3.keys().sort()).toEqual(['environment-sensor/latest.json', 'robot/latest.json']);
    expect(s3.contentTypeOf('robot/latest.json')).toBe('application/json');
    expect(s3.contentTypeOf('environment-sensor/latest.json')).toBe('application/json');
    // 置くのは、取り込み元の下だけ
    expect(s3.keys().every((key) => /^(robot|environment-sensor)\//.test(key))).toBe(true);
  });

  it('もう一度実行しても、同じファイルを上書きする（増えない。同じ区間なら、内容も変わらない）', async () => {
    const { s3, handler } = setup();
    await handler();
    const before = s3.contentOf('robot/latest.json');

    await handler();

    expect(s3.keys()).toHaveLength(2);
    expect(s3.contentOf('robot/latest.json')).toBe(before);
  });

  it('バケットの指定がなければ、設定エラー。S3 のエラーは、そのまま投げる（再試行はしない）', async () => {
    const s3 = createFakeS3({ bucket: BUCKET });
    const noBucket = createDemoFeedHandler({}, { client: s3, logger: NULL_LOGGER });
    const wrongBucket = createDemoFeedHandler(
      { FILE_SERVER_S3_BUCKET: 'other-bucket' },
      { client: s3, logger: NULL_LOGGER },
    );

    await expect(noBucket()).rejects.toThrow('FILE_SERVER_S3_BUCKET');
    await expect(wrongBucket()).rejects.toMatchObject({ name: 'NoSuchBucket' });
  });
});

describe('置いたファイルの取り込み（JB-01）', () => {
  async function ingestAfterFeed() {
    const s3 = createFakeS3({ bucket: BUCKET });
    const clock = createControllableClock(NOW);
    clock.freeze(NOW);
    const container = createContainer(
      parseConfig({ APP_MODE: 'test', PERSISTENCE: 'memory', FILE_SERVER_S3_BUCKET: BUCKET }),
      {
        clock,
        ids: createSequentialIdGenerator('test'),
        logger: NULL_LOGGER,
        s3Client: s3,
      },
    );
    await container.initialize();
    for (const equipment of equipmentSet()) {
      await container.repositories.equipment.save(equipment);
    }
    await createDemoFeedHandler(
      { FILE_SERVER_S3_BUCKET: BUCKET },
      { client: s3, clock, logger: NULL_LOGGER },
    )();
    return { container, s3, clock };
  }

  it('取り込みのジョブが、置いたファイルを読み、ロボット・環境センサーの観測値を保存して、評価を更新する', async () => {
    const { container } = await ingestAfterFeed();

    await container.jobRunner.run('JB-01');

    const query = (equipmentId: typeof ROBOT_ID) =>
      container.repositories.observations.query(
        { equipmentIds: [equipmentId], includeDeleted: true },
        { limit: 200 },
      );
    const robot = (await query(ROBOT_ID)).items;
    const sensor = (await query(SENSOR_ID)).items;
    // 4 区間 × 項目（ロボット 6 項目・センサー 4 項目）
    expect(robot).toHaveLength(DEMO_FEED_BUCKETS * 6);
    expect(sensor).toHaveLength(DEMO_FEED_BUCKETS * 4);
    expect(new Set(robot.map((item) => item.itemKey))).toEqual(
      new Set([
        'harvestCount',
        'operatingHours',
        'harvestOperatingHours',
        'travelStoppedHours',
        'standbyHours',
        'statusCode',
      ]),
    );
    expect(robot.every((item) => item.source === 'AUTO_IMPORT')).toBe(true);
    // 設備ごとの最終の実行（Issue #201）が、記録されている
    expect(
      (await container.repositories.ingestion.listEquipmentRuns()).get(ROBOT_ID),
    ).toBeDefined();
  });

  it('同じファイルを、もう一度取り込んでも、観測値は増えない（内容のハッシュが同じ）', async () => {
    const { container } = await ingestAfterFeed();
    const first = await container.ingestionService.runSource('robot');

    const second = await container.ingestionService.runSource('robot');

    expect(first).toMatchObject({ result: 'SUCCESS', filesProcessed: 1 });
    expect(second.filesProcessed).toBe(0);
  });

  it('次の区間で、ファイルが上書きされたら、新しい区間の観測値だけを取り込む（消えた古い区間は、反映しない。受信日時は、新しい分だけ）', async () => {
    const { container, s3, clock } = await ingestAfterFeed();
    await container.ingestionService.runSource('robot');
    const before = await container.repositories.observations.query(
      { equipmentIds: [ROBOT_ID], includeDeleted: true },
      { limit: 200 },
    );
    clock.freeze(new Date('2026-10-20T04:31:00.000Z'));
    await createDemoFeedHandler(
      { FILE_SERVER_S3_BUCKET: BUCKET },
      { client: s3, clock, logger: NULL_LOGGER },
    )();
    // 上書きの直後（更新から 1 秒以内）は、読まずに次の周期に回す。読める時刻まで進める
    s3.setModifiedAt('robot/latest.json', new Date('2026-10-20T04:30:00.000Z'));

    const summary = await container.ingestionService.runSource('robot');

    const after = await container.repositories.observations.query(
      { equipmentIds: [ROBOT_ID], includeDeleted: true },
      { limit: 200 },
    );
    expect(summary).toMatchObject({ filesProcessed: 1, recordCount: 6 });
    expect(after.items).toHaveLength(before.items.length + 6);
  });
});
