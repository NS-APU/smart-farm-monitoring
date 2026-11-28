/**
 * ローカルのファイルサーバー（`pnpm dev:file-server`。Issue #375）の結合テスト。実際に、手元（127.0.0.1）の HTTP サーバーを起動し、
 * ロボットと同じ `PUT`（書き込み用のダミーのトークン）で置いたファイルを、`GET`・`HEAD`（読み取り用のダミーのトークン）で読めること、
 * 読み取り・書き込みの権限が分かれていること、シミュレーションのコマンド（`pnpm simulate`）が、そのサーバーに置けることを確かめる。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/backend/runtime/config.ts';
import {
  DEV_FILE_SERVER_READ_TOKEN,
  DEV_FILE_SERVER_WRITE_TOKEN,
  parseDevFileServerPort,
  runDevFileServerCli,
  startDevFileServer,
  type DevFileServer,
} from '../../src/backend/runtime/dev-file-server.ts';
import { runSimulateCli } from '../../src/backend/runtime/simulate-cli.ts';

const FILE_PATH = '/robot/sim-robot-1/latest.json';

describe('ローカルのファイルサーバー', () => {
  let server: DevFileServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const request = (
    port: number,
    method: string,
    path: string,
    options: { token?: string; body?: string } = {},
  ) =>
    fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method,
      headers: options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` },
      ...(options.body === undefined ? {} : { body: options.body }),
    });

  it('書き込み用のトークンで置き、読み取り用のトークンで、読める（GET・HEAD）', async () => {
    server = await startDevFileServer({ port: 0 });

    const put = await request(server.port, 'PUT', FILE_PATH, {
      token: DEV_FILE_SERVER_WRITE_TOKEN,
      body: '{"timestamp":"2026-11-25T01:00:00.000Z"}',
    });
    const get = await request(server.port, 'GET', FILE_PATH, { token: DEV_FILE_SERVER_READ_TOKEN });
    const head = await request(server.port, 'HEAD', FILE_PATH, {
      token: DEV_FILE_SERVER_READ_TOKEN,
    });

    expect(put.status).toBe(204);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('{"timestamp":"2026-11-25T01:00:00.000Z"}');
    expect(head.status).toBe(200);
    expect(head.headers.get('last-modified')).not.toBeNull();
  });

  it('読み取り用のトークンでは置けず、書き込み用のトークンでは読めない。トークンなしも、拒否する', async () => {
    server = await startDevFileServer({ port: 0 });

    const writeWithRead = await request(server.port, 'PUT', FILE_PATH, {
      token: DEV_FILE_SERVER_READ_TOKEN,
      body: '{}',
    });
    const readWithWrite = await request(server.port, 'GET', FILE_PATH, {
      token: DEV_FILE_SERVER_WRITE_TOKEN,
    });
    const none = await request(server.port, 'GET', FILE_PATH);

    expect(writeWithRead.status).toBe(401);
    expect(readWithWrite.status).toBe(401);
    expect(none.status).toBe(401);
  });

  it('まだ置いていないファイルは 404。JSON でない内容・空の内容は、400', async () => {
    server = await startDevFileServer({ port: 0 });

    const missing = await request(server.port, 'GET', FILE_PATH, {
      token: DEV_FILE_SERVER_READ_TOKEN,
    });
    const broken = await request(server.port, 'PUT', FILE_PATH, {
      token: DEV_FILE_SERVER_WRITE_TOKEN,
      body: '{broken',
    });

    expect(missing.status).toBe(404);
    expect(broken.status).toBe(400);
  });

  it('1 MiB を超える内容は、413', async () => {
    server = await startDevFileServer({ port: 0 });

    const big = await request(server.port, 'PUT', FILE_PATH, {
      token: DEV_FILE_SERVER_WRITE_TOKEN,
      body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    });

    expect(big.status).toBe(413);
  });

  it('ポートを 0 にすると、空いているポートを使う。起動中のポートを、重ねて使うと、失敗する', async () => {
    server = await startDevFileServer({ port: 0 });

    expect(server.port).toBeGreaterThan(0);
    await expect(startDevFileServer({ port: server.port })).rejects.toThrow();
  });

  it('シミュレーションのコマンドが、ダミーのトークン（既定）で、このサーバーに置ける', async () => {
    server = await startDevFileServer({ port: 0 });
    const info: string[] = [];
    const errors: string[] = [];
    let ms = Date.now();

    const code = await runSimulateCli(
      [
        '--url',
        `http://127.0.0.1:${String(server.port)}/`,
        '--state-file',
        'unused-state.json',
        '--speed',
        '1440',
        '--tick',
        '60',
      ],
      {},
      {
        output: { info: (message) => info.push(message), error: (message) => errors.push(message) },
        now: () => new Date(ms),
        sleep: (duration) => {
          ms += duration;
          return Promise.resolve();
        },
        shouldStop: () => false,
        readFile: () => Promise.resolve(undefined),
        writeFile: () => Promise.resolve(),
        fetch,
      },
    );

    expect(errors).toEqual([]);
    expect(code).toBe(0);
    const robot = await request(server.port, 'GET', '/robot/sim-robot-1/latest.json', {
      token: DEV_FILE_SERVER_READ_TOKEN,
    });
    const sensor = await request(
      server.port,
      'GET',
      '/environment-sensor/sim-sensor-1/latest.json',
      {
        token: DEV_FILE_SERVER_READ_TOKEN,
      },
    );
    expect(robot.status).toBe(200);
    expect(sensor.status).toBe(200);
    expect(JSON.parse(await robot.text())).toHaveProperty('statusCode');
  });
});

describe('ポートの指定（parseDevFileServerPort）・起動の案内（runDevFileServerCli）', () => {
  it('既定は 8791。--port または環境変数 DEV_FILE_SERVER_PORT で指定できる。不正な値は、設定エラー', () => {
    expect(parseDevFileServerPort([], {})).toBe(8791);
    expect(parseDevFileServerPort(['--port', '9100'], {})).toBe(9100);
    expect(parseDevFileServerPort([], { DEV_FILE_SERVER_PORT: '9200' })).toBe(9200);
    expect(parseDevFileServerPort(['--port', '0'], {})).toBe(0);
    for (const args of [['--port'], ['--port', 'abc'], ['--port', '70000']]) {
      expect(() => parseDevFileServerPort(args, {})).toThrow(ConfigError);
    }
  });

  it('起動すると、ローカル専用であること・ダミーのトークン・接続の設定の手順（具体的な画面名）を案内する', async () => {
    const info: string[] = [];

    const started = await runDevFileServerCli(['--port', '0'], {}, { info: (m) => info.push(m) });

    try {
      const text = info.join('\n');
      expect(text).toContain('127.0.0.1');
      expect(text).toContain(DEV_FILE_SERVER_READ_TOKEN);
      expect(text).toContain(DEV_FILE_SERVER_WRITE_TOKEN);
      expect(text).toContain('HTTP_FILE_SOURCE_ALLOW_PRIVATE=true');
      expect(text).toContain('ハウス・設備');
      expect(text).toContain('pnpm simulate');
      expect(text).not.toMatch(/SC-\d+/);
    } finally {
      await started.close();
    }
  });
});
