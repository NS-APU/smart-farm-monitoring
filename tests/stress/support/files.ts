/**
 * ファイルサーバーのモックへ置く、合成データのファイル（ロボット・環境センサーの JSON）の生成。
 * 形式は、仮決めの仕様（FormatProfile。dev_spec.md 4.2）。実データは使わない。乱数は種つき。
 */

import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRandom } from '../../../src/backend/infrastructure/local/synthetic-data.ts';
import { robotExternalId, sensorExternalId } from './scale.ts';

/** バックエンドのファイルサーバーのモックのルート（playwright.stress.config.ts の FILE_SERVER_DIR と同じ）。 */
export const FILE_SERVER_ROOT = resolve('test-result/stress/file-server');

const MS_PER_MINUTE = 60_000;
/** 記録どうしの間隔（分）。ファイルをまたいで、計測日時が重ならないようにする。 */
const RECORD_STEP_MINUTES = 3;

export interface FileSetOptions {
  /** ファイルの通し番号の始まり（計測日時・ファイル名・内容が、ほかのファイルと重ならない）。 */
  readonly startIndex: number;
  readonly count: number;
  readonly recordsPerFile: number;
  /** 形式違い（壊れた内容）のファイルの数（count の内数。末尾から）。 */
  readonly brokenCount?: number;
}

function sourceDirectory(sourceId: 'robot' | 'environment-sensor'): string {
  const directory = join(FILE_SERVER_ROOT, sourceId);
  mkdirSync(directory, { recursive: true });
  return directory;
}

/**
 * ファイルの更新日時を、1 分前にする。更新日時が 1 秒以内のファイルは、書き換えの最中かもしれないため、読まずに次の周期に回す
 * （ADR-0016 の D-08）。置いた直後に取り込みを実行する負荷テストで、回されないようにする。
 */
function markAsSettled(path: string): void {
  const settledAt = new Date(Date.now() - MS_PER_MINUTE);
  utimesSync(path, settledAt, settledAt);
}

/** 取り込み元のファイルを、すべて消す（ディレクトリは残す）。 */
export function clearSourceFiles(sourceId: 'robot' | 'environment-sensor'): void {
  rmSync(sourceDirectory(sourceId), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  mkdirSync(join(FILE_SERVER_ROOT, sourceId), { recursive: true });
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

/** ロボットのデータ（JSON。1ファイルが1機体・複数の記録）を置く。 */
export function placeRobotFiles(options: FileSetOptions): number {
  const directory = sourceDirectory('robot');
  const now = Date.now();
  const random = createRandom(20_261_100 + options.startIndex);
  for (let offset = 0; offset < options.count; offset += 1) {
    const index = options.startIndex + offset;
    const name = `robot-stress-${String(index).padStart(5, '0')}.json`;
    if (offset >= options.count - (options.brokenCount ?? 0)) {
      writeFileSync(
        join(directory, name),
        '{ "robotId": "ROBOT-STRESS-1-1", "records": [ { ',
        'utf8',
      );
      markAsSettled(join(directory, name));
      continue;
    }
    const records = Array.from({ length: options.recordsPerFile }, (_, record) => ({
      timestamp: timestampOf(now, index, options.recordsPerFile, record),
      harvestCount: 8 + Math.floor(random() * 8),
      harvestSecondsPerFruit: Math.round((40 + random() * 15) * 10) / 10,
      operatingHours: 0.05,
      standbyHours: 0.005,
      harvestOperatingHours: 0.03,
      travelStoppedHours: 0.0006,
      statusCode: random() < 0.8 ? 'HARVESTING' : 'RUNNING',
    }));
    writeFileSync(
      join(directory, name),
      JSON.stringify({ robotId: robotExternalId(0, 0), records }),
      'utf8',
    );
    markAsSettled(join(directory, name));
  }
  return options.count;
}

/** 環境センサーのデータ（JSON。1ファイルが1つのセンサー・複数の記録）を置く。 */
export function placeSensorFiles(options: FileSetOptions): number {
  const directory = sourceDirectory('environment-sensor');
  const now = Date.now();
  const random = createRandom(20_261_200 + options.startIndex);
  for (let offset = 0; offset < options.count; offset += 1) {
    const index = options.startIndex + offset;
    const name = `sensor-stress-${String(index).padStart(5, '0')}.json`;
    if (offset >= options.count - (options.brokenCount ?? 0)) {
      writeFileSync(join(directory, name), '{ "unknown": [ { "column": 1 } ] }', 'utf8');
      markAsSettled(join(directory, name));
      continue;
    }
    const records = Array.from({ length: options.recordsPerFile }, (_, record) => ({
      timestamp: timestampOf(now, index, options.recordsPerFile, record),
      temperatureCelsius: Math.round((20 + random() * 4) * 10) / 10,
      humidityPercent: Math.round((55 + random() * 10) * 10) / 10,
      illuminanceLux: Math.round(28_000 + random() * 6000),
      co2Ppm: Math.round(850 + random() * 100),
    }));
    writeFileSync(
      join(directory, name),
      JSON.stringify({ sensorId: sensorExternalId(0, 0), records }),
      'utf8',
    );
    markAsSettled(join(directory, name));
  }
  return options.count;
}
