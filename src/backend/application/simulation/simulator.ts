/**
 * シミュレーションの実行の中核（Issue #375）。シナリオ（scenario.ts）に沿って、ロボット・環境センサーのファイルを作り、間隔ごとに「置く」。
 * 計測日時は、置いた時刻（実際の時計）。値は、シナリオの時刻（日本時間の一日。倍速で、短い時間に一日分を流せる）に従う。
 * 時計・待つ・置く・回ごとの通知は、引数で差し替える（テストでは、仮想の時計で、待たずに流す）。
 */

import {
  advanceRobotTotals,
  DAY_MINUTES,
  robotStateAt,
  sensorValuesAt,
  ZERO_ROBOT_TOTALS,
  type RobotTotals,
  type Scenario,
} from './scenario.ts';

/** 種つきの擬似乱数（mulberry32。0 以上 1 未満）。アプリケーション層は、インフラの層に依存できないため、ここに持つ。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface SimulationEquipment {
  readonly kind: 'robot' | 'sensor';
  /** ファイルサーバー上のパス（`/robot/sim-robot-1/latest.json` など）。 */
  readonly path: string;
  /** 同じ種別の中の順番（1 から）。シナリオの「設備を限定した時間帯」の指定に使う。 */
  readonly index: number;
}

export interface SimulationConfig {
  readonly scenario: Scenario;
  readonly equipment: readonly SimulationEquipment[];
  /** 倍速（シナリオの時間が、実際の時間の何倍で進むか）。 */
  readonly speed: number;
  /** 置く間隔（実際の秒）。 */
  readonly tickSeconds: number;
  /** 開始のシナリオの時刻（0 時からの分。一日を超えてよい）。 */
  readonly startMinute: number;
  /** 終了のシナリオの時刻（0 時からの分）。この時刻の回を最後に、終わる。 */
  readonly endMinute: number;
  /** 再開のときの、ロボットごとの累積（パス → 累積）。なければ、0 から。 */
  readonly totals?: Readonly<Record<string, RobotTotals>>;
}

/** 再開に必要な状態（最後に置いた回のシナリオの時刻と、ロボットごとの累積）。 */
export interface SimulationState {
  readonly minute: number;
  readonly totals: Readonly<Record<string, RobotTotals>>;
}

export type PutOutcome =
  { readonly ok: true } | { readonly ok: false; readonly fatal: boolean; readonly reason: string };

export interface TickInfo {
  /** 回の番号（0 から）。 */
  readonly tick: number;
  readonly scenarioMinute: number;
  /** シナリオの時刻（日本時間。HH:MM）。 */
  readonly clock: string;
  /** シナリオの何日目か（1 から）。 */
  readonly day: number;
  readonly files: readonly {
    readonly path: string;
    /** ロボットのステータスコード（センサーは、なし）。 */
    readonly status?: string;
    readonly ok: boolean;
  }[];
}

export interface SimulationDeps {
  readonly now: () => Date;
  /** 指定のミリ秒、待つ。 */
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** 1 つのファイルを置く（本文は JSON の文字列）。例外は投げず、結果で返す。 */
  readonly put: (path: string, body: string) => Promise<PutOutcome>;
  /** 回ごとの通知（状態ファイルの保存など。終わるまで、待つ）。 */
  readonly onTick?: (info: TickInfo, state: SimulationState) => void | Promise<void>;
  /** 次の回の前（待ったあと）に呼ばれ、true なら、そこで止める。 */
  readonly shouldStop?: () => boolean;
}

interface SimulationResultBase {
  readonly ticks: number;
  readonly putFailures: number;
  /** 最後に置いた回の状態（再開に使う）。1 回も置かなければ、開始の状態。 */
  readonly state: SimulationState;
}

export type SimulationResult =
  | (SimulationResultBase & { readonly endedBy: 'completed' | 'stopped' })
  | (SimulationResultBase & { readonly endedBy: 'failed'; readonly failureReason: string });

/** すべての置く操作が失敗した回が、この回数、続いたら、止める。 */
const MAX_CONSECUTIVE_FAILED_TICKS = 5;

export interface Variation {
  readonly seed: number;
  /** 収穫の速さの倍率（0.9〜1.1）。 */
  readonly rateFactor: number;
  /** 温度に足す値（-0.6〜0.6）。 */
  readonly temperatureOffset: number;
}

/** 設備ごとのばらつき。パスから決まる（同じパスは、いつも同じ。再開しても、変わらない）。 */
export function variationOf(path: string): Variation {
  let hash = 2_166_136_261;
  for (let index = 0; index < path.length; index += 1) {
    hash = Math.imul(hash ^ path.charCodeAt(index), 16_777_619) >>> 0;
  }
  const random = createRandom(hash);
  return {
    seed: hash,
    rateFactor: 0.9 + random() * 0.2,
    temperatureOffset: (random() - 0.5) * 1.2,
  };
}

const roundTo = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** ロボットのファイル（スナップショット 1 つ。ロボットの形式定義 robot-json の形）。収穫数は整数、時間は小数 4 桁に丸める。 */
export function buildRobotFile(
  scenario: Scenario,
  equipmentIndex: number,
  totals: RobotTotals,
  minute: number,
  wall: Date,
): string {
  const state = robotStateAt(scenario, equipmentIndex, minute);
  return JSON.stringify({
    timestamp: wall.toISOString(),
    harvestCount: Math.floor(totals.harvestCount + 1e-6),
    harvestSecondsPerFruit: state.secondsPerFruit,
    operatingHours: roundTo(totals.operatingHours, 4),
    standbyHours: roundTo(totals.standbyHours, 4),
    harvestOperatingHours: roundTo(totals.harvestOperatingHours, 4),
    travelStoppedHours: roundTo(totals.travelStoppedHours, 4),
    statusCode: state.status,
  });
}

/** 環境センサーのファイル（4 項目）。シナリオの値に、設備ごとの温度の差と、回ごとの小さなばらつき（種と時刻で決まる）を足し、データ定義の範囲に収める。 */
export function buildSensorFile(
  scenario: Scenario,
  minute: number,
  wall: Date,
  variation: Pick<Variation, 'seed' | 'temperatureOffset'>,
): string {
  const values = sensorValuesAt(scenario, minute);
  const random = createRandom((variation.seed ^ Math.round(minute * 1000)) >>> 0);
  const jitter = (): number => random() * 2 - 1;
  return JSON.stringify({
    timestamp: wall.toISOString(),
    temperature: roundTo(
      clamp(values.temperature + variation.temperatureOffset + jitter() * 0.2, -50, 100),
      1,
    ),
    humidity: roundTo(clamp(values.humidity + jitter(), 0, 100), 1),
    illuminance: Math.round(clamp(values.illuminance * (1 + jitter() * 0.03), 0, 200_000)),
    co2: Math.round(clamp(values.co2 + jitter() * 15, 0, 10_000)),
  });
}

function clockOf(minute: number): string {
  const inDay = Math.floor(((minute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES);
  const hours = String(Math.floor(inDay / 60)).padStart(2, '0');
  const minutes = String(inDay % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * シミュレーションを実行する。最初の回は、すぐに置き、以降は、開始の時刻から数えた間隔ごとに置く（置く時間のずれを、積み上げない）。
 * 終了のシナリオの時刻に達した回で、終わる。認証の失敗など、続けても無駄な失敗（fatal）は、すぐに止める。
 */
export async function runSimulation(
  config: SimulationConfig,
  deps: SimulationDeps,
): Promise<SimulationResult> {
  // 設備ごとの、ばらつきと、ロボットの累積（設備ごとに、持つ）
  const runners = config.equipment.map((equipment) => ({
    equipment,
    variation: variationOf(equipment.path),
    totals:
      equipment.kind === 'robot'
        ? (config.totals?.[equipment.path] ?? ZERO_ROBOT_TOTALS)
        : ZERO_ROBOT_TOTALS,
  }));
  const totalsOf = (): Record<string, RobotTotals> =>
    Object.fromEntries(
      runners
        .filter((runner) => runner.equipment.kind === 'robot')
        .map((runner) => [runner.equipment.path, runner.totals]),
    );
  const startWall = deps.now().getTime();
  const minutesPerTick = (config.tickSeconds / 60) * config.speed;
  let previousMinute = config.startMinute;
  let state: SimulationState = { minute: config.startMinute, totals: totalsOf() };
  let ticks = 0;
  let putFailures = 0;
  let failedTicks = 0;

  for (let tick = 0; ; tick += 1) {
    if (tick > 0) {
      await deps.sleep(
        Math.max(0, startWall + tick * config.tickSeconds * 1000 - deps.now().getTime()),
      );
      // 待っている間に止めの指示があれば、次の回を置かずに止める（待ちを途中で抜けた場合も、余分に置かない）
      if (deps.shouldStop?.() === true) {
        return { endedBy: 'stopped', ticks, putFailures, state };
      }
    }
    const minute = Math.min(config.endMinute, config.startMinute + tick * minutesPerTick);
    const wall = deps.now();

    for (const runner of runners) {
      if (runner.equipment.kind === 'robot') {
        runner.totals = advanceRobotTotals(
          config.scenario,
          runner.equipment.index,
          runner.totals,
          previousMinute,
          minute,
          runner.variation.rateFactor,
        );
      }
    }
    previousMinute = minute;
    state = { minute, totals: totalsOf() };

    const files: { path: string; status?: string; ok: boolean }[] = [];
    let fatalReason: string | undefined;
    for (const { equipment, variation, totals } of runners) {
      const body =
        equipment.kind === 'robot'
          ? buildRobotFile(config.scenario, equipment.index, totals, minute, wall)
          : buildSensorFile(config.scenario, minute, wall, variation);
      const outcome = await deps.put(equipment.path, body);
      if (!outcome.ok) {
        putFailures += 1;
        if (outcome.fatal) {
          fatalReason = outcome.reason;
          break;
        }
      }
      files.push({
        path: equipment.path,
        ...(equipment.kind === 'robot'
          ? { status: robotStateAt(config.scenario, equipment.index, minute).status }
          : {}),
        ok: outcome.ok,
      });
    }
    ticks += 1;
    if (fatalReason !== undefined) {
      return { endedBy: 'failed', ticks, putFailures, failureReason: fatalReason, state };
    }

    await deps.onTick?.(
      {
        tick,
        scenarioMinute: minute,
        clock: clockOf(minute),
        day: Math.floor(minute / DAY_MINUTES) + 1,
        files,
      },
      state,
    );

    failedTicks = files.every((file) => !file.ok) ? failedTicks + 1 : 0;
    if (failedTicks >= MAX_CONSECUTIVE_FAILED_TICKS) {
      return {
        endedBy: 'failed',
        ticks,
        putFailures,
        failureReason: `置く操作が、${MAX_CONSECUTIVE_FAILED_TICKS} 回続けて、すべて失敗した`,
        state,
      };
    }
    if (minute >= config.endMinute) {
      return { endedBy: 'completed', ticks, putFailures, state };
    }
  }
}
