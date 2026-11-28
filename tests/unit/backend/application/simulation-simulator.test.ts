/**
 * シミュレーション（Issue #375）の実行の中核（runSimulation）の単体テスト。仮想の時計（待つと、時刻が進む）と、置く関数の偽物で、
 * 計測日時が実際の時刻であること・値がシナリオの時刻に従うこと・累積の積み上げと 0 時のリセット・再開・失敗の扱い・ファイルの形式（確定の形式定義で読める）を確かめる。
 */

import { describe, expect, it } from 'vitest';
import {
  minutesOf,
  parseScenario,
} from '../../../../src/backend/application/simulation/scenario.ts';
import {
  buildRobotFile,
  buildSensorFile,
  runSimulation,
  variationOf,
  type PutOutcome,
  type SimulationConfig,
  type SimulationEquipment,
  type SimulationState,
  type TickInfo,
} from '../../../../src/backend/application/simulation/simulator.ts';
import { STANDARD_DAY_SCENARIO } from '../../../../src/backend/application/simulation/standard-day.ts';
import { createDefaultFormatProfileRegistry } from '../../../../src/backend/infrastructure/format-profiles/declarative-profile.ts';

const SCENARIO = parseScenario(STANDARD_DAY_SCENARIO);
const START = new Date('2026-11-25T01:00:00.000Z');
const ROBOT_1 = '/robot/sim-robot-1/latest.json';
const ROBOT_2 = '/robot/sim-robot-2/latest.json';
const SENSOR_1 = '/environment-sensor/sim-sensor-1/latest.json';
const EQUIPMENT: SimulationEquipment[] = [
  { kind: 'robot', path: ROBOT_1, index: 1 },
  { kind: 'robot', path: ROBOT_2, index: 2 },
  { kind: 'sensor', path: SENSOR_1, index: 1 },
];

/** 仮想の時計: 待つと、その分だけ、時刻が進む（実際には待たない）。 */
function virtualTime(start: Date = START) {
  let ms = start.getTime();
  return {
    now: () => new Date(ms),
    sleep: (duration: number) => {
      ms += duration;
      return Promise.resolve();
    },
  };
}

interface Put {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly wall: Date;
}

function harness(overrides: { outcome?: (call: number) => PutOutcome } = {}) {
  const time = virtualTime();
  const puts: Put[] = [];
  const ticks: TickInfo[] = [];
  const states: SimulationState[] = [];
  let calls = 0;
  return {
    puts,
    ticks,
    states,
    deps: {
      now: time.now,
      sleep: time.sleep,
      put: (path: string, body: string) => {
        calls += 1;
        puts.push({ path, body: JSON.parse(body) as Record<string, unknown>, wall: time.now() });
        const outcome: PutOutcome = overrides.outcome?.(calls) ?? { ok: true };
        return Promise.resolve(outcome);
      },
      onTick: (info: TickInfo, state: SimulationState) => {
        ticks.push(info);
        states.push(state);
      },
    },
  };
}

function config(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    scenario: SCENARIO,
    equipment: EQUIPMENT,
    speed: 60,
    tickSeconds: 60,
    startMinute: 0,
    endMinute: 1440,
    ...overrides,
  };
}

const putsOf = (puts: Put[], path: string) => puts.filter((put) => put.path === path);

describe('実行（runSimulation）: 時間の進み方', () => {
  it('最初に、すぐ 1 回置き、その後は、間隔ごとに置く。倍速 60 で一日分（1440 分）は、25 回（最初 + 24 回）。設備ごとに置く', async () => {
    const { puts, ticks, deps } = harness();

    const result = await runSimulation(config(), deps);

    expect(result).toMatchObject({ endedBy: 'completed', ticks: 25, putFailures: 0 });
    expect(ticks).toHaveLength(25);
    expect(puts).toHaveLength(25 * 3);
    expect(putsOf(puts, ROBOT_1)).toHaveLength(25);
  });

  it('計測日時（timestamp）は、実際の時刻（置いた時刻）。シナリオの時刻ではない（未来・遅延として扱われないため）', async () => {
    const { puts, deps } = harness();

    await runSimulation(config(), deps);

    const robot = putsOf(puts, ROBOT_1);
    expect(robot[0]?.body.timestamp).toBe(START.toISOString());
    expect(robot[1]?.body.timestamp).toBe(new Date(START.getTime() + 60_000).toISOString());
    for (const put of puts) {
      expect(put.body.timestamp).toBe(put.wall.toISOString());
    }
  });

  it('倍速 1・間隔 60 秒では、1 回ごとに、シナリオの時刻が 1 分進む', async () => {
    const { ticks, deps } = harness();

    await runSimulation(config({ speed: 1, endMinute: 5 }), deps);

    expect(ticks.map((tick) => tick.scenarioMinute)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('終了のシナリオの時刻を越えて進めない。最後の回は、終了の時刻（completed）', async () => {
    const { ticks, deps } = harness();

    await runSimulation(config({ speed: 600, endMinute: 100 }), deps);

    expect(ticks.at(-1)?.scenarioMinute).toBe(100);
    expect(Math.max(...ticks.map((tick) => tick.scenarioMinute))).toBe(100);
  });

  it('回の情報（onTick）に、シナリオの時刻（HH:MM）・何日目か・置いたファイルのステータスが入る', async () => {
    const { ticks, deps } = harness();

    await runSimulation(
      config({ startMinute: minutesOf('13:05'), endMinute: minutesOf('13:06'), speed: 1 }),
      deps,
    );

    const first = ticks[0];
    expect(first?.clock).toBe('13:05');
    expect(first?.day).toBe(1);
    expect(first?.files.find((file) => file.path === ROBOT_1)?.status).toBe('HARVEST_ERROR');
    expect(first?.files.find((file) => file.path === ROBOT_2)?.status).toBe('HARVESTING');
  });
});

describe('実行（runSimulation）: ファイルの内容', () => {
  it('値は、シナリオの時刻に従う（03:00 は電源なしで 0・08:00 は収穫中・センサーは夜に照度 0）', async () => {
    const { puts, deps } = harness();

    await runSimulation(config({ speed: 60, endMinute: minutesOf('09:00') }), deps);

    const robot = putsOf(puts, ROBOT_2);
    const at = (hour: number) => robot[hour]?.body;
    expect(at(3)).toMatchObject({ statusCode: 'STANDBY', harvestCount: 0, operatingHours: 0 });
    expect(at(8)).toMatchObject({ statusCode: 'HARVESTING' });
    expect(Number(at(8)?.harvestCount)).toBeGreaterThan(0);
    expect(putsOf(puts, SENSOR_1)[3]?.body.illuminance).toBe(0);
    expect(Number(putsOf(puts, SENSOR_1)[8]?.body.illuminance)).toBeGreaterThan(10_000);
  });

  it('1 台目だけ、13:00 台に異常・停止になり、2 台目は、収穫を続ける。1 台目の収穫数は、異常の間、増えない', async () => {
    const { puts, deps } = harness();

    await runSimulation(
      config({
        speed: 10,
        startMinute: minutesOf('12:50'),
        endMinute: minutesOf('13:40'),
      }),
      deps,
    );

    const first = putsOf(puts, ROBOT_1).map((put) => put.body);
    const second = putsOf(puts, ROBOT_2).map((put) => put.body);
    expect(first.map((body) => body.statusCode)).toContain('HARVEST_ERROR');
    expect(first.map((body) => body.statusCode)).toContain('STOPPED');
    expect(second.every((body) => body.statusCode === 'HARVESTING')).toBe(true);
    const during = first.filter(
      (body) => body.statusCode === 'STOPPED' || body.statusCode === 'HARVEST_ERROR',
    );
    expect(new Set(during.map((body) => body.harvestCount)).size).toBe(1);
  });

  it('累積（収穫数・稼働時間など）は、一日のうちは、減らない。日本時間の 0 時（シナリオの一日の終わり）で、0 に戻る', async () => {
    const { puts, deps } = harness();

    await runSimulation(config({ speed: 60, endMinute: 2 * 1440 }), deps);

    const counts = putsOf(puts, ROBOT_2).map((put) => Number(put.body.harvestCount));
    const dayOne = counts.slice(0, 24);
    expect(dayOne).toEqual([...dayOne].sort((left, right) => left - right));
    expect(Math.max(...dayOne)).toBeGreaterThan(4000);
    // 24 回目（シナリオの 24:00。翌日の 0 時）は、0 に戻っている
    expect(counts[24]).toBe(0);
    expect(counts[24 + 12]).toBeGreaterThan(0);
  });

  it('設備ごとに、少しずつ違う（収穫の速さ・センサーの温度のばらつき）。同じ入力なら、同じ内容（再現できる）', async () => {
    const first = harness();
    const second = harness();

    await runSimulation(config({ endMinute: 720 }), first.deps);
    await runSimulation(config({ endMinute: 720 }), second.deps);

    expect(first.puts.map((put) => put.body)).toEqual(second.puts.map((put) => put.body));
    const last = (path: string) => putsOf(first.puts, path).at(-1)?.body.harvestCount;
    expect(last(ROBOT_1)).not.toBe(last(ROBOT_2));
    expect(variationOf(ROBOT_1)).not.toEqual(variationOf(ROBOT_2));
    expect(variationOf(ROBOT_1)).toEqual(variationOf(ROBOT_1));
  });

  it('ロボット・センサーのファイルは、確定した形式定義（robot-json・environment-sensor-json）で、そのまま読める。項目は、データ定義のとおり', async () => {
    const { puts, deps } = harness();
    const registry = createDefaultFormatProfileRegistry();
    const robotProfile = registry.get('robot-json');
    const sensorProfile = registry.get('environment-sensor-json');

    await runSimulation(config({ speed: 120, endMinute: minutesOf('15:00') }), deps);

    for (const put of puts) {
      const profile = put.path.startsWith('/robot/') ? robotProfile : sensorProfile;
      const parsed = profile?.parse(JSON.stringify(put.body));
      expect(parsed?.record?.observedAt).toBe(put.wall.toISOString());
      expect(parsed?.rejectedCount).toBe(0);
    }
    expect(Object.keys(puts[0]?.body ?? {}).sort()).toEqual(
      [
        'harvestCount',
        'harvestOperatingHours',
        'harvestSecondsPerFruit',
        'operatingHours',
        'standbyHours',
        'statusCode',
        'timestamp',
        'travelStoppedHours',
      ].sort(),
    );
    expect(Object.keys(putsOf(puts, SENSOR_1)[0]?.body ?? {}).sort()).toEqual(
      ['co2', 'humidity', 'illuminance', 'temperature', 'timestamp'].sort(),
    );
  });

  it('収穫数は整数。収穫中でない間は、1 果実あたりの収穫時間が null。値は、データ定義の範囲の内側（センサーのばらつきを足しても、はみ出さない）', async () => {
    const { puts, deps } = harness();

    await runSimulation(config({ speed: 30, endMinute: 1440 }), deps);

    for (const put of puts) {
      if (put.path.startsWith('/robot/')) {
        expect(Number.isInteger(put.body.harvestCount)).toBe(true);
        if (put.body.statusCode !== 'HARVESTING') {
          expect(put.body.harvestSecondsPerFruit).toBeNull();
        }
      } else {
        expect(Number(put.body.temperature)).toBeGreaterThanOrEqual(-50);
        expect(Number(put.body.temperature)).toBeLessThanOrEqual(100);
        expect(Number(put.body.humidity)).toBeLessThanOrEqual(100);
        expect(Number(put.body.humidity)).toBeGreaterThanOrEqual(0);
        expect(Number(put.body.illuminance)).toBeGreaterThanOrEqual(0);
        expect(Number(put.body.co2)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('実行（runSimulation）: 停止・再開・失敗', () => {
  it('停止の指示（shouldStop）で、その回のあとに止まる（stopped）。状態（シナリオの時刻・累積）を返し、続きから再開できる（累積が、途切れない）', async () => {
    const uninterrupted = harness();
    await runSimulation(config({ speed: 60, endMinute: minutesOf('12:00') }), uninterrupted.deps);

    const firstHalf = harness();
    let stopAfter = 7;
    const stopped = await runSimulation(config({ speed: 60, endMinute: minutesOf('12:00') }), {
      ...firstHalf.deps,
      shouldStop: () => {
        stopAfter -= 1;
        return stopAfter <= 0;
      },
    });
    const state = firstHalf.states.at(-1);
    const resumed = harness();
    const finished = await runSimulation(
      config({
        speed: 60,
        startMinute: state?.minute ?? 0,
        endMinute: minutesOf('12:00'),
        totals: state?.totals ?? {},
      }),
      resumed.deps,
    );

    expect(stopped.endedBy).toBe('stopped');
    expect(finished.endedBy).toBe('completed');
    // 再開の最初の回は、止まった時点の状態と同じ値。最後の累積は、止まらずに通した場合と同じ
    expect(putsOf(resumed.puts, ROBOT_2)[0]?.body.harvestCount).toBe(
      putsOf(firstHalf.puts, ROBOT_2).at(-1)?.body.harvestCount,
    );
    expect(putsOf(resumed.puts, ROBOT_2).at(-1)?.body.harvestCount).toBe(
      putsOf(uninterrupted.puts, ROBOT_2).at(-1)?.body.harvestCount,
    );
  });

  it('1 つの置く操作が失敗（fatal でない）しても、数えて、続ける。置いた回数は、失敗を含めて数える', async () => {
    const { puts, deps } = harness({
      outcome: (call) => (call === 2 ? { ok: false, fatal: false, reason: '503' } : { ok: true }),
    });

    const result = await runSimulation(config({ endMinute: 180, speed: 60 }), deps);

    expect(result.endedBy).toBe('completed');
    expect(result.putFailures).toBe(1);
    expect(puts.length).toBeGreaterThan(3);
  });

  it('認証の失敗など、続けても無駄な失敗（fatal）は、すぐに止める（failed）。それ以降は、置かない', async () => {
    const { puts, deps } = harness({
      outcome: (call) => (call === 2 ? { ok: false, fatal: true, reason: '401' } : { ok: true }),
    });

    const result = await runSimulation(config(), deps);

    expect(result).toMatchObject({
      endedBy: 'failed',
      failureReason: expect.stringContaining('401'),
    });
    expect(puts).toHaveLength(2);
  });

  it('すべての置く操作が、連続して 5 回、失敗すると、止める（failed）', async () => {
    const { ticks, deps } = harness({
      outcome: () => ({ ok: false, fatal: false, reason: 'network' }),
    });

    const result = await runSimulation(config(), deps);

    expect(result.endedBy).toBe('failed');
    expect(ticks).toHaveLength(5);
  });

  it('1 回でも成功すれば、連続の失敗の数は、数え直す', async () => {
    let tickCalls = 0;
    const { deps } = harness({
      // 3 設備 × 回数。4 回失敗 → 成功 を繰り返す（連続 5 回にならない）
      outcome: (call) => {
        tickCalls = Math.ceil(call / 3);
        return tickCalls % 5 === 0 ? { ok: true } : { ok: false, fatal: false, reason: 'network' };
      },
    });

    const result = await runSimulation(config({ endMinute: 600, speed: 60 }), deps);

    expect(result.endedBy).toBe('completed');
  });
});

describe('ファイルの生成（buildRobotFile・buildSensorFile）', () => {
  it('ロボット: スナップショット 1 つ（設備の識別子・記録の配列なし）。累積は小数の誤差を丸める', () => {
    const body = JSON.parse(
      buildRobotFile(
        SCENARIO,
        1,
        {
          harvestCount: 12.9,
          operatingHours: 1.00000001,
          standbyHours: 0,
          harvestOperatingHours: 0.99999999,
          travelStoppedHours: 0.02,
        },
        minutesOf('08:00'),
        START,
      ),
    ) as Record<string, unknown>;

    expect(body).toEqual({
      timestamp: START.toISOString(),
      harvestCount: 12,
      harvestSecondsPerFruit: 42,
      operatingHours: 1,
      standbyHours: 0,
      harvestOperatingHours: 1,
      travelStoppedHours: 0.02,
      statusCode: 'HARVESTING',
    });
  });

  it('センサー: 4 項目。ばらつきは、種で決まる（同じ種は、同じ値）。値は、範囲の内側に収める', () => {
    const first = buildSensorFile(SCENARIO, minutesOf('12:00'), START, {
      seed: 1,
      temperatureOffset: 0,
    });
    const again = buildSensorFile(SCENARIO, minutesOf('12:00'), START, {
      seed: 1,
      temperatureOffset: 0,
    });
    const other = buildSensorFile(SCENARIO, minutesOf('12:00'), START, {
      seed: 2,
      temperatureOffset: 0,
    });
    const night = JSON.parse(
      buildSensorFile(SCENARIO, minutesOf('02:00'), START, { seed: 5, temperatureOffset: 0 }),
    ) as Record<string, unknown>;

    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(night.illuminance).toBe(0);
  });
});
