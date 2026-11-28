/**
 * シミュレーションのコマンド（`pnpm simulate`。Issue #375）の単体テスト: 引数の検証・本番へ置かないための制限・HTTP の置く処理・状態ファイル・実行と終了コード。
 * 時計・待つ・ファイル・通信は、差し替える（仮想の時計で待たずに流し、実際には、通信しない）。
 */

import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../../src/backend/runtime/config.ts';
import {
  createHttpPut,
  DEFAULT_SIMULATION_ROBOTS,
  DEFAULT_SIMULATION_SENSORS,
  loadScenario,
  parseSimulateArgs,
  runSimulateCli,
  type SimulateCliDeps,
} from '../../../../src/backend/runtime/simulate-cli.ts';
import { STANDARD_DAY_SCENARIO } from '../../../../src/backend/application/simulation/standard-day.ts';

const LOCAL_URL = 'http://127.0.0.1:8791/';
const DEV_URL = 'https://sim-example.invalid/';

const parse = (args: string[], env: Record<string, string> = {}) => parseSimulateArgs(args, env);
const rejects = (args: string[], env: Record<string, string> = {}) =>
  expect(() => parse(args, env));

describe('引数の検証（parseSimulateArgs）: 既定値・書き方', () => {
  it('URL だけ指定すると、既定の設備（ロボット 2 台・センサー 1 台）・標準シナリオ・倍速 60・10 秒ごと・1 日分', () => {
    const options = parse(['--url', LOCAL_URL]);

    expect(options).toMatchObject({
      robots: DEFAULT_SIMULATION_ROBOTS,
      sensors: DEFAULT_SIMULATION_SENSORS,
      scenarioRef: 'standard-day',
      speed: 60,
      tickSeconds: 10,
      startMinute: 0,
      days: 1,
      resume: false,
      dryRun: false,
      local: true,
    });
    expect(options.url).toBe('http://127.0.0.1:8791/');
  });

  it('URL は、環境変数 SIM_FILE_SERVER_URL からも指定できる。引数が優先する', () => {
    expect(parse([], { SIM_FILE_SERVER_URL: LOCAL_URL }).url).toBe('http://127.0.0.1:8791/');
    expect(parse(['--url', 'http://localhost:9000/'], { SIM_FILE_SERVER_URL: LOCAL_URL }).url).toBe(
      'http://localhost:9000/',
    );
  });

  it('設備のパス（--robot・--sensor）は、繰り返して指定でき、指定すると既定を置き換える。順番が、設備の番号になる', () => {
    const options = parse([
      '--url',
      LOCAL_URL,
      '--robot',
      '/robot/sim-a/latest.json',
      '--robot',
      '/robot/sim-b/latest.json',
      '--sensor',
      '/environment-sensor/sim-x/latest.json',
    ]);

    expect(options.robots).toEqual(['/robot/sim-a/latest.json', '/robot/sim-b/latest.json']);
    expect(options.sensors).toEqual(['/environment-sensor/sim-x/latest.json']);
  });

  it('シナリオ・倍速・間隔・開始時刻・日数・再開・状態ファイル・試し実行を、指定できる', () => {
    const options = parse([
      '--url',
      LOCAL_URL,
      '--scenario',
      'my.json',
      '--speed',
      '120',
      '--tick',
      '5',
      '--start-at',
      '12:30',
      '--days',
      '2',
      '--resume',
      '--state-file',
      'state.json',
      '--dry-run',
    ]);

    expect(options).toMatchObject({
      scenarioRef: 'my.json',
      speed: 120,
      tickSeconds: 5,
      startMinute: 750,
      days: 2,
      resume: true,
      stateFile: 'state.json',
      dryRun: true,
    });
  });

  it('URL がなければ、設定エラー', () => {
    rejects([]).toThrow(ConfigError);
    rejects([]).toThrow('--url');
  });

  it.each([
    [['--bogus']],
    [['--speed']],
    [['--speed', '0']],
    [['--speed', 'fast']],
    [['--speed', '100000']],
    [['--tick', '0']],
    [['--tick', '4000']],
    [['--start-at', '25:00']],
    [['--start-at', '9:5']],
    [['--days', '0']],
    [['--days', '31']],
    [['--days', '1.5']],
    [['--state-file']],
    [['--scenario']],
  ])('不正な指定 %j は、設定エラー', (extra) => {
    rejects(['--url', LOCAL_URL, ...extra]).toThrow(ConfigError);
  });
});

describe('引数の検証: 本番へ置かないための制限', () => {
  it('ファイルのパスは、/<robot|environment-sensor>/sim-<名前>/<ファイル>.json だけ。実際の設備のパスに、置けない', () => {
    for (const path of [
      '/robot/latest.json',
      '/robot/real-robot-1/latest.json',
      '/robot/sim-a/sub/latest.json',
      '/robot/sim-a/latest.txt',
      '/robot/sim-a/../x/latest.json',
      '/environment-sensor/sim-a/latest.json', // ロボットの指定に、センサーのパス
      '/robot/sim-A/latest.json',
    ]) {
      rejects(['--url', LOCAL_URL, '--robot', path]).toThrow(ConfigError);
    }
    rejects(['--url', LOCAL_URL, '--sensor', '/robot/sim-a/latest.json']).toThrow(ConfigError);
  });

  it('同じパスを 2 回指定できない', () => {
    rejects([
      '--url',
      LOCAL_URL,
      '--robot',
      '/robot/sim-a/latest.json',
      '--robot',
      '/robot/sim-a/latest.json',
    ]).toThrow('重複');
  });

  it('ローカル（127.0.0.1・localhost・[::1]）以外は、https と --target development が必要。トークンも、環境変数で必要', () => {
    const env = { SIM_WRITE_TOKEN: 'dummy-write-token' };

    expect(parse(['--url', DEV_URL, '--target', 'development'], env)).toMatchObject({
      local: false,
      token: 'dummy-write-token',
    });
    rejects(['--url', DEV_URL], env).toThrow('--target development');
    rejects(['--url', 'http://sim-example.invalid/', '--target', 'development'], env).toThrow(
      'https',
    );
    rejects(['--url', DEV_URL, '--target', 'development']).toThrow('SIM_WRITE_TOKEN');
    for (const local of ['http://127.0.0.1:1/', 'http://localhost:1/', 'http://[::1]:1/']) {
      expect(parse(['--url', local]).local).toBe(true);
    }
  });

  it('--target は development だけ。本番（production など）は、指定できない', () => {
    rejects(['--url', DEV_URL, '--target', 'production'], { SIM_WRITE_TOKEN: 'x' }).toThrow(
      'development',
    );
  });

  it('URL に、認証情報・パス・クエリ・断片を含められない（トークンやホスト名が、ログに漏れる経路を、作らない）', () => {
    for (const url of [
      'http://user:pass@127.0.0.1:1/',
      'http://127.0.0.1:1/robot/',
      'http://127.0.0.1:1/?token=x',
      'http://127.0.0.1:1/#x',
      'ftp://127.0.0.1/',
      'not a url',
    ]) {
      rejects(['--url', url]).toThrow(ConfigError);
    }
  });

  it('エラーのメッセージに、URL（ホスト名）・トークンの値を含めない', () => {
    let message = '';
    try {
      parse(['--url', 'https://secret-host.invalid/robot/x', '--target', 'development'], {
        SIM_WRITE_TOKEN: 'dummy-secret-token',
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).not.toContain('secret-host');
    expect(message).not.toContain('dummy-secret-token');
  });

  it('ローカルで、トークンの指定がなければ、ローカル用のダミーのトークン（dev:file-server と同じ）を使う', () => {
    expect(parse(['--url', LOCAL_URL]).token).toBe('dummy-dev-write-token');
    expect(parse(['--url', LOCAL_URL], { SIM_WRITE_TOKEN: 'dummy-other' }).token).toBe(
      'dummy-other',
    );
  });
});

describe('シナリオの読み込み（loadScenario）', () => {
  it('standard-day は、内蔵の標準シナリオ', async () => {
    const scenario = await loadScenario('standard-day', () => Promise.resolve(undefined));

    expect(scenario.name).toBe('standard-day');
  });

  it('.json のファイルは、読み込んで検証する。ファイルがない・JSON でない・内容が不正なときは、設定エラー（値は、含めない）', async () => {
    const valid = JSON.stringify({ ...STANDARD_DAY_SCENARIO, name: 'custom' });

    expect((await loadScenario('c.json', () => Promise.resolve(valid))).name).toBe('custom');
    await expect(loadScenario('c.json', () => Promise.resolve(undefined))).rejects.toThrow(
      ConfigError,
    );
    await expect(loadScenario('c.json', () => Promise.resolve('{broken'))).rejects.toThrow(
      ConfigError,
    );
    await expect(loadScenario('c.json', () => Promise.resolve('{"name":"x"}'))).rejects.toThrow(
      ConfigError,
    );
  });

  it('standard-day でも .json でもない名前は、設定エラー', async () => {
    await expect(loadScenario('unknown', () => Promise.resolve(undefined))).rejects.toThrow(
      ConfigError,
    );
  });
});

describe('置く処理（createHttpPut）', () => {
  const put = (response: () => Response | Promise<Response>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = createHttpPut({
      baseUrl: 'http://127.0.0.1:8791/',
      token: 'dummy-write-token',
      fetch: (input, init) => {
        calls.push({ url: input, init: init ?? {} });
        return Promise.resolve(response());
      },
    });
    return { fn, calls };
  };

  it('PUT で、パスに、Bearer のトークン・JSON の本文を送る。成功（2xx）は、ok', async () => {
    const { fn, calls } = put(() => new Response(null, { status: 204 }));

    const outcome = await fn('/robot/sim-a/latest.json', '{"a":1}');

    expect(outcome).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('http://127.0.0.1:8791/robot/sim-a/latest.json');
    expect(calls[0]?.init.method).toBe('PUT');
    expect(calls[0]?.init.body).toBe('{"a":1}');
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer dummy-write-token',
      'Content-Type': 'application/json',
    });
  });

  it.each([401, 403, 400, 413])('HTTP %i は、続けても無駄な失敗（fatal）', async (status) => {
    const { fn } = put(() => new Response('x', { status }));

    expect(await fn('/robot/sim-a/latest.json', '{}')).toEqual({
      ok: false,
      fatal: true,
      reason: `HTTP ${String(status)}`,
    });
  });

  it.each([500, 502, 503, 408, 429])('HTTP %i は、一時的な失敗（続ける）', async (status) => {
    const { fn } = put(() => new Response('x', { status }));

    expect(await fn('/robot/sim-a/latest.json', '{}')).toEqual({
      ok: false,
      fatal: false,
      reason: `HTTP ${String(status)}`,
    });
  });

  it('通信の失敗は、一時的な失敗。理由には、エラーの種類だけを入れる（メッセージ・ホスト名は、入れない）', async () => {
    const { fn } = put(() => {
      throw new TypeError('fetch failed: connect ECONNREFUSED secret-host.invalid');
    });

    const outcome = await fn('/robot/sim-a/latest.json', '{}');

    expect(outcome).toEqual({ ok: false, fatal: false, reason: 'ネットワークエラー（TypeError）' });
  });
});

/** 仮想の環境（待つと時刻が進む・ファイルはメモリ・通信は記録だけ）。 */
function environment(
  options: {
    files?: Record<string, string>;
    putStatus?: (call: number) => number;
    stopAfterSleeps?: number;
  } = {},
) {
  let ms = new Date('2026-11-25T01:00:00.000Z').getTime();
  const files = new Map(Object.entries(options.files ?? {}));
  const info: string[] = [];
  const errors: string[] = [];
  const requests: { path: string; body: string }[] = [];
  let sleeps = 0;
  const deps: SimulateCliDeps = {
    output: {
      info: (message) => info.push(message),
      error: (message) => errors.push(message),
    },
    now: () => new Date(ms),
    sleep: (duration) => {
      sleeps += 1;
      ms += duration;
      return Promise.resolve();
    },
    shouldStop: () => options.stopAfterSleeps !== undefined && sleeps >= options.stopAfterSleeps,
    readFile: (path) => Promise.resolve(files.get(path)),
    writeFile: (path, text) => {
      files.set(path, text);
      return Promise.resolve();
    },
    fetch: (input, init) => {
      requests.push({
        path: new URL(input).pathname,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      const status = options.putStatus?.(requests.length) ?? 204;
      return Promise.resolve(new Response(null, { status }));
    },
  };
  return { deps, files, info, errors, requests };
}

describe('実行（runSimulateCli）', () => {
  const base = ['--url', LOCAL_URL, '--state-file', 'state.json'];

  it('標準の一日を流し、すべての設備に、各回ごとに置いて、終了コード 0。開始と完了の案内を出す（ホスト名は出さない）', async () => {
    const { deps, info, requests } = environment();

    const code = await runSimulateCli([...base, '--speed', '240', '--tick', '60'], {}, deps);

    expect(code).toBe(0);
    // 倍速 240・60 秒ごと = 1 回で 4 時間。0・4・8・12・16・20・24 時の 7 回 × 3 設備
    expect(requests).toHaveLength(7 * 3);
    expect(new Set(requests.map((request) => request.path))).toEqual(
      new Set([...DEFAULT_SIMULATION_ROBOTS, ...DEFAULT_SIMULATION_SENSORS]),
    );
    const text = info.join('\n');
    expect(text).toContain('standard-day');
    expect(text).toContain('完了');
    expect(text).not.toContain('127.0.0.1');
  });

  it('回ごとに、シナリオの時刻・何日目・置いた件数・ロボットのステータスを出す', async () => {
    const { deps, info } = environment();

    await runSimulateCli(
      [...base, '--speed', '60', '--tick', '60', '--start-at', '13:00', '--days', '1'],
      {},
      { ...deps, shouldStop: () => false },
    ).catch(() => undefined);

    const line = info.find((message) => message.includes('13:00')) ?? '';
    expect(line).toContain('1 日目');
    expect(line).toContain('3/3');
    expect(line).toContain('sim-robot-1');
    expect(line).toContain('HARVEST_ERROR');
  });

  it('--dry-run は、通信せず、状態ファイルも書かない。その旨を案内する', async () => {
    const { deps, info, requests, files } = environment();

    const code = await runSimulateCli(
      [...base, '--speed', '1440', '--tick', '60', '--dry-run'],
      {},
      deps,
    );

    expect(code).toBe(0);
    expect(requests).toHaveLength(0);
    expect(files.has('state.json')).toBe(false);
    expect(info.join('\n')).toContain('試し実行');
  });

  it('各回のあと、状態ファイルを書く。中断（Ctrl+C 相当）すると、終了コード 0 で、続きの案内を出す', async () => {
    const { deps, info, files } = environment({ stopAfterSleeps: 3 });

    const code = await runSimulateCli([...base, '--speed', '60', '--tick', '60'], {}, deps);

    expect(code).toBe(0);
    const saved = JSON.parse(files.get('state.json') ?? '{}') as Record<string, unknown>;
    expect(saved).toMatchObject({ version: 1, scenario: 'standard-day', minute: 120 });
    expect(info.join('\n')).toContain('--resume');
  });

  it('--resume で、状態ファイルの続きから（時刻・累積を引き継ぎ、終了の時刻も、最初のまま）。終わったあとの再開は、何もしない', async () => {
    const first = environment({ stopAfterSleeps: 3 });
    await runSimulateCli([...base, '--speed', '60', '--tick', '60'], {}, first.deps);
    const second = environment({ files: Object.fromEntries(first.files) });

    const code = await runSimulateCli(
      [...base, '--speed', '60', '--tick', '60', '--resume'],
      {},
      second.deps,
    );

    expect(code).toBe(0);
    expect(second.info.join('\n')).toContain('続きから');
    const robot = second.requests.find((request) => request.path.includes('sim-robot-2'));
    const stoppedAt = first.requests
      .filter((request) => request.path.includes('sim-robot-2'))
      .at(-1);
    expect(JSON.parse(robot?.body ?? '{}')).toMatchObject({
      harvestCount: (JSON.parse(stoppedAt?.body ?? '{}') as { harvestCount: number }).harvestCount,
    });

    const third = environment({ files: Object.fromEntries(second.files) });
    const again = await runSimulateCli(
      [...base, '--speed', '60', '--tick', '60', '--resume'],
      {},
      third.deps,
    );
    expect(again).toBe(0);
    expect(third.requests).toHaveLength(0);
    expect(third.info.join('\n')).toContain('すでに');
  });

  it('--resume で、状態ファイルがなければ、最初から。シナリオ・設備が、状態ファイルと違えば、設定エラー（終了コード 1）', async () => {
    const none = environment();
    expect(
      await runSimulateCli([...base, '--speed', '1440', '--tick', '60', '--resume'], {}, none.deps),
    ).toBe(0);

    const first = environment({ stopAfterSleeps: 2 });
    await runSimulateCli([...base, '--speed', '60', '--tick', '60'], {}, first.deps);
    const mismatch = environment({ files: Object.fromEntries(first.files) });
    const code = await runSimulateCli(
      [...base, '--robot', '/robot/sim-other/latest.json', '--resume'],
      {},
      mismatch.deps,
    );

    expect(code).toBe(1);
    expect(mismatch.errors.join('\n')).toContain('状態ファイル');
  });

  it('壊れた状態ファイルでの --resume は、設定エラー', async () => {
    const { deps, errors } = environment({ files: { 'state.json': '{broken' } });

    const code = await runSimulateCli([...base, '--resume'], {}, deps);

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('状態ファイル');
  });

  it('認証の失敗（HTTP 401）は、終了コード 1。トークンを確認する案内を出し、トークンの値は出さない', async () => {
    const { deps, errors, info } = environment({ putStatus: () => 401 });

    const code = await runSimulateCli([...base], { SIM_WRITE_TOKEN: 'dummy-secret-token' }, deps);

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('401');
    expect([...errors, ...info].join('\n')).not.toContain('dummy-secret-token');
  });

  it('引数が不正なら、案内を出して、終了コード 1（通信しない）', async () => {
    const { deps, errors, requests } = environment();

    const code = await runSimulateCli(['--bogus'], {}, deps);

    expect(code).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(0);
  });

  it('シナリオの JSON ファイルを指定して、流せる', async () => {
    const custom = JSON.stringify({ ...STANDARD_DAY_SCENARIO, name: 'custom' });
    const { deps, info } = environment({ files: { 'custom.json': custom } });

    const code = await runSimulateCli(
      [...base, '--scenario', 'custom.json', '--speed', '1440', '--tick', '60'],
      {},
      deps,
    );

    expect(code).toBe(0);
    expect(info.join('\n')).toContain('custom');
  });
});

describe('実行（runSimulateCli）: そのほかの経路', () => {
  const base = ['--url', LOCAL_URL, '--state-file', 'state.json'];

  it('ローカル以外（開発サイト）への試し実行は、接続先を「開発サイト」と案内する（URL・トークンは出さない）', async () => {
    const { deps, info, requests } = environment();

    const code = await runSimulateCli(
      ['--url', DEV_URL, '--target', 'development', '--dry-run', '--speed', '1440', '--tick', '60'],
      { SIM_WRITE_TOKEN: 'dummy-secret-token' },
      deps,
    );

    const text = info.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('開発サイト');
    expect(text).not.toContain('sim-example');
    expect(text).not.toContain('dummy-secret-token');
    expect(requests).toHaveLength(0);
  });

  it('一時的な失敗が続いて止まったときは、終了コード 1。理由を示し、トークンの案内は出さない', async () => {
    const { deps, errors } = environment({ putStatus: () => 503 });

    const code = await runSimulateCli(base, {}, deps);

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('すべて失敗');
    expect(errors.join('\n')).not.toContain('SIM_WRITE_TOKEN');
  });

  it('状態ファイルの形が違えば（JSON としては読める）、設定エラー', async () => {
    const { deps, errors } = environment({ files: { 'state.json': '{"version":2}' } });

    const code = await runSimulateCli([...base, '--resume'], {}, deps);

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('状態ファイル');
  });

  it('設定の誤りでない予期しない例外は、握りつぶさず、そのまま投げる', async () => {
    const { deps } = environment();

    await expect(
      runSimulateCli(
        [...base, '--scenario', 'x.json'],
        {},
        {
          ...deps,
          readFile: () => Promise.reject(new Error('disk failure')),
        },
      ),
    ).rejects.toThrow('disk failure');
  });

  it('Error でないものが投げられた通信の失敗も、一時的な失敗として扱う', async () => {
    const fn = createHttpPut({
      baseUrl: LOCAL_URL,
      token: 'dummy-write-token',
      // Error でないものが投げられる場合（実際の fetch は、Error を投げるが、境界の防御として確かめる）
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      fetch: () => Promise.reject('refused'),
    });

    expect(await fn('/robot/sim-a/latest.json', '{}')).toEqual({
      ok: false,
      fatal: false,
      reason: 'ネットワークエラー（unknown）',
    });
  });
});
