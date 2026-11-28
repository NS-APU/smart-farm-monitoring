/**
 * 取り込みの負荷テストの、合成データのファイル（ロボット・環境センサーの JSON）の内容の生成（Issue #344。ADR-0025）。
 * ファイルは、HTTP のテスト用ファイルサーバー（http-files.ts）に置く（設備ごとに 1 ファイル。ADR-0023）。
 * 形式は、ロボット・環境センサーとも確定の仕様（FormatProfile。dev_spec.md 4.2）。実データは使わない。乱数は種つき。
 */

import { createRandom } from '../../../src/backend/infrastructure/local/synthetic-data.ts';

const MS_PER_MINUTE = 60_000;
/** ファイルの通し番号ごとの、計測日時の間隔（分）。ファイルをまたいで、計測日時が重ならないようにする。 */
const FILE_STEP_MINUTES = 3;

export interface FileContentOptions {
  /** ファイルの通し番号（計測日時・内容が、ほかのファイルと重ならない）。 */
  readonly index: number;
  /** 形式違い（壊れた内容）にする。 */
  readonly broken?: boolean;
}

function timestampOf(now: number, fileIndex: number): string {
  const minutesAgo = fileIndex * FILE_STEP_MINUTES + 5;
  return new Date(now - minutesAgo * MS_PER_MINUTE).toISOString();
}

/**
 * ロボットのデータ（JSON。その時点のスナップショット 1 つ。設備の識別子・記録の配列は持たない。設備は、設備のファイルのパスで決まる）の内容。
 * 収穫数・稼働時間などは、累積の値（D-26）。
 */
export function robotFileContent(options: FileContentOptions): string {
  if (options.broken === true) {
    return '{ "timestamp": "2026-10-09T02:15:00Z", "harvestCount": ';
  }
  const now = Date.now();
  const random = createRandom(20_261_100 + options.index);
  const harvestIncrement = 8 + Math.floor(random() * 8);
  return JSON.stringify({
    timestamp: timestampOf(now, options.index),
    harvestCount: harvestIncrement,
    harvestSecondsPerFruit: Math.round((40 + random() * 15) * 10) / 10,
    operatingHours: 0.05,
    standbyHours: 0.005,
    harvestOperatingHours: 0.03,
    travelStoppedHours: 0.0006,
    statusCode: random() < 0.8 ? 'HARVESTING' : 'RUNNING',
  });
}

/** 環境センサーのデータ（JSON。その時点のスナップショット 1 つ。ファイルの項目名は temperature・humidity・illuminance・co2）の内容。 */
export function sensorFileContent(options: FileContentOptions): string {
  if (options.broken === true) {
    return '{ "unknown": [ { "column": 1 } ] }';
  }
  const now = Date.now();
  const random = createRandom(20_261_200 + options.index);
  return JSON.stringify({
    timestamp: timestampOf(now, options.index),
    temperature: Math.round((20 + random() * 4) * 10) / 10,
    humidity: Math.round((55 + random() * 10) * 10) / 10,
    illuminance: Math.round(28_000 + random() * 6000),
    co2: Math.round(850 + random() * 100),
  });
}
