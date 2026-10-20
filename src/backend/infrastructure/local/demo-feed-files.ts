/**
 * 合成データのファイルの生成（擬似のロボット・環境センサーが、ファイルサーバーに置くファイル。Issue #77。ADR-0012）。
 * ロボットは JSON（FormatProfile `robot-json`）、環境センサーは CSV（`environment-sensor-csv`）。値は、デモのデータ
 * （synthetic-data.ts の generateAutoObservations）と同じ生成の規則で、**区間の時刻から決まる**（同じ区間は、同じ内容）。
 * 実データは使わない（合成データのみ）。
 */

import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import {
  DEMO_FEED_TEMPERATURE_BASE_CELSIUS,
  type DemoFeedSourceId,
} from '../../application/demo/demo-feed-schedule.ts';
import {
  DEMO_ROBOT_EXTERNAL_ID,
  DEMO_SENSOR_EXTERNAL_ID,
  createRandom,
  generateAutoSample,
} from './synthetic-data.ts';

/** 区間ごとの乱数の種の基準（区間の番号を足す）。デモの投入（20_261_009）とは、別の値にする。 */
const FEED_SEED_BASE = 20_261_100;

export interface DemoFeedFile {
  readonly sourceId: DemoFeedSourceId;
  readonly name: string;
  readonly content: string;
  readonly contentType: string;
}

/** `20261020T0415Z` の形（分まで。ファイル名に使う。時刻の順に、名前も並ぶ）。区間は、分の単位のため、秒は要らない。 */
function stampOf(time: Date): string {
  return `${time.toISOString().slice(0, 16).replace(/[-:]/g, '')}Z`;
}

/**
 * 現在を含む、直近 `buckets` 個の区間（`intervalMinutes` 分ごと。UTC の 0 時からの区切り）の、ファイルを作る。
 * 区間ごとに、ロボットの JSON と、環境センサーの CSV を、1 つずつ（記録は、区間の開始の時刻の 1 件）。
 */
export function buildDemoFeedFiles(
  now: Date,
  options: { readonly intervalMinutes: number; readonly buckets: number },
): DemoFeedFile[] {
  const intervalMs = options.intervalMinutes * MS_PER_MINUTE;
  const currentBucket = Math.floor(now.getTime() / intervalMs);
  const files: DemoFeedFile[] = [];
  for (let back = options.buckets - 1; back >= 0; back -= 1) {
    const bucket = currentBucket - back;
    const timestamp = new Date(bucket * intervalMs);
    const sample = generateAutoSample(
      createRandom(FEED_SEED_BASE + bucket),
      options.intervalMinutes,
      DEMO_FEED_TEMPERATURE_BASE_CELSIUS,
    );
    const stamp = stampOf(timestamp);
    files.push({
      sourceId: 'robot',
      name: `robot-${stamp}.json`,
      content: `${JSON.stringify(
        {
          robotId: DEMO_ROBOT_EXTERNAL_ID,
          records: [
            {
              timestamp: timestamp.toISOString(),
              harvestCount: sample.harvestCount,
              operatingHours: sample.operatingHours,
              standbyHours: sample.standbyHours,
              harvestOperatingHours: sample.harvestOperatingHours,
              travelStoppedHours: sample.travelStoppedHours,
              statusCode: sample.statusCode,
            },
          ],
        },
        null,
        2,
      )}\n`,
      contentType: 'application/json',
    });
    files.push({
      sourceId: 'environment-sensor',
      name: `sensor-${stamp}.csv`,
      content: [
        'sensor_id,timestamp,temperature_c,humidity_pct,illuminance_lx,co2_ppm',
        [
          DEMO_SENSOR_EXTERNAL_ID,
          timestamp.toISOString(),
          sample.temperatureCelsius,
          sample.humidityPercent,
          sample.illuminanceLux,
          sample.co2Ppm,
        ].join(','),
        '',
      ].join('\n'),
      contentType: 'text/csv',
    });
  }
  return files;
}
