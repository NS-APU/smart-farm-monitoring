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
  it('現在を含む、直近の区間ごとに、ロボットの JSON と、環境センサーの CSV を、1 つずつ作る', () => {
    const files = buildDemoFeedFiles(NOW, OPTIONS);

    expect(files).toHaveLength(DEMO_FEED_BUCKETS * 2);
    expect(files.map((file) => `${file.sourceId}/${file.name}`)).toEqual([
      'robot/robot-20261020T0330Z.json',
      'environment-sensor/sensor-20261020T0330Z.csv',
      'robot/robot-20261020T0345Z.json',
      'environment-sensor/sensor-20261020T0345Z.csv',
      'robot/robot-20261020T0400Z.json',
      'environment-sensor/sensor-20261020T0400Z.csv',
      'robot/robot-20261020T0415Z.json',
      'environment-sensor/sensor-20261020T0415Z.csv',
    ]);
    expect(
      files
        .filter((file) => file.sourceId === 'robot')
        .every((file) => file.contentType === 'application/json'),
    ).toBe(true);
    expect(
      files
        .filter((file) => file.sourceId !== 'robot')
        .every((file) => file.contentType === 'text/csv'),
    ).toBe(true);
  });

  it('内容は、区間の時刻から決まる（同じ区間は同じ内容。実行の時刻が違っても、同じ区間は同じ）。区間が変われば、値も変わる', () => {
    const first = buildDemoFeedFiles(NOW, OPTIONS);
    const sameBucketLater = buildDemoFeedFiles(new Date('2026-10-20T04:29:59.000Z'), OPTIONS);
    const nextBucket = buildDemoFeedFiles(new Date('2026-10-20T04:31:00.000Z'), OPTIONS);

    expect(sameBucketLater).toEqual(first);
    // 次の区間では、最も古い区間が外れ、新しい区間が増える。重なる区間（04:15 など）は、同じ内容
    const byName = (files: typeof first) => new Map(files.map((file) => [file.name, file.content]));
    expect(byName(nextBucket).get('robot-20261020T0415Z.json')).toBe(
      byName(first).get('robot-20261020T0415Z.json'),
    );
    expect(byName(nextBucket).get('robot-20261020T0430Z.json')).toBeDefined();
    expect(byName(nextBucket).get('robot-20261020T0330Z.json')).toBeUndefined();
    expect(byName(first).get('robot-20261020T0400Z.json')).not.toBe(
      byName(first).get('robot-20261020T0415Z.json'),
    );
  });

  it('ロボットは、FormatProfile（robot-json）が読める形（ロボット ID・1 件の記録）、センサーは、ヘッダーつきの CSV', () => {
    const files = buildDemoFeedFiles(NOW, { intervalMinutes: 15, buckets: 1 });
    const robot = JSON.parse(files[0]?.content ?? '{}') as {
      robotId: string;
      records: Record<string, unknown>[];
    };
    const sensor = (files[1]?.content ?? '').split('\n');

    expect(robot.robotId).toBe('ROBOT-SAMPLE-01');
    expect(robot.records).toHaveLength(1);
    expect(robot.records[0]).toMatchObject({ timestamp: '2026-10-20T04:15:00.000Z' });
    expect(sensor[0]).toBe('sensor_id,timestamp,temperature_c,humidity_pct,illuminance_lx,co2_ppm');
    expect(sensor[1]?.startsWith('SENSOR-SAMPLE-01,2026-10-20T04:15:00.000Z,')).toBe(true);
    expect(sensor[2]).toBe('');
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

    expect(result).toEqual({ files: DEMO_FEED_BUCKETS * 2 });
    expect(s3.keys()).toContain('robot/robot-20261020T0415Z.json');
    expect(s3.keys()).toContain('environment-sensor/sensor-20261020T0415Z.csv');
    expect(s3.contentTypeOf('robot/robot-20261020T0415Z.json')).toBe('application/json');
    expect(s3.contentTypeOf('environment-sensor/sensor-20261020T0415Z.csv')).toBe('text/csv');
    // 置くのは、取り込み元の下だけ
    expect(s3.keys().every((key) => /^(robot|environment-sensor)\//.test(key))).toBe(true);
  });

  it('もう一度実行しても、同じ名前・同じ内容（増えない・内容は変わらない）', async () => {
    const { s3, handler } = setup();
    await handler();
    const before = s3.contentOf('robot/robot-20261020T0415Z.json');

    await handler();

    expect(s3.keys()).toHaveLength(DEMO_FEED_BUCKETS * 2);
    expect(s3.contentOf('robot/robot-20261020T0415Z.json')).toBe(before);
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
    return { container };
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
    expect(await container.repositories.ingestion.lastStartedAt('robot')).not.toBeNull();
  });

  it('同じファイルを、もう一度生成して、取り込んでも、観測値は増えない（取り込み済みの記録）', async () => {
    const { container } = await ingestAfterFeed();
    const first = await container.ingestionService.runSource('robot');

    const second = await container.ingestionService.runSource('robot');

    expect(first).toMatchObject({ result: 'SUCCESS', filesProcessed: DEMO_FEED_BUCKETS });
    expect(second.filesProcessed).toBe(0);
  });
});
