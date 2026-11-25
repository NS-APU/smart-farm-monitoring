/**
 * シミュレーション（Issue #375）のシナリオの単体テスト。シナリオの検証（時間帯・ステータスコード・値の範囲）・ある時刻の状態・累積の積み上げ（日本時間の
 * 0 時でリセット）・センサーの値の補間を確かめる。合成データだけ。
 */

import { describe, expect, it } from 'vitest';
import {
  advanceRobotTotals,
  DAY_MINUTES,
  minutesOf,
  parseScenario,
  robotStateAt,
  sensorValuesAt,
  ZERO_ROBOT_TOTALS,
} from '../../../../src/backend/application/simulation/scenario.ts';
import { STANDARD_DAY_SCENARIO } from '../../../../src/backend/application/simulation/standard-day.ts';

const at = (hhmm: string): number => minutesOf(hhmm);

/** 検証用の、最小のシナリオ（ロボットは 1 日を 1 つの時間帯で埋める。センサーは、2 点）。 */
function minimal(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: 'minimal',
    description: '検証用',
    robot: [
      {
        from: '00:00',
        to: '24:00',
        status: 'HARVESTING',
        activity: 'harvesting',
        harvestPerHour: 120,
        secondsPerFruit: 30,
      },
    ],
    sensor: {
      temperature: [
        { at: '00:00', value: 10 },
        { at: '24:00', value: 20 },
      ],
      humidity: [
        { at: '00:00', value: 50 },
        { at: '24:00', value: 50 },
      ],
      illuminance: [
        { at: '00:00', value: 0 },
        { at: '24:00', value: 0 },
      ],
      co2: [
        { at: '00:00', value: 800 },
        { at: '24:00', value: 800 },
      ],
    },
    ...overrides,
  };
}

describe('時刻の表記（minutesOf）', () => {
  it('HH:MM を、0 時からの分に直す。24:00 は、1440（一日の終わり）', () => {
    expect(at('00:00')).toBe(0);
    expect(at('06:30')).toBe(390);
    expect(at('23:59')).toBe(1439);
    expect(at('24:00')).toBe(DAY_MINUTES);
  });

  it('形式が正しくない表記は、エラー', () => {
    for (const text of ['6:30', '24:01', '12:60', 'abc', '']) {
      expect(() => minutesOf(text), text).toThrow();
    }
  });
});

describe('シナリオの検証（parseScenario）', () => {
  it('内蔵の標準シナリオは、検証を通る（ロボットは一日を隙間なく覆い、センサーの値は範囲の内側）', () => {
    expect(() => parseScenario(STANDARD_DAY_SCENARIO)).not.toThrow();
    expect(STANDARD_DAY_SCENARIO.name).toBe('standard-day');
  });

  it('最小のシナリオは通る', () => {
    expect(parseScenario(minimal()).name).toBe('minimal');
  });

  it('ロボットの時間帯に、隙間・重なり・逆順があると、エラー（一日を、隙間なく覆う）', () => {
    const base = {
      status: 'STANDBY',
      activity: 'off',
      harvestPerHour: 0,
    };
    expect(() =>
      parseScenario(minimal({ robot: [{ ...base, from: '00:00', to: '12:00' }] })),
    ).toThrow();
    expect(() =>
      parseScenario(
        minimal({
          robot: [
            { ...base, from: '00:00', to: '13:00' },
            { ...base, from: '12:00', to: '24:00' },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseScenario(minimal({ robot: [{ ...base, from: '12:00', to: '06:00' }] })),
    ).toThrow();
  });

  it('設備を限定した時間帯（equipment）どうしが重なると、エラー。重ならなければ通る', () => {
    const general = [
      {
        from: '00:00',
        to: '24:00',
        status: 'HARVESTING',
        activity: 'harvesting',
        harvestPerHour: 100,
      },
    ];
    const limited = (from: string, to: string) => ({
      from,
      to,
      status: 'STOPPED',
      activity: 'stopped',
      harvestPerHour: 0,
      equipment: [1],
    });

    expect(() =>
      parseScenario(
        minimal({ robot: [...general, limited('10:00', '11:00'), limited('10:30', '12:00')] }),
      ),
    ).toThrow();
    expect(() =>
      parseScenario(
        minimal({ robot: [...general, limited('10:00', '11:00'), limited('11:00', '12:00')] }),
      ),
    ).not.toThrow();
  });

  it('ステータスコードの形式（英大文字・数字・アンダースコア）・活動の種類・収穫の速さの範囲が正しくないと、エラー', () => {
    const segment = (overrides: Record<string, unknown>) =>
      minimal({
        robot: [
          {
            from: '00:00',
            to: '24:00',
            status: 'HARVESTING',
            activity: 'harvesting',
            harvestPerHour: 100,
            ...overrides,
          },
        ],
      });

    expect(() => parseScenario(segment({ status: 'harvesting' }))).toThrow();
    expect(() => parseScenario(segment({ activity: 'flying' }))).toThrow();
    expect(() => parseScenario(segment({ harvestPerHour: -1 }))).toThrow();
    expect(() => parseScenario(segment({ harvestPerHour: 100_000 }))).toThrow();
  });

  it('センサーの値が、データ定義の範囲の外・時刻が増えない・点が 1 つだけ・項目が欠けていると、エラー', () => {
    const curve = (points: { at: string; value: number }[]) =>
      minimal({
        sensor: {
          ...(minimal() as { sensor: Record<string, unknown> }).sensor,
          temperature: points,
        },
      });

    expect(() =>
      parseScenario(
        curve([
          { at: '00:00', value: -51 },
          { at: '24:00', value: 20 },
        ]),
      ),
    ).toThrow();
    expect(() =>
      parseScenario(
        curve([
          { at: '12:00', value: 20 },
          { at: '12:00', value: 21 },
        ]),
      ),
    ).toThrow();
    expect(() => parseScenario(curve([{ at: '00:00', value: 20 }]))).toThrow();
    expect(() => parseScenario(minimal({ sensor: { temperature: [] } }))).toThrow();
  });

  it('名前の形式が正しくない・余分な項目があると、エラー', () => {
    expect(() => parseScenario(minimal({ name: 'Bad Name' }))).toThrow();
    expect(() => parseScenario(minimal({ unknownField: 1 }))).toThrow();
    expect(() => parseScenario('not an object')).toThrow();
  });
});

describe('ある時刻の、ロボットの状態（robotStateAt）', () => {
  const scenario = parseScenario(STANDARD_DAY_SCENARIO);

  it('標準シナリオ: 夜は電源なし（待機中。時間は加算しない）・06:00 に稼働開始・ピークは収穫中', () => {
    expect(robotStateAt(scenario, 1, at('03:00'))).toMatchObject({
      status: 'STANDBY',
      activity: 'off',
    });
    expect(robotStateAt(scenario, 1, at('06:10'))).toMatchObject({
      status: 'RUNNING',
      activity: 'running',
    });
    expect(robotStateAt(scenario, 1, at('08:00'))).toMatchObject({
      status: 'HARVESTING',
      activity: 'harvesting',
    });
  });

  it('時間帯の境界は、開始を含み、終了を含まない（11:00 は待機）', () => {
    expect(robotStateAt(scenario, 1, at('10:59')).status).toBe('HARVESTING');
    expect(robotStateAt(scenario, 1, at('11:00')).status).toBe('STANDBY');
  });

  it('異常と復旧・バッテリー不足は、1 台目だけ（equipment: [1]）。2 台目は、同じ時刻も、収穫を続ける', () => {
    expect(robotStateAt(scenario, 1, at('13:05')).status).toBe('HARVEST_ERROR');
    expect(robotStateAt(scenario, 1, at('13:15')).status).toBe('STOPPED');
    expect(robotStateAt(scenario, 1, at('13:30')).status).toBe('HARVESTING');
    expect(robotStateAt(scenario, 1, at('16:10')).status).toBe('LOW_BATTERY');
    expect(robotStateAt(scenario, 2, at('13:05')).status).toBe('HARVESTING');
    expect(robotStateAt(scenario, 2, at('16:10')).status).toBe('HARVESTING');
  });

  it('収穫中でない時間帯は、1 果実あたりの収穫時間が null。収穫中は、数値', () => {
    expect(robotStateAt(scenario, 1, at('11:10')).secondsPerFruit).toBeNull();
    expect(robotStateAt(scenario, 1, at('08:00')).secondsPerFruit).toBeGreaterThan(0);
  });

  it('一日（1440 分）を超えた時刻は、日の中の時刻に直す（翌日の 08:00 も、収穫中）', () => {
    expect(robotStateAt(scenario, 1, DAY_MINUTES + at('08:00')).status).toBe('HARVESTING');
  });
});

describe('累積の積み上げ（advanceRobotTotals）', () => {
  const scenario = parseScenario(minimal());

  it('収穫中の 1 時間で、収穫数・稼働時間・収穫稼働時間が増える（走行停止時間は、2% だけ）。待機時間は増えない', () => {
    const totals = advanceRobotTotals(scenario, 1, ZERO_ROBOT_TOTALS, 0, 60, 1);

    expect(totals.harvestCount).toBeCloseTo(120, 5);
    expect(totals.operatingHours).toBeCloseTo(1, 5);
    expect(totals.harvestOperatingHours).toBeCloseTo(1, 5);
    expect(totals.travelStoppedHours).toBeCloseTo(0.02, 5);
    expect(totals.standbyHours).toBe(0);
  });

  it('速さの係数（設備ごとのばらつき）は、収穫数だけに掛かる', () => {
    const totals = advanceRobotTotals(scenario, 1, ZERO_ROBOT_TOTALS, 0, 60, 1.1);

    expect(totals.harvestCount).toBeCloseTo(132, 5);
    expect(totals.operatingHours).toBeCloseTo(1, 5);
  });

  it('日本時間の 0 時（一日の終わり）で、累積を 0 に戻す。そのあとの分だけが、新しい日の値になる', () => {
    const before = advanceRobotTotals(scenario, 1, ZERO_ROBOT_TOTALS, 0, DAY_MINUTES - 30, 1);
    expect(before.harvestCount).toBeGreaterThan(2000);

    const crossed = advanceRobotTotals(scenario, 1, before, DAY_MINUTES - 30, DAY_MINUTES + 60, 1);

    expect(crossed.harvestCount).toBeCloseTo(120, 3);
    expect(crossed.operatingHours).toBeCloseTo(1, 5);
  });

  it('活動ごとの積み上げ: 待機（稼働・待機）・走行（稼働だけ）・停止（稼働・走行停止）・電源なし（なし）', () => {
    const one = (activity: string) =>
      advanceRobotTotals(
        parseScenario(
          minimal({
            robot: [
              {
                from: '00:00',
                to: '24:00',
                status: 'STANDBY',
                activity,
                harvestPerHour: 0,
              },
            ],
          }),
        ),
        1,
        ZERO_ROBOT_TOTALS,
        0,
        60,
        1,
      );

    // 小数の足し算の誤差があるため、近似で比べる
    const standby = one('standby');
    expect(standby.operatingHours).toBeCloseTo(1, 6);
    expect(standby.standbyHours).toBeCloseTo(1, 6);
    expect(standby.travelStoppedHours).toBe(0);
    const running = one('running');
    expect(running.operatingHours).toBeCloseTo(1, 6);
    expect(running.standbyHours).toBe(0);
    expect(running.harvestOperatingHours).toBe(0);
    const stopped = one('stopped');
    expect(stopped.operatingHours).toBeCloseTo(1, 6);
    expect(stopped.travelStoppedHours).toBeCloseTo(1, 6);
    expect(stopped.harvestCount).toBe(0);
    expect(one('off')).toEqual(ZERO_ROBOT_TOTALS);
  });

  it('時刻が進まない（同じ時刻・逆戻り）ときは、何も足さない', () => {
    expect(advanceRobotTotals(scenario, 1, ZERO_ROBOT_TOTALS, 100, 100, 1)).toEqual(
      ZERO_ROBOT_TOTALS,
    );
    expect(advanceRobotTotals(scenario, 1, ZERO_ROBOT_TOTALS, 100, 50, 1)).toEqual(
      ZERO_ROBOT_TOTALS,
    );
  });

  it('標準シナリオの一日を通すと、夜は 0 のまま・日中に増え、異常の時間帯（1 台目）は、収穫が増えない', () => {
    const standard = parseScenario(STANDARD_DAY_SCENARIO);

    const night = advanceRobotTotals(standard, 1, ZERO_ROBOT_TOTALS, 0, at('06:00'), 1);
    const beforeError = advanceRobotTotals(standard, 1, night, at('06:00'), at('13:00'), 1);
    const duringError = advanceRobotTotals(standard, 1, beforeError, at('13:00'), at('13:30'), 1);
    const secondRobot = advanceRobotTotals(standard, 2, beforeError, at('13:00'), at('13:30'), 1);

    expect(night).toEqual(ZERO_ROBOT_TOTALS);
    expect(beforeError.harvestCount).toBeGreaterThan(2000);
    expect(duringError.harvestCount).toBe(beforeError.harvestCount);
    expect(secondRobot.harvestCount).toBeGreaterThan(beforeError.harvestCount);
  });
});

describe('センサーの値（sensorValuesAt）', () => {
  it('キーフレームの時刻は、その値。間は、直線で補間する。最初より前・最後より後は、端の値', () => {
    const scenario = parseScenario(minimal());

    expect(sensorValuesAt(scenario, 0).temperature).toBe(10);
    expect(sensorValuesAt(scenario, 720).temperature).toBeCloseTo(15, 5);
    // 一日の終わり（24:00）の直前は、最後の点の値に近づく。ちょうど 24:00 は、翌日の 0 時（最初の点の値）
    expect(sensorValuesAt(scenario, DAY_MINUTES - 0.001).temperature).toBeCloseTo(20, 3);
    expect(sensorValuesAt(scenario, DAY_MINUTES).temperature).toBe(10);
    expect(sensorValuesAt(scenario, 720)).toMatchObject({ humidity: 50, illuminance: 0, co2: 800 });
  });

  it('標準シナリオ: 夜は照度 0・日中のピークは 60,000 lx 前後。13:20 前後に、温度が 35℃ 以上（環境適応性の異常の範囲）', () => {
    const scenario = parseScenario(STANDARD_DAY_SCENARIO);

    expect(sensorValuesAt(scenario, at('02:00')).illuminance).toBe(0);
    expect(sensorValuesAt(scenario, at('12:00')).illuminance).toBeGreaterThan(30_000);
    expect(sensorValuesAt(scenario, at('13:30')).temperature).toBeGreaterThanOrEqual(35);
    expect(sensorValuesAt(scenario, at('10:00')).temperature).toBeLessThan(35);
    expect(sensorValuesAt(scenario, at('10:00')).temperature).toBeGreaterThanOrEqual(25 - 5);
  });

  it('一日を超えた時刻は、日の中の時刻に直す', () => {
    const scenario = parseScenario(STANDARD_DAY_SCENARIO);

    expect(sensorValuesAt(scenario, DAY_MINUTES + at('12:00'))).toEqual(
      sensorValuesAt(scenario, at('12:00')),
    );
  });
});

describe('安全のための既定（検証を通っていないシナリオを渡された場合）', () => {
  const scenario = parseScenario(STANDARD_DAY_SCENARIO);

  it('時間帯が見つからない時刻は、電源なし（待機のコード・収穫なし）として扱う', () => {
    expect(robotStateAt({ ...scenario, robot: [] }, 1, at('08:00'))).toEqual({
      status: 'STANDBY',
      activity: 'off',
      harvestPerHour: 0,
      secondsPerFruit: null,
    });
  });

  it('収穫中でも、1 果実あたりの収穫時間の指定がなければ、null', () => {
    const noSeconds = parseScenario({
      ...STANDARD_DAY_SCENARIO,
      robot: [
        {
          from: '00:00',
          to: '24:00',
          status: 'HARVESTING',
          activity: 'harvesting',
          harvestPerHour: 100,
        },
      ],
    });

    expect(robotStateAt(noSeconds, 1, at('08:00')).secondsPerFruit).toBeNull();
  });

  it('点のない項目は 0。最後の点より後の時刻は、最後の値のまま', () => {
    const empty = { ...scenario, sensor: { ...scenario.sensor, temperature: [] } };
    const early = parseScenario({
      ...STANDARD_DAY_SCENARIO,
      sensor: {
        ...STANDARD_DAY_SCENARIO.sensor,
        temperature: [
          { at: '06:00', value: 10 },
          { at: '12:00', value: 20 },
        ],
      },
    });

    expect(sensorValuesAt(empty, at('08:00')).temperature).toBe(0);
    expect(sensorValuesAt(early, at('18:00')).temperature).toBe(20);
    expect(sensorValuesAt(early, at('03:00')).temperature).toBe(10);
    expect(sensorValuesAt(early, at('09:00')).temperature).toBe(15);
  });
});
