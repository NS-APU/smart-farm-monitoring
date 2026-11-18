/**
 * ローカルのデモ配信コマンド（`pnpm dev:demo-feed`。Issue #344。ADR-0025）のテスト。手元（127.0.0.1）の HTTP サーバーが、
 * 配信のハンドラの結果（GET は本文つき・HEAD は本文なし・404・405）を返すことと、ポートの指定・案内の表示を確かめる。
 * 空いているポート（0）を使うので、開発サーバー（8787・5173）には触れない。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEMO_FEED_BUCKETS,
  DEMO_FEED_FILE_PATHS,
  DEMO_FEED_INTERVAL_MINUTES,
} from '../../src/backend/application/demo/demo-feed-schedule.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { buildDemoFeedFiles } from '../../src/backend/infrastructure/local/demo-feed-files.ts';
import { ConfigError } from '../../src/backend/runtime/config.ts';
import {
  DEFAULT_DEMO_FEED_PORT,
  type DemoFeedServer,
  parseDemoFeedPort,
  runDemoFeedCli,
  startDemoFeedServer,
} from '../../src/backend/runtime/demo-feed-server.ts';

const NOW = new Date('2026-10-20T04:22:30.000Z');

const started: DemoFeedServer[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.close()));
});

async function start(): Promise<DemoFeedServer> {
  const clock = createControllableClock(NOW);
  clock.freeze(NOW);
  const server = await startDemoFeedServer({ port: 0, clock });
  started.push(server);
  return server;
}

describe('デモ配信の HTTP サーバー（startDemoFeedServer）', () => {
  it('GET: 取り込み元ごとのパスで、合成データを返す（HEAD は、ヘッダーだけ）', async () => {
    const server = await start();
    const base = `http://127.0.0.1:${String(server.port)}`;
    const files = buildDemoFeedFiles(NOW, {
      intervalMinutes: DEMO_FEED_INTERVAL_MINUTES,
      buckets: DEMO_FEED_BUCKETS,
    });

    for (const file of files) {
      const path = DEMO_FEED_FILE_PATHS[file.sourceId];
      const get = await fetch(`${base}${path}`);
      expect(get.status).toBe(200);
      expect(await get.text()).toBe(file.content);
      expect(get.headers.get('last-modified')).toBe('Tue, 20 Oct 2026 04:15:00 GMT');

      const head = await fetch(`${base}${path}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('last-modified')).toBe('Tue, 20 Oct 2026 04:15:00 GMT');
      expect(await head.text()).toBe('');
    }
  });

  it('存在しないパスは 404、GET・HEAD 以外は 405', async () => {
    const server = await start();
    const base = `http://127.0.0.1:${String(server.port)}`;

    expect((await fetch(`${base}/unknown.json`)).status).toBe(404);
    const post = await fetch(`${base}${DEMO_FEED_FILE_PATHS.robot}`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('停止すると、接続を受け付けない', async () => {
    const server = await start();
    const url = `http://127.0.0.1:${String(server.port)}${DEMO_FEED_FILE_PATHS.robot}`;
    await server.close();
    started.splice(0);

    await expect(fetch(url)).rejects.toThrow();
  });
});

describe('ポートの指定（parseDemoFeedPort）', () => {
  it('指定がなければ既定、--port と DEMO_FEED_PORT で指定できる（--port が優先）', () => {
    expect(parseDemoFeedPort([], {})).toBe(DEFAULT_DEMO_FEED_PORT);
    expect(parseDemoFeedPort([], { DEMO_FEED_PORT: ' 18790 ' })).toBe(18790);
    expect(parseDemoFeedPort(['--port', '19000'], { DEMO_FEED_PORT: '18790' })).toBe(19000);
    expect(parseDemoFeedPort(['--port', '0'], {})).toBe(0);
  });

  it.each([['abc'], ['-1'], ['1.5'], ['65536'], ['']])('不正な値（%s）は、設定エラー', (value) => {
    expect(() => parseDemoFeedPort(['--port', value], {})).toThrow(ConfigError);
  });

  it('--port に値がないときは、設定エラー', () => {
    expect(() => parseDemoFeedPort(['--port'], {})).toThrow(ConfigError);
  });
});

describe('コマンド（runDemoFeedCli）', () => {
  it('起動して、使い方（バックエンド側の設定）を表示する', async () => {
    const lines: string[] = [];
    const server = await runDemoFeedCli(['--port', '0'], {}, { info: (line) => lines.push(line) });
    started.push(server);

    const text = lines.join('\n');
    expect(text).toContain(`http://127.0.0.1:${String(server.port)}/`);
    expect(text).toContain(DEMO_FEED_FILE_PATHS.robot);
    expect(text).toContain(DEMO_FEED_FILE_PATHS['environment-sensor']);
    expect(text).toContain('HTTP_FILE_SOURCE_ALLOW_PRIVATE=true');
  });

  it('使われているポートでは、起動に失敗する', async () => {
    const first = await start();

    await expect(startDemoFeedServer({ port: first.port })).rejects.toThrow();
  });
});
