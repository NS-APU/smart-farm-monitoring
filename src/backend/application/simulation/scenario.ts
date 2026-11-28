/**
 * シミュレーション（Issue #375）のシナリオ: 一日（日本時間）の、ロボットの状態・累積の積み上げ・環境センサーの値の変化の定義と、その評価。
 * - ロボット: 時間帯（`from`〜`to`。開始を含み、終了を含まない）ごとに、ステータスコード・活動（電源なし・待機・走行・収穫・停止）・収穫の速さを決める。
 *   一日（00:00〜24:00）を、隙間なく覆う。`equipment` を指定した時間帯は、その順番の設備（1 から数える）だけに当てる（異常の発生を、1 台だけにするため）
 * - 環境センサー: 項目（温度・湿度・照度・CO2）ごとに、時刻と値の点（キーフレーム）を並べ、間は、直線で補う。値の範囲は、データ定義のとおり
 * - 時刻は、**シナリオの時刻**（0 時からの分。一日を超えた値は、日の中の時刻に直す）。累積（収穫数・稼働時間など）は、日本時間の 0 時（一日の終わり）で 0 に戻す（D-26）
 * 合成データだけ。実際の機体・作物の値ではない。
 */

import { z } from 'zod';

export const DAY_MINUTES = 1440;

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioError';
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isTime(text: string): boolean {
  return text === '24:00' || TIME_PATTERN.test(text);
}

/** `HH:MM`（00:00〜24:00）を、0 時からの分に直す。24:00 は、一日の終わり（1440）。 */
export function minutesOf(text: string): number {
  if (!isTime(text)) {
    throw new ScenarioError('時刻は、HH:MM（00:00〜24:00）で指定してください');
  }
  if (text === '24:00') {
    return DAY_MINUTES;
  }
  const [hours = 0, minutes = 0] = text.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * ロボットの活動。累積の積み上げが変わる（`advanceRobotTotals`）。
 * off: 電源なし（何も足さない）／standby: 待機（稼働・待機）／running: 走行（稼働）／harvesting: 収穫（稼働・収穫稼働・収穫数・走行停止の 2%）／
 * stopped: 停止（稼働・走行停止）。
 */
export const ROBOT_ACTIVITIES = ['off', 'standby', 'running', 'harvesting', 'stopped'] as const;
export type RobotActivity = (typeof ROBOT_ACTIVITIES)[number];

const TimeSchema = z.string().refine(isTime, 'HH:MM（00:00〜24:00）で指定してください');

const RobotSegmentSchema = z
  .strictObject({
    from: TimeSchema,
    to: TimeSchema,
    /** ステータスコードのコード値（登録済みのもの。例: HARVESTING）。 */
    status: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, '英大文字で始まる、英大文字・数字・アンダースコアにしてください')
      .max(100),
    activity: z.enum(ROBOT_ACTIVITIES),
    /** 収穫の速さ（個/時間。活動が harvesting のときだけ使う）。 */
    harvestPerHour: z.number().min(0).max(5000).default(0),
    /** 1 果実あたりの収穫時間（秒。活動が harvesting のときだけ出す）。 */
    secondsPerFruit: z.number().min(0).max(3600).optional(),
    /** 当てる設備の順番（1 から数える）。省略は、すべての設備。 */
    equipment: z.array(z.number().int().min(1).max(1000)).min(1).optional(),
  })
  .refine((segment) => minutesOf(segment.from) < minutesOf(segment.to), {
    message: '開始（from）は、終了（to）より前にしてください',
  });

function curve(min: number, max: number) {
  return z
    .array(
      z.strictObject({
        at: TimeSchema,
        value: z.number().min(min).max(max),
      }),
    )
    .min(2, '点は、2 つ以上にしてください')
    .refine(
      (points) =>
        points.every((point, index) => {
          const previous = points[index - 1];
          return previous === undefined || minutesOf(previous.at) < minutesOf(point.at);
        }),
      { message: '点の時刻（at）は、増える順に、重ならないように並べてください' },
    );
}

const ScenarioBaseSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, '英小文字・数字・ハイフンにしてください（64 文字まで）'),
  description: z.string().max(500),
  robot: z.array(RobotSegmentSchema).min(1),
  sensor: z.strictObject({
    /** ℃（データ定義の範囲: -50〜100）。 */
    temperature: curve(-50, 100),
    /** %（0〜100）。 */
    humidity: curve(0, 100),
    /** lx（0〜200,000）。 */
    illuminance: curve(0, 200_000),
    /** ppm（0〜10,000）。 */
    co2: curve(0, 10_000),
  }),
});

export const ScenarioSchema = ScenarioBaseSchema.superRefine((scenario, context) => {
  const general = scenario.robot
    .filter((segment) => segment.equipment === undefined)
    .map((segment) => ({ from: minutesOf(segment.from), to: minutesOf(segment.to) }))
    .sort((left, right) => left.from - right.from);
  let expected = 0;
  for (const segment of general) {
    if (segment.from !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['robot'],
        message:
          '設備を限定しない時間帯は、一日（00:00〜24:00）を、隙間なく、重ならないように覆ってください',
      });
      return;
    }
    expected = segment.to;
  }
  if (expected !== DAY_MINUTES) {
    context.addIssue({
      code: 'custom',
      path: ['robot'],
      message:
        '設備を限定しない時間帯は、一日（00:00〜24:00）を、隙間なく、重ならないように覆ってください',
    });
    return;
  }
  const limited = scenario.robot
    .filter((segment) => segment.equipment !== undefined)
    .map((segment) => ({ from: minutesOf(segment.from), to: minutesOf(segment.to) }))
    .sort((left, right) => left.from - right.from);
  for (let index = 1; index < limited.length; index += 1) {
    const previous = limited[index - 1];
    const current = limited[index];
    if (previous !== undefined && current !== undefined && current.from < previous.to) {
      context.addIssue({
        code: 'custom',
        path: ['robot'],
        message: '設備を限定した時間帯どうしは、重ならないようにしてください',
      });
      return;
    }
  }
});

export type Scenario = z.infer<typeof ScenarioSchema>;
type RobotSegment = Scenario['robot'][number];

/** シナリオ（JSON を読み込んだ値）を検証する。誤りは、項目の位置つきの文言の ScenarioError（値は、含めない）。 */
export function parseScenario(raw: unknown): Scenario {
  const result = ScenarioSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map(
        (issue) =>
          `${issue.path.length === 0 ? '（全体）' : issue.path.join('.')}: ${issue.message}`,
      )
      .join(' / ');
    throw new ScenarioError(`シナリオが正しくありません: ${detail}`);
  }
  return result.data;
}

/** シナリオの時刻（0 時からの分。一日を超えた値や負の値を含む）を、日の中の時刻（0 以上 1440 未満）に直す。 */
function minuteOfDay(minute: number): number {
  return ((minute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

export interface RobotState {
  readonly status: string;
  readonly activity: RobotActivity;
  /** 収穫の速さ（個/時間）。 */
  readonly harvestPerHour: number;
  /** 1 果実あたりの収穫時間（秒）。収穫中でなければ、null。 */
  readonly secondsPerFruit: number | null;
}

function segmentAt(
  scenario: Scenario,
  equipmentIndex: number,
  minute: number,
): RobotSegment | undefined {
  const covers = (segment: RobotSegment): boolean =>
    minutesOf(segment.from) <= minute && minute < minutesOf(segment.to);
  return (
    scenario.robot.find(
      (segment) => segment.equipment?.includes(equipmentIndex) === true && covers(segment),
    ) ?? scenario.robot.find((segment) => segment.equipment === undefined && covers(segment))
  );
}

/** ある時刻の、ロボットの状態（`equipmentIndex` は、設備の順番。1 から数える）。 */
export function robotStateAt(
  scenario: Scenario,
  equipmentIndex: number,
  minute: number,
): RobotState {
  const segment = segmentAt(scenario, equipmentIndex, minuteOfDay(minute));
  if (segment === undefined) {
    // 検証（parseScenario）で、一日を隙間なく覆っているため、通常は起きない（安全のため、電源なしとして扱う）
    return { status: 'STANDBY', activity: 'off', harvestPerHour: 0, secondsPerFruit: null };
  }
  return {
    status: segment.status,
    activity: segment.activity,
    harvestPerHour: segment.harvestPerHour,
    secondsPerFruit: segment.activity === 'harvesting' ? (segment.secondsPerFruit ?? null) : null,
  };
}

/** ロボットの累積の項目（収穫数・稼働時間・待機時間・収穫稼働時間・走行停止時間）。収穫数は、小数で持ち、ファイルに出すときに整数にする。 */
export interface RobotTotals {
  readonly harvestCount: number;
  readonly operatingHours: number;
  readonly standbyHours: number;
  readonly harvestOperatingHours: number;
  readonly travelStoppedHours: number;
}

export const ZERO_ROBOT_TOTALS: RobotTotals = {
  harvestCount: 0,
  operatingHours: 0,
  standbyHours: 0,
  harvestOperatingHours: 0,
  travelStoppedHours: 0,
};

/** 収穫中の、走行停止時間の割合（データ定義の想定の範囲で、小さい値）。 */
const HARVESTING_TRAVEL_STOPPED_RATIO = 0.02;
/** 積み上げの刻み（分）。時間帯の境界が、刻みの途中にあっても、中点の状態で足すため、誤差は小さい。 */
const STEP_MINUTES = 1;

/**
 * シナリオの時刻 `from` から `to`（0 時からの分。一日を超えてよい）までの間の、累積の積み上げ。日本時間の 0 時（一日の終わり）を越えると、
 * 0 に戻し、そのあとの分だけを足す。`rateFactor` は、設備ごとの収穫の速さのばらつき（収穫数だけに掛ける）。`to` が `from` 以下なら、何も足さない。
 */
export function advanceRobotTotals(
  scenario: Scenario,
  equipmentIndex: number,
  totals: RobotTotals,
  from: number,
  to: number,
  rateFactor: number,
): RobotTotals {
  let current = { ...totals };
  let time = from;
  while (time < to - 1e-9) {
    const dayEnd = (Math.floor((time + 1e-9) / DAY_MINUTES) + 1) * DAY_MINUTES;
    const step = Math.min(STEP_MINUTES, to - time, dayEnd - time);
    const state = robotStateAt(scenario, equipmentIndex, time + step / 2);
    const hours = step / 60;
    switch (state.activity) {
      case 'standby':
        current = {
          ...current,
          operatingHours: current.operatingHours + hours,
          standbyHours: current.standbyHours + hours,
        };
        break;
      case 'running':
        current = { ...current, operatingHours: current.operatingHours + hours };
        break;
      case 'harvesting':
        current = {
          ...current,
          harvestCount: current.harvestCount + state.harvestPerHour * rateFactor * hours,
          operatingHours: current.operatingHours + hours,
          harvestOperatingHours: current.harvestOperatingHours + hours,
          travelStoppedHours: current.travelStoppedHours + hours * HARVESTING_TRAVEL_STOPPED_RATIO,
        };
        break;
      case 'stopped':
        current = {
          ...current,
          operatingHours: current.operatingHours + hours,
          travelStoppedHours: current.travelStoppedHours + hours,
        };
        break;
      case 'off':
        break;
    }
    time = dayEnd - time - step <= 1e-9 ? dayEnd : time + step;
    if (time === dayEnd) {
      current = ZERO_ROBOT_TOTALS;
    }
  }
  return current;
}

export interface SensorValues {
  readonly temperature: number;
  readonly humidity: number;
  readonly illuminance: number;
  readonly co2: number;
}

function interpolate(
  points: readonly { readonly at: string; readonly value: number }[],
  minute: number,
): number {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return 0;
  }
  if (minute <= minutesOf(first.at)) {
    return first.value;
  }
  if (minute >= minutesOf(last.at)) {
    return last.value;
  }
  let previous = first;
  for (const next of points.slice(1)) {
    const nextMinute = minutesOf(next.at);
    if (minute <= nextMinute) {
      const previousMinute = minutesOf(previous.at);
      return (
        previous.value +
        ((next.value - previous.value) * (minute - previousMinute)) / (nextMinute - previousMinute)
      );
    }
    previous = next;
  }
  return last.value;
}

/** ある時刻の、環境センサーの値（キーフレームの間を、直線で補う。ばらつきは、足さない）。 */
export function sensorValuesAt(scenario: Scenario, minute: number): SensorValues {
  const time = minuteOfDay(minute);
  return {
    temperature: interpolate(scenario.sensor.temperature, time),
    humidity: interpolate(scenario.sensor.humidity, time),
    illuminance: interpolate(scenario.sensor.illuminance, time),
    co2: interpolate(scenario.sensor.co2, time),
  };
}
