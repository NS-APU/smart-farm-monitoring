/**
 * デモ用の HTTP ファイル配信（Issue #344。ADR-0025）のテスト。ハンドラ（Function URL のリクエスト・レスポンス）の動作と、
 * 配信を、取り込み（JB-01）の HTTP アダプタが、実際のファイルサーバーと同じ手順（設備ごとの `sourceFilePath` への `HEAD`・`GET`）で読み、
 * 観測値を保存することを確かめる。HTTP サーバーは、手元（127.0.0.1）で、ハンドラを呼ぶだけ。実際の AWS には、接続しない。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEMO_FEED_FILE_PATHS,
  DEMO_FEED_INTERVAL_MINUTES,
} from '../../src/backend/application/demo/demo-feed-schedule.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { buildDemoFeedFiles } from '../../src/backend/infrastructure/local/demo-feed-files.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import {
  buildDemoEquipment,
  DEMO_ROBOT_ID,
  DEMO_SENSOR_ID,
} from '../../src/backend/infrastructure/local/synthetic-data.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { applyDemoFeed, parseDemoFeedUrl } from '../../src/backend/runtime/demo-feed-connection.ts';
import {
  createDemoFeedHttpHandler,
  type DemoFeedHttpEvent,
} from '../../src/backend/runtime/demo-feed-http-lambda.ts';

const OPTIONS = { intervalMinutes: DEMO_FEED_INTERVAL_MINUTES };
// 区間の途中の時刻（UTC 04:22）。区間の開始は、04:15
const NOW = new Date('2026-10-20T04:22:30.000Z');
const BUCKET_START = new Date('2026-10-20T04:15:00.000Z');

function eventOf(method: string | undefined, rawPath: string | undefined): DemoFeedHttpEvent {
  return {
    ...(rawPath === undefined ? {} : { rawPath }),
    ...(method === undefined ? {} : { requestContext: { http: { method } } }),
  };
}

function setupHandler(at: Date = NOW) {
  const clock = createControllableClock(at);
  clock.freeze(at);
  return { clock, handler: createDemoFeedHttpHandler({ clock }) };
}

describe('デモ用の HTTP 配信のハンドラ（createDemoFeedHttpHandler）', () => {
  it('GET: 取り込み元ごとのパスで、合成データのファイルを返す（JSON。Last-Modified は、現在の区間の開始。キャッシュしない）', async () => {
    const { handler } = setupHandler();
    const files = buildDemoFeedFiles(NOW, OPTIONS);

    for (const file of files) {
      const response = await handler(eventOf('GET', DEMO_FEED_FILE_PATHS[file.sourceId]));

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(file.content);
      expect(response.headers).toMatchObject({
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Last-Modified': BUCKET_START.toUTCString(),
      });
    }
  });

  it('HEAD: ヘッダーだけ（本文なし）。GET と同じ Last-Modified を返す', async () => {
    const { handler } = setupHandler();

    const head = await handler(eventOf('head', DEMO_FEED_FILE_PATHS.robot));
    const get = await handler(eventOf('GET', DEMO_FEED_FILE_PATHS.robot));

    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers).toEqual(get.headers);
  });

  it('同じ区間では、同じ内容・同じ Last-Modified。区間が変わると、新しい区間のスナップショット・新しい Last-Modified になる', async () => {
    const early = setupHandler(NOW).handler;
    const sameBucket = setupHandler(new Date('2026-10-20T04:29:59.000Z')).handler;
    const nextBucket = setupHandler(new Date('2026-10-20T04:31:00.000Z')).handler;
    const request = eventOf('GET', DEMO_FEED_FILE_PATHS['environment-sensor']);

    const first = await early(request);
    const second = await sameBucket(request);
    const third = await nextBucket(request);

    expect(second).toEqual(first);
    expect(third.body).not.toBe(first.body);
    expect(third.headers['Last-Modified']).toBe(new Date('2026-10-20T04:30:00.000Z').toUTCString());
    const lastTimestamp = (body: string) => (JSON.parse(body) as { timestamp: string }).timestamp;
    expect(lastTimestamp(first.body)).toBe('2026-10-20T04:15:00.000Z');
    expect(lastTimestamp(third.body)).toBe('2026-10-20T04:30:00.000Z');
  });

  it('GET・HEAD 以外は 405（Allow を示す）。定めたパス以外・パスがないリクエストは 404。いずれも、ファイルの内容を含めない', async () => {
    const { handler } = setupHandler();

    const post = await handler(eventOf('POST', DEMO_FEED_FILE_PATHS.robot));
    const noMethod = await handler(eventOf(undefined, DEMO_FEED_FILE_PATHS.robot));
    const unknownPath = await handler(eventOf('GET', '/robot/other.json'));
    const traversal = await handler(eventOf('GET', '/robot/../environment-sensor/latest.json'));
    const noPath = await handler(eventOf('GET', undefined));

    expect(post.statusCode).toBe(405);
    expect(post.headers.Allow).toBe('GET, HEAD');
    expect(noMethod.statusCode).toBe(405);
    for (const response of [unknownPath, traversal, noPath]) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe('Not Found');
    }
  });
});

describe('デモ用の HTTP 配信を、取り込み（JB-01）が読む', () => {
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

  /** ハンドラを呼ぶだけの、手元の HTTP サーバーを立てて、取り込みの設定（設備・接続）を、HTTP に向けたコンテナを作る。 */
  async function setup() {
    const clock = createControllableClock(NOW);
    clock.freeze(NOW);
    const handler = createDemoFeedHttpHandler({ clock });
    const listening = createServer((request, response) => {
      void handler({
        rawPath: request.url ?? '',
        requestContext: { http: { method: request.method ?? '' } },
      }).then((result) => {
        response.writeHead(result.statusCode, result.headers);
        response.end(request.method === 'HEAD' ? undefined : result.body);
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
    for (const equipment of buildDemoEquipment(NOW)) {
      await container.repositories.equipment.save(equipment);
    }
    // デモの設備は、ファイルのパスを持たない（seed の直後）。コマンド（use-http-feed）と同じ処理で、HTTP の配信に向ける
    await applyDemoFeed(container, parseDemoFeedUrl(`http://127.0.0.1:${String(port)}/`));
    return { container, clock };
  }

  it('デモの設備の sourceFilePath（use-http-feed が設定したもの）ごとに、配信のファイルを取得し、ロボット・環境センサーの観測値を保存する', async () => {
    const { container } = await setup();

    const robot = await container.ingestionService.runSource('robot');
    const sensor = await container.ingestionService.runSource('environment-sensor');

    expect(robot).toMatchObject({ result: 'SUCCESS', filesProcessed: 1 });
    expect(sensor).toMatchObject({ result: 'SUCCESS', filesProcessed: 1 });
    const query = async (equipmentId: typeof DEMO_ROBOT_ID) =>
      (
        await container.repositories.observations.query(
          { equipmentIds: [equipmentId], includeDeleted: true },
          { limit: 200 },
        )
      ).items;
    // 現在の区間のスナップショット 1 つ × 項目（ロボット 6 項目・センサー 4 項目）
    expect(await query(DEMO_ROBOT_ID)).toHaveLength(6);
    expect(await query(DEMO_SENSOR_ID)).toHaveLength(4);
  });

  it('次の区間になると、配信のファイルが新しい区間のスナップショットに変わり、新しい区間の観測値を取り込む（古い区間の観測値は、そのまま残る）', async () => {
    const { container, clock } = await setup();
    await container.ingestionService.runSource('robot');
    const count = async () =>
      (
        await container.repositories.observations.query(
          { equipmentIds: [DEMO_ROBOT_ID], includeDeleted: true },
          { limit: 200 },
        )
      ).items.length;
    const before = await count();
    clock.freeze(new Date('2026-10-20T04:31:00.000Z'));

    const summary = await container.ingestionService.runSource('robot');

    // 新しい区間（04:30）の記録だけ（ロボットは 1 区間 6 項目）
    expect(summary).toMatchObject({ filesProcessed: 1, recordCount: 6 });
    expect(await count()).toBe(before + 6);
  });

  it('同じ区間のうちに、もう一度取り込んでも、観測値は増えない（内容が同じ）。接続テストも成功する', async () => {
    const { container } = await setup();
    await container.ingestionService.runSource('robot');

    const second = await container.ingestionService.runSource('robot');
    const test = await container.ingestionService.testEquipmentConnection(DEMO_ROBOT_ID);

    expect(second.filesProcessed).toBe(0);
    expect(test).toMatchObject({ ok: true });
  });
});
