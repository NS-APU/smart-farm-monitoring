/**
 * ファイルサーバーのモックへ置く、合成データのファイル（ロボットの JSON・環境センサーの CSV）の生成。
 * 形式は、仮決めの仕様（FormatProfile。dev_spec.md 4.2）。実データは使わない。乱数は種つき。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  }
  return options.count;
}

/** 環境センサーのデータ（CSV。1ファイルが1つのセンサー・複数の行）を置く。 */
export function placeSensorFiles(options: FileSetOptions): number {
  const directory = sourceDirectory('environment-sensor');
  const now = Date.now();
  const random = createRandom(20_261_200 + options.startIndex);
  for (let offset = 0; offset < options.count; offset += 1) {
    const index = options.startIndex + offset;
    const name = `sensor-stress-${String(index).padStart(5, '0')}.csv`;
    if (offset >= options.count - (options.brokenCount ?? 0)) {
      writeFileSync(join(directory, name), 'unknown_column,another_column\n1,2\n', 'utf8');
      continue;
    }
    const lines = ['sensor_id,timestamp,temperature_c,humidity_pct,illuminance_lx,co2_ppm'];
    for (let record = 0; record < options.recordsPerFile; record += 1) {
      lines.push(
        [
          sensorExternalId(0, 0),
          timestampOf(now, index, options.recordsPerFile, record),
          (20 + random() * 4).toFixed(1),
          (55 + random() * 10).toFixed(1),
          String(Math.round(28_000 + random() * 6000)),
          String(Math.round(850 + random() * 100)),
        ].join(','),
      );
    }
    writeFileSync(join(directory, name), `${lines.join('\n')}\n`, 'utf8');
  }
  return options.count;
}
