/**
 * 合成データの生成（ローカルのデモ・E2E・負荷テスト用）。実データは使わない（security.md）。
 * 乱数は、種（seed）を指定でき、同じ種で同じデータになる（テストの再現性）。
 */

import { STATUS_CODE_ITEM_KEY, findItemDefinition } from '@smart-farm/shared/constants/items';
import { AppError } from '@smart-farm/shared/errors';
import { toEquipmentId, type EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';

const DEMO_FACILITY_ID = toEquipmentId('HOUSE-01');
export const DEMO_ROBOT_ID = toEquipmentId('ROBOT-01');
export const DEMO_SENSOR_ID = toEquipmentId('SENSOR-01');
/** ファイルの中の設備の識別子（モックのファイルサーバーの合成データと対応する）。 */
export const DEMO_ROBOT_EXTERNAL_ID = 'ROBOT-SAMPLE-01';
export const DEMO_SENSOR_EXTERNAL_ID = 'SENSOR-SAMPLE-01';

export function buildDemoEquipment(createdAt: Date): Equipment[] {
  const timestamp = createdAt.toISOString();
  return [
    {
      equipmentId: DEMO_FACILITY_ID,
      equipmentType: 'FACILITY',
      name: 'ハウス1',
      isDeleted: false,
      createdAt: timestamp,
    },
    {
      equipmentId: DEMO_ROBOT_ID,
      equipmentType: 'ROBOT',
      name: '収穫ロボット1',
      facilityId: DEMO_FACILITY_ID,
      externalId: DEMO_ROBOT_EXTERNAL_ID,
      isDeleted: false,
      createdAt: timestamp,
    },
    {
      equipmentId: DEMO_SENSOR_ID,
      equipmentType: 'SENSOR',
      name: '環境センサー1',
      facilityId: DEMO_FACILITY_ID,
      externalId: DEMO_SENSOR_EXTERNAL_ID,
      isDeleted: false,
      createdAt: timestamp,
    },
  ];
}

/** 種つきの擬似乱数（mulberry32）。0 以上 1 未満。 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface SyntheticOptions {
  readonly robotId: EquipmentId;
  readonly sensorId: EquipmentId;
  readonly from: Date;
  readonly to: Date;
  /** 自動取り込みの間隔（分）。 */
  readonly intervalMinutes: number;
  readonly seed: number;
  /** 温度の基準（℃）。27 にすると「注意」になる。 */
  readonly temperatureBaseCelsius?: number;
}

/** 観測値の共通の形。カテゴリは、項目カタログから決める（カタログにない項目は VALIDATION_ERROR）。 */
function buildObservation(
  fields: {
    readonly equipmentId: EquipmentId;
    readonly itemKey: string;
    readonly observedAt: Date;
    readonly value: number | string | null;
    readonly source: Observation['source'];
    readonly quality: Observation['quality'];
    readonly receivedAt: Date;
  },
  /** 自動取り込みの観測値に付ける、取得元のファイルと解釈の版の目印。 */
  fileTag: 'synthetic' | 'seeded',
): Observation {
  const category = findItemDefinition(fields.itemKey)?.category;
  if (category === undefined) {
    throw new AppError('VALIDATION_ERROR', `項目カタログにない項目です: ${fields.itemKey}`);
  }
  return {
    equipmentId: fields.equipmentId,
    category,
    itemKey: fields.itemKey,
    observedAt: fields.observedAt.toISOString(),
    value: fields.value,
    source: fields.source,
    quality: fields.quality,
    receivedAt: fields.receivedAt.toISOString(),
    ...(fields.source === 'AUTO_IMPORT'
      ? { sourceFileId: fileTag, formatProfileVersion: `${fileTag}@0` }
      : {}),
    isDeleted: false,
  };
}

/** 合成データの観測値（正常。計測と同時に受信）。 */
function observation(
  equipmentId: EquipmentId,
  itemKey: string,
  at: Date,
  value: number | string,
  source: Observation['source'],
): Observation {
  return buildObservation(
    { equipmentId, itemKey, observedAt: at, value, source, quality: 'VALID', receivedAt: at },
    'synthetic',
  );
}

/** 小数を丸める。評価の roundTo（Number.EPSILON を加える）とは丸めの結果が異なりうるため、合成データでは、これを使う（同じ種で、同じデータにするため）。 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 1 つの時刻の、ロボット・環境センサーの合成データの値（正常な範囲）。 */
export interface AutoSample {
  readonly harvestCount: number;
  readonly operatingHours: number;
  readonly harvestOperatingHours: number;
  readonly travelStoppedHours: number;
  readonly standbyHours: number;
  readonly statusCode: 'HARVESTING' | 'RUNNING';
  readonly temperatureCelsius: number;
  readonly humidityPercent: number;
  readonly illuminanceLux: number;
  readonly co2Ppm: number;
}

/**
 * 1 つの時刻の合成データの値を作る。**乱数を消費する順序は、変えない**（同じ種で、同じデータになる）。
 * 観測値の生成（generateAutoObservations）と、ファイルの生成（demo-feed-files.ts）が、同じ規則を使う。
 */
export function generateAutoSample(
  random: () => number,
  intervalMinutes: number,
  temperatureBaseCelsius: number,
): AutoSample {
  const hoursPerStep = intervalMinutes / 60;
  const harvestHours = round(hoursPerStep * (0.55 + random() * 0.1), 4);
  const harvestCount = 10 + Math.floor(random() * 5);
  const statusCode = random() < 0.8 ? 'HARVESTING' : 'RUNNING';
  const temperatureCelsius = round(temperatureBaseCelsius + random() * 4, 1);
  const humidityPercent = round(55 + random() * 10, 1);
  const illuminanceLux = Math.round(28_000 + random() * 6_000);
  const co2Ppm = Math.round(850 + random() * 100);
  return {
    harvestCount,
    operatingHours: round(hoursPerStep, 4),
    harvestOperatingHours: harvestHours,
    travelStoppedHours: round(harvestHours * 0.02, 5),
    standbyHours: round(hoursPerStep * 0.1, 4),
    statusCode,
    temperatureCelsius,
    humidityPercent,
    illuminanceLux,
    co2Ppm,
  };
}

/** ロボット・環境センサーの自動取り込み相当の合成データ（正常な範囲）。 */
export function generateAutoObservations(options: SyntheticOptions): Observation[] {
  const random = createRandom(options.seed);
  const result: Observation[] = [];
  const stepMs = options.intervalMinutes * MS_PER_MINUTE;
  const temperatureBase = options.temperatureBaseCelsius ?? 20;
  for (let at = options.from.getTime(); at <= options.to.getTime(); at += stepMs) {
    const time = new Date(at);
    const sample = generateAutoSample(random, options.intervalMinutes, temperatureBase);
    const rows: readonly (readonly [EquipmentId, string, number | string])[] = [
      [options.robotId, 'harvestCount', sample.harvestCount],
      [options.robotId, 'operatingHours', sample.operatingHours],
      [options.robotId, 'harvestOperatingHours', sample.harvestOperatingHours],
      [options.robotId, 'travelStoppedHours', sample.travelStoppedHours],
      [options.robotId, 'standbyHours', sample.standbyHours],
      [options.robotId, STATUS_CODE_ITEM_KEY, sample.statusCode],
      [options.sensorId, 'temperatureCelsius', sample.temperatureCelsius],
      [options.sensorId, 'humidityPercent', sample.humidityPercent],
      [options.sensorId, 'illuminanceLux', sample.illuminanceLux],
      [options.sensorId, 'co2Ppm', sample.co2Ppm],
    ];
    for (const [equipmentId, itemKey, value] of rows) {
      result.push(observation(equipmentId, itemKey, time, value, 'AUTO_IMPORT'));
    }
  }
  return result;
}

/** 手動入力相当の合成データ（操作・収穫・安全・故障・コスト）。満足度は含めない（「不明」の例にする）。 */
export function generateManualObservations(options: {
  readonly robotId: EquipmentId;
  readonly at: Date;
  readonly enteredBy: Observation['enteredBy'];
}): Observation[] {
  const entries: readonly (readonly [string, number])[] = [
    ['operationMinutes', 8],
    ['operationStepCount', 4],
    ['operationErrorCount', 0],
    ['damagedFruitCount', 3],
    ['wrongHarvestCount', 2],
    ['missedFruitCount', 4],
    ['emergencyStopCount', 0],
    ['nearMissCount', 0],
    ['failureCount', 1],
    ['recoveryMinutes', 90],
    ['robotCostYenPerHour', 300],
    ['laborCostYenPerHour', 1200],
    ['maintenanceCostYen', 500],
    ['electricityCostYen', 400],
  ];
  return entries.map(([itemKey, value]) => ({
    ...observation(options.robotId, itemKey, options.at, value, 'MANUAL'),
    ...omitUndefined({ enteredBy: options.enteredBy }),
  }));
}

export interface SeededObservationInput {
  readonly equipmentId: EquipmentId;
  readonly itemKey: string;
  readonly observedAt: Date;
  readonly value: number | string | null;
  readonly source: Observation['source'];
  readonly quality: Observation['quality'];
  /** 省略時は、計測日時（遅延なし）。 */
  readonly receivedAt?: Date;
}

/** 開発用 API・E2E で、状態ごとの値を作るための観測値（カテゴリは、項目カタログから決める）。 */
export function buildSeededObservation(input: SeededObservationInput): Observation {
  return buildObservation(
    {
      equipmentId: input.equipmentId,
      itemKey: input.itemKey,
      observedAt: input.observedAt,
      value: input.value,
      source: input.source,
      quality: input.quality,
      receivedAt: input.receivedAt ?? input.observedAt,
    },
    'seeded',
  );
}

/** 展開できる観測値の上限（開発用 API に、巨大な指定を許さない）。 */
export const MAX_EXPANDED_OBSERVATIONS = 200_000;

export interface SeededSeriesInput extends Omit<
  SeededObservationInput,
  'observedAt' | 'receivedAt'
> {
  readonly from: Date;
  readonly to: Date;
  readonly intervalMinutes: number;
}

/** 一定の間隔（from 以上 to 以下）で、同じ値の観測値を並べる。 */
export function expandSeededSeries(input: SeededSeriesInput): Observation[] {
  const stepMs = input.intervalMinutes * MS_PER_MINUTE;
  const count = Math.floor((input.to.getTime() - input.from.getTime()) / stepMs) + 1;
  if (count > MAX_EXPANDED_OBSERVATIONS) {
    throw new AppError('VALIDATION_ERROR', '展開する観測値が多すぎます');
  }
  return Array.from({ length: Math.max(0, count) }, (_, index) =>
    buildSeededObservation({
      ...input,
      observedAt: new Date(input.from.getTime() + index * stepMs),
    }),
  );
}
