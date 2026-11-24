/**
 * 合成データのファイルの生成（擬似のロボット・環境センサーが、ファイルサーバーに置くファイル。デモ用の HTTP 配信が返す。Issue #344。ADR-0025）。
 * 取り込み元ごとに、**1 つのファイル（`latest.json`）を、随時上書きする**（宇都宮大学から示された方式。更新のたびに全体が
 * 書き換わり、中身は最新の値だけ。Issue #174。ADR-0016 の D-08）。ロボットは `robot-json`、環境センサーは
 * `environment-sensor-json`（どちらも JSON。設備の識別子 + 記録の配列）。
 * 値は、デモのデータ（synthetic-data.ts の generateAutoObservations）と同じ生成の規則で、**区間の時刻から決まる**（同じ区間は、同じ内容）。
 * 収穫数・稼働時間などの累積の項目は、「今日（日本時間）これまでの累計」（日本時間の 0 時にリセット。D-26）。
 * 実行が数回、抜けても、直近の区間は、ファイルの記録に含まれる。実データは使わない（合成データのみ）。
 */

import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import {
  DEMO_FEED_TEMPERATURE_BASE_CELSIUS,
  type DemoFeedSourceId,
} from '../../application/demo/demo-feed-schedule.ts';
import {
  DEMO_ROBOT_EXTERNAL_ID,
  DEMO_SENSOR_EXTERNAL_ID,
  ZERO_TOTALS,
  addToTotals,
  createRandom,
  generateAutoSample,
  japanDayOf,
} from './synthetic-data.ts';

/** 区間ごとの乱数の種の基準（区間の番号を足す）。デモの投入（20_261_009）とは、別の値にする。 */
const FEED_SEED_BASE = 20_261_100;

/** 取り込み元ごとに置くファイルの名前（毎回、同じ名前に上書きする）。 */
export const DEMO_FEED_FILE_NAME = 'latest.json';

export interface DemoFeedFile {
  readonly sourceId: DemoFeedSourceId;
  readonly name: string;
  readonly content: string;
  readonly contentType: string;
}

/**
 * 現在を含む、直近 `buckets` 個の区間（`intervalMinutes` 分ごと。UTC の 0 時からの区切り）の記録を、古い順に持つ、
 * ロボットの JSON と、環境センサーの JSON を、1 つずつ作る（記録は、区間の開始の時刻の 1 件ずつ）。
 */
export function buildDemoFeedFiles(
  now: Date,
  options: { readonly intervalMinutes: number; readonly buckets: number },
): DemoFeedFile[] {
  const intervalMs = options.intervalMinutes * MS_PER_MINUTE;
  const currentBucket = Math.floor(now.getTime() / intervalMs);
  const firstBucket = currentBucket - options.buckets + 1;
  // 累積の値は、その日（日本時間）の最初の区間から足し上げる（ファイルに含める最初の区間より前の分も、同じ規則で決まる）
  const dayOfBucket = (bucket: number): number => japanDayOf(bucket * intervalMs);
  let startBucket = firstBucket;
  while (dayOfBucket(startBucket - 1) === dayOfBucket(firstBucket)) {
    startBucket -= 1;
  }
  const robotRecords: Record<string, unknown>[] = [];
  const sensorRecords: Record<string, unknown>[] = [];
  let totals = ZERO_TOTALS;
  for (let bucket = startBucket; bucket <= currentBucket; bucket += 1) {
    const sample = generateAutoSample(
      createRandom(FEED_SEED_BASE + bucket),
      options.intervalMinutes,
      DEMO_FEED_TEMPERATURE_BASE_CELSIUS,
    );
    if (bucket > startBucket && dayOfBucket(bucket) !== dayOfBucket(bucket - 1)) {
      totals = ZERO_TOTALS;
    }
    totals = addToTotals(totals, sample);
    if (bucket < firstBucket) {
      continue;
    }
    const timestamp = new Date(bucket * intervalMs).toISOString();
    robotRecords.push({
      timestamp,
      harvestCount: totals.harvestCount,
      operatingHours: totals.operatingHours,
      standbyHours: totals.standbyHours,
      harvestOperatingHours: totals.harvestOperatingHours,
      travelStoppedHours: totals.travelStoppedHours,
      statusCode: sample.statusCode,
    });
    sensorRecords.push({
      timestamp,
      temperatureCelsius: sample.temperatureCelsius,
      humidityPercent: sample.humidityPercent,
      illuminanceLux: sample.illuminanceLux,
      co2Ppm: sample.co2Ppm,
    });
  }
  const render = (document: Record<string, unknown>) => `${JSON.stringify(document, null, 2)}\n`;
  return [
    {
      sourceId: 'robot',
      name: DEMO_FEED_FILE_NAME,
      content: render({ robotId: DEMO_ROBOT_EXTERNAL_ID, records: robotRecords }),
      contentType: 'application/json',
    },
    {
      sourceId: 'environment-sensor',
      name: DEMO_FEED_FILE_NAME,
      content: render({ sensorId: DEMO_SENSOR_EXTERNAL_ID, records: sensorRecords }),
      contentType: 'application/json',
    },
  ];
}
