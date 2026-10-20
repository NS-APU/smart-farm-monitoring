/**
 * 取り込み（JB-01）が、S3 のファイルサーバーのモックのファイルを読んで、観測値を保存し、評価を更新する結合テスト
 * （Issue #77。ADR-0012）。環境変数 `FILE_SERVER_S3_BUCKET` で、組み立てが S3 版を選ぶことも、確認する。
 * S3 は偽の S3、データはメモリ（実際の AWS には、接続しない）。置くファイルは、合成データのフィクスチャ。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { equipmentSet, FACILITY_ID, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import { createFakeS3 } from '../support/fake-s3.ts';
import { FIXTURES_DIRECTORY } from '../support/fixtures-path.ts';
import { TEST_NOW } from '../support/test-context.ts';

const BUCKET = 'dummy-file-server';

async function setup(env: Record<string, string> = {}) {
  const s3 = createFakeS3({ bucket: BUCKET });
  const container = createContainer(
    parseConfig({
      APP_MODE: 'test',
      PERSISTENCE: 'memory',
      FILE_SERVER_S3_BUCKET: BUCKET,
      ...env,
    }),
    {
      clock: createControllableClock(TEST_NOW),
      ids: createSequentialIdGenerator('test'),
      logger: NULL_LOGGER,
      s3Client: s3,
    },
  );
  await container.initialize();
  for (const equipment of equipmentSet()) {
    await container.repositories.equipment.save(equipment);
  }
  const putFixture = (sourceId: string, fixture: string) => {
    const name = fixture.split('/').pop() ?? fixture;
    s3.putObject(
      `${sourceId}/${name}`,
      readFileSync(join(FIXTURES_DIRECTORY, 'file-server', fixture), 'utf8'),
      TEST_NOW,
    );
  };
  return { s3, container, putFixture };
}

describe('S3 のファイルサーバーのモックからの取り込み（JB-01。Issue #77）', () => {
  it('ジョブ（JB-01）が、S3 のロボット・環境センサーのファイルを読み、観測値を保存して、評価を更新する', async () => {
    const { container, putFixture } = await setup();
    putFixture('robot', 'robot/robot-sample-001.json');
    putFixture('environment-sensor', 'environment-sensor/sensor-sample-001.csv');

    const result = await container.jobRunner.run('JB-01');

    expect(result).toMatchObject({ jobId: 'JB-01' });
    const query = (equipmentId: typeof ROBOT_ID) =>
      container.repositories.observations.query(
        { equipmentIds: [equipmentId], includeDeleted: true },
        { limit: 100 },
      );
    const robot = (await query(ROBOT_ID)).items;
    const sensor = (await query(SENSOR_ID)).items;
    expect(robot).toHaveLength(14);
    expect(sensor.length).toBeGreaterThan(0);
    expect(robot.every((item) => item.sourceFileId === 'robot-sample-001.json')).toBe(true);
    const latest = await container.repositories.evaluations.listLatest(FACILITY_ID);
    expect(latest.length).toBeGreaterThan(0);
  });

  it('同じファイルを、もう一度取り込んでも、観測値は増えない（取り込み済みの記録）', async () => {
    const { container, putFixture } = await setup();
    putFixture('robot', 'robot/robot-sample-001.json');

    const first = await container.ingestionService.runSource('robot');
    const second = await container.ingestionService.runSource('robot');

    expect(first).toMatchObject({ result: 'SUCCESS', filesProcessed: 1, recordCount: 14 });
    expect(second.filesProcessed).toBe(0);
  });

  it('接続テストは、バケットを一覧できれば成功する。バケットがない（設定の誤り）ときは失敗する', async () => {
    const { container } = await setup();
    const wrong = await setup({ FILE_SERVER_S3_BUCKET: 'other-bucket' });

    await expect(container.ingestionService.testConnection('robot')).resolves.toMatchObject({
      ok: true,
    });
    await expect(wrong.container.ingestionService.testConnection('robot')).resolves.toMatchObject({
      ok: false,
    });
  });
});
