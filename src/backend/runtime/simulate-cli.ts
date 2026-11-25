/**
 * シミュレーションのコマンド（`pnpm simulate`。Issue #375）。一日を通して変化するロボット・環境センサーのファイルを、ロボットと同じ `PUT` で、
 * ファイルサーバー（ローカルの `pnpm dev:file-server`、または開発サイトの自前ファイルサーバー。ADR-0027）に置く。使い方は docs/40_operations/simulation.md。
 *
 * 安全のための制限（本番・実際の設備のデータを、壊さないため）:
 * - 置けるのは、`/<robot|environment-sensor>/sim-<名前>/<ファイル>.json` だけ（実際の設備のパスには、置けない）
 * - ローカル（127.0.0.1・localhost・[::1]）以外は、https と `--target development` が必要（`--target` は、development だけ。本番は、対象外）
 * - 書き込み用のトークンは、環境変数 `SIM_WRITE_TOKEN` だけ（引数・出力に出さない）。URL（ホスト名）も、出力しない
 */

import { FilePathSchema } from '@smart-farm/shared/schemas/file-path';
import { z } from 'zod';
import {
  DAY_MINUTES,
  minutesOf,
  parseScenario,
  ScenarioError,
  type Scenario,
} from '../application/simulation/scenario.ts';
import {
  runSimulation,
  type PutOutcome,
  type SimulationEquipment,
  type SimulationResult,
  type SimulationState,
  type TickInfo,
} from '../application/simulation/simulator.ts';
import { STANDARD_DAY_SCENARIO } from '../application/simulation/standard-day.ts';
import { ConfigError } from './config.ts';
import { DEV_FILE_SERVER_WRITE_TOKEN } from './dev-file-server-tokens.ts';

export const DEFAULT_SIMULATION_ROBOTS: readonly string[] = [
  '/robot/sim-robot-1/latest.json',
  '/robot/sim-robot-2/latest.json',
];
export const DEFAULT_SIMULATION_SENSORS: readonly string[] = [
  '/environment-sensor/sim-sensor-1/latest.json',
];
export const DEFAULT_STATE_FILE = '.local-data/simulation-state.json';

const SCENARIO_NAME_STANDARD = 'standard-day';
const WRITE_TOKEN_ENV = 'SIM_WRITE_TOKEN';
const URL_ENV = 'SIM_FILE_SERVER_URL';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const PUT_TIMEOUT_MS = 10_000;

export interface SimulateOptions {
  /** ファイルサーバーの URL（正規化済み。出力しない）。 */
  readonly url: string;
  readonly local: boolean;
  /** 書き込み用のトークン（出力しない）。 */
  readonly token: string;
  readonly robots: readonly string[];
  readonly sensors: readonly string[];
  /** 標準シナリオの名前（`standard-day`）、または JSON のファイルのパス。 */
  readonly scenarioRef: string;
  readonly speed: number;
  readonly tickSeconds: number;
  readonly startMinute: number;
  readonly days: number;
  readonly resume: boolean;
  readonly stateFile: string;
  readonly dryRun: boolean;
}

const KIND_PATH_PATTERNS = {
  robot: /^\/robot\/sim-[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._-]+\.json$/,
  sensor: /^\/environment-sensor\/sim-[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._-]+\.json$/,
} as const;

function validatePaths(kind: 'robot' | 'sensor', paths: readonly string[]): void {
  const flag = kind === 'robot' ? '--robot' : '--sensor';
  const directory = kind === 'robot' ? '/robot/' : '/environment-sensor/';
  for (const path of paths) {
    if (!FilePathSchema.safeParse(path).success || !KIND_PATH_PATTERNS[kind].test(path)) {
      throw new ConfigError(
        `${flag} のパスは、${directory}sim-<名前>/<ファイル名>.json の形で指定してください（シミュレーション専用のパスだけ。実際の設備のパスには置けません）`,
      );
    }
  }
}

function parseNumber(flag: string, text: string, min: number, max: number): number {
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${flag} には、${String(min)}〜${String(max)} の数値を指定してください`);
  }
  return value;
}

function parseUrl(text: string | undefined): { url: string; local: boolean; https: boolean } {
  if (text === undefined || text === '') {
    throw new ConfigError(
      `--url（または環境変数 ${URL_ENV}）に、ファイルサーバーの URL を指定してください`,
    );
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError('--url の形式が正しくありません');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('--url は、http または https の URL を指定してください');
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new ConfigError(
      '--url には、スキーム・ホスト（・ポート）だけを指定してください（認証情報・パス・クエリは、含められません）',
    );
  }
  return { url: url.href, local: LOCAL_HOSTS.has(url.hostname), https: url.protocol === 'https:' };
}

/** コマンドの引数（と環境変数）を、検証して読む。不正な指定は、設定エラー（メッセージに、URL・トークンの値を含めない）。 */
export function parseSimulateArgs(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): SimulateOptions {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  const valueFlags = new Set([
    '--url',
    '--robot',
    '--sensor',
    '--scenario',
    '--speed',
    '--tick',
    '--start-at',
    '--days',
    '--state-file',
    '--target',
  ]);
  const switchFlags = new Set(['--resume', '--dry-run']);
  const queue = [...args];
  for (let flag = queue.shift(); flag !== undefined; flag = queue.shift()) {
    if (switchFlags.has(flag)) {
      switches.add(flag);
    } else if (valueFlags.has(flag)) {
      const value = queue.shift();
      if (value === undefined || value.startsWith('--')) {
        throw new ConfigError(`${flag} には、値を指定してください`);
      }
      values.set(flag, [...(values.get(flag) ?? []), value]);
    } else {
      throw new ConfigError(`不明な引数です: ${flag}`);
    }
  }
  const last = (flag: string): string | undefined => values.get(flag)?.at(-1);

  const { url, local, https } = parseUrl(last('--url') ?? env[URL_ENV]?.trim());
  const robots = values.get('--robot') ?? DEFAULT_SIMULATION_ROBOTS;
  const sensors = values.get('--sensor') ?? DEFAULT_SIMULATION_SENSORS;
  validatePaths('robot', robots);
  validatePaths('sensor', sensors);
  if (new Set([...robots, ...sensors]).size !== robots.length + sensors.length) {
    throw new ConfigError('設備のパスが、重複しています');
  }

  const target = last('--target');
  if (target !== undefined && target !== 'development') {
    throw new ConfigError('--target には、development だけを指定できます（本番は、対象外です）');
  }
  let token = env[WRITE_TOKEN_ENV]?.trim();
  if (!local) {
    if (!https) {
      throw new ConfigError('ローカル以外の接続先は、https の URL だけを指定できます');
    }
    if (target !== 'development') {
      throw new ConfigError(
        'ローカル以外（開発サイト）へ置くには、--target development の指定が必要です（本番へは、置けません）',
      );
    }
    if (token === undefined || token === '') {
      throw new ConfigError(
        `書き込み用のトークンを、環境変数 ${WRITE_TOKEN_ENV} に設定してください`,
      );
    }
  }
  token = token === undefined || token === '' ? DEV_FILE_SERVER_WRITE_TOKEN : token;

  const startAt = last('--start-at');
  if (startAt !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(startAt)) {
    throw new ConfigError('--start-at には、HH:MM（00:00〜23:59）を指定してください');
  }
  const numberOption = (flag: string, min: number, max: number, fallback: number): number => {
    const text = last(flag);
    return text === undefined ? fallback : parseNumber(flag, text, min, max);
  };
  const days = numberOption('--days', 1, 30, 1);
  if (!Number.isInteger(days)) {
    throw new ConfigError('--days には、1〜30 の整数を指定してください');
  }

  return {
    url,
    local,
    token,
    robots,
    sensors,
    scenarioRef: last('--scenario') ?? SCENARIO_NAME_STANDARD,
    speed: numberOption('--speed', 0.01, 86_400, 60),
    tickSeconds: numberOption('--tick', 1, 3600, 10),
    startMinute: startAt === undefined ? 0 : minutesOf(startAt),
    days,
    resume: switches.has('--resume'),
    stateFile: last('--state-file') ?? DEFAULT_STATE_FILE,
    dryRun: switches.has('--dry-run'),
  };
}

/** シナリオを読む（`standard-day` は内蔵。`.json` は、ファイルを読んで検証する）。 */
export async function loadScenario(
  ref: string,
  readFile: (path: string) => Promise<string | undefined>,
): Promise<Scenario> {
  try {
    if (ref === SCENARIO_NAME_STANDARD) {
      return parseScenario(STANDARD_DAY_SCENARIO);
    }
    if (!ref.endsWith('.json')) {
      throw new ConfigError(
        `--scenario には、${SCENARIO_NAME_STANDARD}、または、シナリオの JSON ファイル（.json）を指定してください`,
      );
    }
    const text = await readFile(ref);
    if (text === undefined) {
      throw new ConfigError('--scenario のファイルが、見つかりません');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ConfigError('--scenario のファイルが、JSON として読めません');
    }
    return parseScenario(raw);
  } catch (error) {
    if (error instanceof ScenarioError) {
      throw new ConfigError(`シナリオの内容が正しくありません: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export interface HttpPutOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/** 認証・内容の誤り（続けても、同じ失敗になる）。一時的な失敗（混雑・サーバーの障害）は、含めない。 */
const RETRYABLE_STATUSES = new Set([408, 429]);

/** ファイルサーバーへの `PUT`。例外は投げず、結果で返す（理由には、HTTP のステータス・エラーの種類だけを入れる。メッセージ・ホスト名は入れない）。 */
export function createHttpPut(
  options: HttpPutOptions,
): (path: string, body: string) => Promise<PutOutcome> {
  return async (path, body) => {
    try {
      const response = await options.fetch(new URL(path, options.baseUrl).href, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
      });
      if (response.ok) {
        return { ok: true };
      }
      const fatal =
        response.status >= 400 && response.status < 500 && !RETRYABLE_STATUSES.has(response.status);
      return { ok: false, fatal, reason: `HTTP ${String(response.status)}` };
    } catch (error) {
      return {
        ok: false,
        fatal: false,
        reason: `ネットワークエラー（${error instanceof Error ? error.name : 'unknown'}）`,
      };
    }
  };
}

const RobotTotalsSchema = z.strictObject({
  harvestCount: z.number().min(0),
  operatingHours: z.number().min(0),
  standbyHours: z.number().min(0),
  harvestOperatingHours: z.number().min(0),
  travelStoppedHours: z.number().min(0),
});

/** 再開用の状態ファイル（最後に置いた回のシナリオの時刻・終了の時刻・ロボットごとの累積。秘密情報・接続先は、含めない）。 */
const StateFileSchema = z.strictObject({
  version: z.literal(1),
  scenario: z.string(),
  robots: z.array(z.string()),
  sensors: z.array(z.string()),
  minute: z.number().min(0),
  endMinute: z.number().min(0),
  totals: z.record(z.string(), RobotTotalsSchema),
});
type StateFile = z.infer<typeof StateFileSchema>;

export interface SimulateCliDeps {
  readonly output: {
    info(message: string): void;
    error(message: string): void;
  };
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** true なら、次の回の前に止める（Ctrl+C など）。 */
  readonly shouldStop: () => boolean;
  /** ファイルを読む（なければ undefined）。 */
  readonly readFile: (path: string) => Promise<string | undefined>;
  /** ファイルを書く（途中の状態を残さない書き方。呼び出し側で保証する）。 */
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

async function loadState(
  options: SimulateOptions,
  scenario: Scenario,
  readFile: SimulateCliDeps['readFile'],
): Promise<StateFile | undefined> {
  const text = await readFile(options.stateFile);
  if (text === undefined) {
    return undefined;
  }
  let parsed: ReturnType<typeof StateFileSchema.safeParse>;
  try {
    parsed = StateFileSchema.safeParse(JSON.parse(text));
  } catch {
    throw new ConfigError(
      '状態ファイルが、読めません（--resume を外して、最初から実行してください）',
    );
  }
  if (!parsed.success) {
    throw new ConfigError(
      '状態ファイルの内容が、正しくありません（--resume を外して、最初から実行してください）',
    );
  }
  const same = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  if (
    parsed.data.scenario !== scenario.name ||
    !same(parsed.data.robots, options.robots) ||
    !same(parsed.data.sensors, options.sensors)
  ) {
    throw new ConfigError(
      '状態ファイルが、今回の指定（シナリオ・設備）と合いません（--resume を外して、最初から実行してください）',
    );
  }
  return parsed.data;
}

/** 設備のファイルのパス（`/robot/sim-robot-1/latest.json`）から、設備の名前の部分（`sim-robot-1`）を取り出す。 */
const nameOf = (path: string): string => path.replace(/^\/[^/]+\/([^/]+)\/.*$/, '$1');

function describeTick(info: TickInfo): string {
  const robots = info.files.flatMap((file) =>
    file.status === undefined ? [] : [`${nameOf(file.path)}: ${file.status}`],
  );
  const ok = info.files.filter((file) => file.ok).length;
  // ロボットは、いつも 1 台以上ある（既定・指定とも）
  return `[${String(info.day)} 日目 ${info.clock}] 置きました ${String(ok)}/${String(info.files.length)}（${robots.join('、')}）`;
}

/**
 * コマンドの本体。終了コードを返す（0: 完了・中断。1: 設定の誤り・続けられない失敗）。
 * 予期しない例外は、呼び出し元（simulate-main.ts）が扱う。
 */
export async function runSimulateCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: SimulateCliDeps,
): Promise<number> {
  const { output } = deps;
  try {
    const options = parseSimulateArgs(args, env);
    const scenario = await loadScenario(options.scenarioRef, deps.readFile);
    const state = options.resume ? await loadState(options, scenario, deps.readFile) : undefined;

    const startMinute = state?.minute ?? options.startMinute;
    const endMinute = state?.endMinute ?? options.startMinute + options.days * DAY_MINUTES;
    if (state !== undefined && state.minute >= state.endMinute) {
      output.info(
        '状態ファイルの実行は、すでに最後まで終わっています（最初からやり直すには、--resume を外してください）',
      );
      return 0;
    }

    const equipment: SimulationEquipment[] = [
      ...options.robots.map((path, index) => ({ kind: 'robot' as const, path, index: index + 1 })),
      ...options.sensors.map((path, index) => ({
        kind: 'sensor' as const,
        path,
        index: index + 1,
      })),
    ];
    const estimatedMinutes = Math.ceil((endMinute - startMinute) / options.speed);
    output.info(
      `シミュレーションを始めます（シナリオ: ${scenario.name}、ロボット ${String(options.robots.length)} 台・環境センサー ${String(options.sensors.length)} 台、倍速 ${String(options.speed)}、${String(options.tickSeconds)} 秒ごと、約 ${String(estimatedMinutes)} 分。接続先: ${options.local ? 'ローカル' : '開発サイト'}）`,
    );
    if (options.dryRun) {
      output.info('試し実行です（ファイルは、置きません。状態ファイルも、書きません）');
    }
    if (state !== undefined) {
      output.info(`状態ファイルの続きから始めます（${String(state.minute)} 分〜）`);
    }

    const put = options.dryRun
      ? (): Promise<PutOutcome> => Promise.resolve({ ok: true })
      : createHttpPut({ baseUrl: options.url, token: options.token, fetch: deps.fetch });
    const saveState = async (current: SimulationState): Promise<void> => {
      if (options.dryRun) {
        return;
      }
      const file: StateFile = {
        version: 1,
        scenario: scenario.name,
        robots: [...options.robots],
        sensors: [...options.sensors],
        minute: current.minute,
        endMinute,
        totals: { ...current.totals },
      };
      await deps.writeFile(options.stateFile, `${JSON.stringify(file, null, 2)}\n`);
    };

    const result: SimulationResult = await runSimulation(
      {
        scenario,
        equipment,
        speed: options.speed,
        tickSeconds: options.tickSeconds,
        startMinute,
        endMinute,
        ...(state === undefined ? {} : { totals: state.totals }),
      },
      {
        now: deps.now,
        sleep: deps.sleep,
        put,
        shouldStop: deps.shouldStop,
        onTick: async (info, current) => {
          output.info(describeTick(info));
          await saveState(current);
        },
      },
    );

    if (result.endedBy === 'failed') {
      const reason = result.failureReason;
      output.error(`シミュレーションを止めました: ${reason}`);
      if (/HTTP (401|403)/.test(reason)) {
        output.error(`書き込み用のトークン（環境変数 ${WRITE_TOKEN_ENV}）を、確認してください`);
      }
      return 1;
    }
    if (result.endedBy === 'stopped') {
      output.info(
        `中断しました（${String(result.ticks)} 回。続きから始めるには、同じ指定に --resume を付けて、もう一度実行してください）`,
      );
      return 0;
    }
    output.info(
      `完了しました（${String(result.ticks)} 回。置くのに失敗した回数: ${String(result.putFailures)}）`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      output.error(error.message);
      return 1;
    }
    throw error;
  }
}
