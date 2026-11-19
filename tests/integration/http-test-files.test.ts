/**
 * 取り込みのテスト用の、HTTP のファイルサーバーの補助（tests/support/http-file-server.ts・http-test-files.ts。Issue #344。ADR-0025）のテスト。
 * サーバーの動作（HEAD・GET・更新日時・404・停止・遅延・拒否）と、設備へのファイルのパスの設定（1 設備 = 1 ファイル）、取り込みの通し。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import { ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import { startHttpFileServer, type HttpFileServer } from '../support/http-file-server.ts';
import {
  useHttpFileServer,
  withHttpFiles,
  type HttpTestContext,
} from '../support/http-test-files.ts';
import { createTestContext } from '../support/test-context.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

async function server(): Promise<HttpFileServer> {
  const started = await startHttpFileServer();
  closers.push(() => started.close());
  return started;
}

const urlOf = (file: HttpFileServer, path: string) =>
  `http://127.0.0.1:${String(file.port)}${path}`;

async function context(): Promise<HttpTestContext> {
  const created = await withHttpFiles();
  closers.push(() => created.files.server.close());
  return created;
}

describe('HTTP のテスト用ファイルサーバー（startHttpFileServer）', () => {
  it('GET は内容、HEAD はヘッダーだけ（大きさ・更新日時）を返す。更新日時の指定がなければ、置いた時刻。リクエストを記録する', async () => {
    const file = await server();
    const modifiedAt = new Date('2026-10-09T03:00:00.000Z');
    file.put('/robot/a.json', '{"a":1}', { modifiedAt });
    file.put('/robot/now.json', '{}');
    const before = Date.now();

    const get = await fetch(urlOf(file, '/robot/a.json'));
    const head = await fetch(urlOf(file, '/robot/a.json'), { method: 'HEAD' });
    const now = await fetch(urlOf(file, '/robot/now.json?x=1'), { method: 'HEAD' });

    expect(get.status).toBe(200);
    expect(await get.text()).toBe('{"a":1}');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe('7');
    expect(head.headers.get('last-modified')).toBe(modifiedAt.toUTCString());
    // 指定がなければ、置いた時刻（秒の精度）
    const stamp = Date.parse(now.headers.get('last-modified') ?? '');
    expect(stamp).toBeGreaterThan(before - 2000);
    expect(stamp).toBeLessThanOrEqual(Date.now());
    expect(file.requests).toEqual([
      { method: 'GET', path: '/robot/a.json' },
      { method: 'HEAD', path: '/robot/a.json' },
      { method: 'HEAD', path: '/robot/now.json' },
    ]);
  });

  it('ファイルがなければ 404。消したファイルも 404。更新日時を示さないファイルは、Last-Modified を返さない。reset で、すべて消える', async () => {
    const file = await server();
    file.put('/robot/a.json', '{}');
    file.put('/robot/b.json', '{}', { omitLastModified: true });

    const missing = await fetch(urlOf(file, '/robot/none.json'));
    const noStamp = await fetch(urlOf(file, '/robot/b.json'), { method: 'HEAD' });
    file.remove('/robot/a.json');
    const removed = await fetch(urlOf(file, '/robot/a.json'));
    file.faults.set({ mode: 'REJECT' });
    file.reset();
    const afterReset = await fetch(urlOf(file, '/robot/b.json'));

    expect(missing.status).toBe(404);
    expect(noStamp.headers.get('last-modified')).toBeNull();
    expect(removed.status).toBe(404);
    expect(afterReset.status).toBe(404);
    expect(file.requests).toEqual([{ method: 'GET', path: '/robot/b.json' }]);
    expect(file.faults.get().mode).toBe('UP');
  });

  it('停止（DOWN）は、接続を切る（復旧で、また使える）。拒否（REJECT）は 503。遅延（SLOW）は、指定のミリ秒、応答を遅らせる', async () => {
    const file = await server();
    file.put('/robot/a.json', '{}');

    file.faults.set({ mode: 'DOWN' });
    await expect(fetch(urlOf(file, '/robot/a.json'))).rejects.toThrow();
    file.faults.set({ mode: 'REJECT' });
    const rejected = await fetch(urlOf(file, '/robot/a.json'));
    file.faults.set({ mode: 'SLOW', delayMs: 80 });
    const startedAt = Date.now();
    const slow = await fetch(urlOf(file, '/robot/a.json'));
    const elapsed = Date.now() - startedAt;
    file.faults.set({ mode: 'UP' });
    const recovered = await fetch(urlOf(file, '/robot/a.json'));

    expect(rejected.status).toBe(503);
    expect(slow.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(recovered.status).toBe(200);
    // 停止中のリクエストも、記録する
    expect(file.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'GET', 'GET']);
  });
});

describe('取り込みの HTTP のテスト用ファイルサーバーの準備（useHttpFileServer・withHttpFiles）', () => {
  it('共通の接続は設定しない。ファイルのパスを設定した設備（placeFile・assignPath）の接続を、テスト用のサーバー（127.0.0.1。HTTP・認証なし）にする', async () => {
    const created = await context();
    const expected = {
      type: 'HTTP',
      protocol: 'HTTP',
      host: '127.0.0.1',
      port: created.files.server.port,
      authMethod: 'NONE',
      apiKeyHeaderName: 'X-API-Key',
    };
    expect((await created.container.equipmentConnections.list()).size).toBe(0);

    await created.files.placeFile('robot', 'a.json', '{}');
    await created.files.assignPath(SENSOR_ID, '/environment-sensor/b.json');

    const saved = await created.container.equipmentConnections.list();
    expect([...saved.keys()].sort()).toEqual([ROBOT_ID, SENSOR_ID].sort());
    expect(saved.get(ROBOT_ID)).toEqual(expected);
    expect(saved.get(SENSOR_ID)).toEqual(expected);
  });

  it('placeFile・placeFixture は、取り込み元の種別の設備の sourceFilePath を、/<取り込み元>/<名前> にして、ファイルを置く。取り込みが成功する', async () => {
    const created = await context();

    await created.files.placeFixture('robot', 'robot/robot-sample-001.json');
    await created.files.placeFile(
      'environment-sensor',
      'sensor.json',
      JSON.stringify({
        sensorId: 'SENSOR-SAMPLE-01',
        records: [{ timestamp: '2026-10-09T01:00:00Z', temperatureCelsius: 23 }],
      }),
    );

    const robot = await created.container.repositories.equipment.get(ROBOT_ID);
    const sensor = await created.container.repositories.equipment.get(SENSOR_ID);
    expect(robot?.sourceFilePath).toBe('/robot/robot-sample-001.json');
    expect(sensor?.sourceFilePath).toBe('/environment-sensor/sensor.json');
    const robotRun = await created.container.ingestionService.runSource('robot');
    const sensorRun = await created.container.ingestionService.runSource('environment-sensor');
    expect(robotRun).toMatchObject({ result: 'SUCCESS', filesProcessed: 1, recordCount: 14 });
    expect(sensorRun).toMatchObject({ result: 'SUCCESS', filesProcessed: 1, recordCount: 1 });
  });

  it('同じ設備に、同じパスを置き直せる（上書き）。更新日時を指定できる。asName で、フィクスチャの名前を変えられる', async () => {
    const created = await context();
    await created.files.placeFile('robot', 'a.json', '{}');

    await created.files.placeFile('robot', 'a.json', '{"v":2}', {
      modifiedAt: new Date('2026-10-09T03:00:00.000Z'),
    });
    await created.files.placeFixture('robot', 'robot/robot-sample-001.json', {
      asName: 'a.json',
    });

    const response = await fetch(urlOf(created.files.server, '/robot/a.json'), { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(created.files.server.requests).toHaveLength(1);
    expect((await created.container.repositories.equipment.get(ROBOT_ID))?.sourceFilePath).toBe(
      '/robot/a.json',
    );
  });

  it('同じ設備に、別の名前のファイルを置こうとすると、エラー（HTTP は 1 設備 = 1 ファイル）。別の設備（equipmentId）になら、置ける', async () => {
    const created = await context();
    await created.files.placeFile('robot', 'a.json', '{}');
    const second = toEquipmentId('ROBOT-T2');
    const robot = await created.container.repositories.equipment.get(ROBOT_ID);
    if (robot === undefined) {
      throw new Error('テストの前提: ロボットがいます');
    }
    await created.container.repositories.equipment.save({
      ...robot,
      equipmentId: second,
      externalId: 'ROBOT-SAMPLE-02',
      sourceFilePath: undefined,
    });

    await expect(created.files.placeFile('robot', 'b.json', '{}')).rejects.toThrow(
      '1 設備 = 1 ファイル',
    );
    await created.files.placeFile('robot', 'b.json', '{}', { equipmentId: second });

    expect((await created.container.repositories.equipment.get(second))?.sourceFilePath).toBe(
      '/robot/b.json',
    );
  });

  it('assignPath は、ファイルを置かずに、sourceFilePath だけを設定する（ファイルがない状態）。取り込みは、ファイルなしで成功する（0 件）', async () => {
    const created = await context();

    await created.files.assignPath(ROBOT_ID, '/robot/missing.json');

    const run = await created.container.ingestionService.runSource('robot');
    expect(run).toMatchObject({ result: 'SUCCESS', filesProcessed: 0 });
    expect(created.files.server.requests).toEqual([
      { method: 'HEAD', path: '/robot/missing.json' },
    ]);
    await expect(created.files.assignPath(toEquipmentId('NONE'), '/x.json')).rejects.toThrow(
      '設備があります',
    );
  });

  it('その種別の設備がなければ、エラー。内部のアドレスを許可していないコンテキストでは、準備できない', async () => {
    const created = await context();
    const noEquipment = await createTestContext({
      env: { HTTP_FILE_SOURCE_ALLOW_PRIVATE: 'true' },
    });
    const strict = await createTestContext();

    const prepared = await useHttpFileServer(noEquipment);
    closers.push(() => prepared.files.server.close());

    await expect(prepared.files.placeFile('robot', 'a.json', '{}')).rejects.toThrow(
      'ROBOT の設備があります',
    );
    await expect(useHttpFileServer(strict)).rejects.toThrow('HTTP_FILE_SOURCE_ALLOW_PRIVATE=true');
    await expect(
      created.files.placeFile('robot', 'a.json', '{}', { equipmentId: toEquipmentId('NONE') }),
    ).rejects.toThrow('ROBOT の設備があります');
  });
});
