/**
 * 取り込みの負荷テストの、合成データのファイル（ロボット・環境センサーの JSON）の内容の生成（Issue #344。ADR-0025）。
 * ファイルは、HTTP のテスト用ファイルサーバー（http-files.ts）に置く（設備ごとに 1 ファイル。ADR-0023）。
 * 形式は、ロボットは仮決め・環境センサーは確定の仕様（FormatProfile。dev_spec.md 4.2）。実データは使わない。乱数は種つき。
 */

import { createRandom } from '../../../src/backend/infrastructure/local/synthetic-data.ts';

const MS_PER_MINUTE = 60_000;
/** 記録どうしの間隔（分）。ファイルをまたいで、計測日時が重ならないようにする。 */
const RECORD_STEP_MINUTES = 3;

export interface FileContentOptions {
  /** ファイルの中の設備の識別子（設備の externalId）。 */
  readonly externalId: string;
  /** ファイルの通し番号（計測日時・内容が、ほかのファイルと重ならない）。 */
  readonly index: number;
  readonly recordsPerFile: number;
  /** 形式違い（壊れた内容）にする。 */
  readonly broken?: boolean;
}

function timestampOf(
  now: number,
  fileIndex: number,
  recordsPerFile: number,
  record: number,
): string {
  const minutesAgo = (fileIndex * recordsPerFile + record) * RECORD_STEP_MINUTES + 5;
  return new Date(now - minutesAgo * MS_PER_MINUTE).toISOString();
}

/** ロボットのデータ（JSON。1 ファイルが 1 機体・複数の記録）の内容。 */
export function robotFileContent(options: FileContentOptions): string {
  if (options.broken === true) {
    return `{ "robotId": "${options.externalId}", "records": [ { `;
  }
  const now = Date.now();
  const random = createRandom(20_261_100 + options.index);
  const draws = Array.from({ length: options.recordsPerFile }, () => ({
    harvestIncrement: 8 + Math.floor(random() * 8),
    harvestSecondsPerFruit: Math.round((40 + random() * 15) * 10) / 10,
    statusCode: random() < 0.8 ? 'HARVESTING' : 'RUNNING',
  }));
  // 収穫数・稼働時間などは、累積の値（D-26）。記録 0 が最も新しく、後ろの記録ほど古い。古い順に、増分を足し上げる
  const cumulative = (increment: (record: number) => number, record: number): number =>
    Math.round(
      draws.slice(record).reduce((sum, _draw, offset) => sum + increment(record + offset), 0) *
        1_000_000,
    ) / 1_000_000;
  const records = draws.map((draw, record) => ({
    timestamp: timestampOf(now, options.index, options.recordsPerFile, record),
    harvestCount: cumulative((at) => draws[at]?.harvestIncrement ?? 0, record),
    harvestSecondsPerFruit: draw.harvestSecondsPerFruit,
    operatingHours: cumulative(() => 0.05, record),
    standbyHours: cumulative(() => 0.005, record),
    harvestOperatingHours: cumulative(() => 0.03, record),
    travelStoppedHours: cumulative(() => 0.0006, record),
    statusCode: draw.statusCode,
  }));
  return JSON.stringify({ robotId: options.externalId, records });
}

/** 環境センサーのデータ（JSON。1 ファイルが 1 つのセンサー・複数の記録）の内容。 */
export function sensorFileContent(options: FileContentOptions): string {
  if (options.broken === true) {
    return '{ "unknown": [ { "column": 1 } ] }';
  }
  const now = Date.now();
  const random = createRandom(20_261_200 + options.index);
  const records = Array.from({ length: options.recordsPerFile }, (_, record) => ({
    timestamp: timestampOf(now, options.index, options.recordsPerFile, record),
    temperatureCelsius: Math.round((20 + random() * 4) * 10) / 10,
    humidityPercent: Math.round((55 + random() * 10) * 10) / 10,
    illuminanceLux: Math.round(28_000 + random() * 6000),
    co2Ppm: Math.round(850 + random() * 100),
  }));
  return JSON.stringify({ sensorId: options.externalId, records });
}
