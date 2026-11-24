/**
 * デモ用の合成データのファイルの生成（擬似のロボット・環境センサー。Issue #77・#344。ADR-0012・ADR-0025）のテスト: ファイルの生成の規則。
 * 配信（HTTP のハンドラ）と、取り込みの通しは、demo-feed-http.test.ts。
 */

import { describe, expect, it } from 'vitest';
import {
  DEMO_FEED_BUCKETS,
  DEMO_FEED_INTERVAL_MINUTES,
} from '../../src/backend/application/demo/demo-feed-schedule.ts';
import { buildDemoFeedFiles } from '../../src/backend/infrastructure/local/demo-feed-files.ts';

const OPTIONS = { intervalMinutes: DEMO_FEED_INTERVAL_MINUTES, buckets: DEMO_FEED_BUCKETS };
// 区間の途中の時刻（UTC 04:22）。区間の開始は、04:15
const NOW = new Date('2026-10-20T04:22:30.000Z');

describe('合成データのファイルの生成（buildDemoFeedFiles）', () => {
  it('取り込み元ごとに、1 つのファイル（latest.json）を作る。どちらも JSON で、直近の区間の記録を、古い順に持つ（1 つのファイルを随時上書きする方式。ADR-0016 の D-08）', () => {
    const files = buildDemoFeedFiles(NOW, OPTIONS);

    expect(files.map((file) => `${file.sourceId}/${file.name}`)).toEqual([
      'robot/latest.json',
      'environment-sensor/latest.json',
    ]);
    expect(files.every((file) => file.contentType === 'application/json')).toBe(true);
    const timestamps = files.map((file) =>
      (JSON.parse(file.content) as { records: { timestamp: string }[] }).records.map(
        (record) => record.timestamp,
      ),
    );
    const expected = [
      '2026-10-20T03:30:00.000Z',
      '2026-10-20T03:45:00.000Z',
      '2026-10-20T04:00:00.000Z',
      '2026-10-20T04:15:00.000Z',
    ];
    expect(timestamps).toEqual([expected, expected]);
  });

  it('内容は、区間の時刻から決まる（同じ区間は同じ内容。実行の時刻が違っても、同じ区間は同じ）。区間が変われば、最も古い記録が外れ、新しい記録が増える', () => {
    const first = buildDemoFeedFiles(NOW, OPTIONS);
    const sameBucketLater = buildDemoFeedFiles(new Date('2026-10-20T04:29:59.000Z'), OPTIONS);
    const nextBucket = buildDemoFeedFiles(new Date('2026-10-20T04:31:00.000Z'), OPTIONS);

    expect(sameBucketLater).toEqual(first);
    const recordsOf = (files: typeof first) =>
      new Map(
        (
          JSON.parse(files[0]?.content ?? '{}') as {
            records: { timestamp: string }[];
          }
        ).records.map((record) => [record.timestamp, JSON.stringify(record)]),
      );
    const before = recordsOf(first);
    const after = recordsOf(nextBucket);
    // 重なる区間（04:15 など）の記録は、同じ内容。最も古い区間（03:30）は、外れる（消えた行は、取り込みで反映しない）
    expect(after.get('2026-10-20T04:15:00.000Z')).toBe(before.get('2026-10-20T04:15:00.000Z'));
    expect(after.has('2026-10-20T04:30:00.000Z')).toBe(true);
    expect(after.has('2026-10-20T03:30:00.000Z')).toBe(false);
    expect(before.get('2026-10-20T04:00:00.000Z')).not.toBe(before.get('2026-10-20T04:15:00.000Z'));
  });

  it('ロボットの収穫数・稼働時間は、「今日（日本時間）これまでの累計」（累積。日本時間の 0 時にリセット。D-26）', () => {
    // 日本時間 2026-10-21 00:15（UTC 2026-10-20T15:15Z）。0:00 の区間（15:00Z）でリセットされ、0:15 の値は、0:00 の値より大きい。
    // 前の日の最後の区間（14:45Z）の値は、0:00 の値より大きい（減る = リセット）
    const files = buildDemoFeedFiles(new Date('2026-10-20T15:20:00.000Z'), {
      intervalMinutes: 15,
      buckets: 3,
    });
    const records = (
      JSON.parse(files[0]?.content ?? '{}') as {
        records: { timestamp: string; harvestCount: number; operatingHours: number }[];
      }
    ).records;

    expect(records.map((record) => record.timestamp)).toEqual([
      '2026-10-20T14:45:00.000Z',
      '2026-10-20T15:00:00.000Z',
      '2026-10-20T15:15:00.000Z',
    ]);
    const [last, first, second] = records;
    // 前日の最後 > 当日の最初（リセット）。当日は、増える。0:00 の稼働時間は、1 区間分（0.25 時間）
    expect(last?.harvestCount).toBeGreaterThan(first?.harvestCount ?? 0);
    expect(second?.harvestCount).toBeGreaterThan(first?.harvestCount ?? 0);
    expect(first?.operatingHours).toBe(0.25);
    expect(second?.operatingHours).toBe(0.5);
  });

  it('累積の値は、ファイルに含める最初の区間より前の分も含む（区間の数に依らず、同じ区間は同じ値）', () => {
    const now = new Date('2026-10-20T04:22:30.000Z');
    const few = buildDemoFeedFiles(now, { intervalMinutes: 15, buckets: 2 });
    const many = buildDemoFeedFiles(now, { intervalMinutes: 15, buckets: 8 });
    const lastOf = (files: typeof few) =>
      (JSON.parse(files[0]?.content ?? '{}') as { records: unknown[] }).records.at(-1);

    expect(lastOf(few)).toEqual(lastOf(many));
  });

  it('ロボットは robotId、センサーは sensorId と、記録の配列を持つ（FormatProfile が読める形）', () => {
    const files = buildDemoFeedFiles(NOW, { intervalMinutes: 15, buckets: 1 });
    const robot = JSON.parse(files[0]?.content ?? '{}') as {
      robotId: string;
      records: Record<string, unknown>[];
    };
    const sensor = JSON.parse(files[1]?.content ?? '{}') as {
      sensorId: string;
      records: Record<string, unknown>[];
    };

    expect(robot.robotId).toBe('ROBOT-SAMPLE-01');
    expect(robot.records).toHaveLength(1);
    expect(robot.records[0]).toMatchObject({ timestamp: '2026-10-20T04:15:00.000Z' });
    expect(sensor.sensorId).toBe('SENSOR-SAMPLE-01');
    expect(sensor.records).toHaveLength(1);
    expect(Object.keys(sensor.records[0] ?? {}).sort()).toEqual(
      ['co2Ppm', 'humidityPercent', 'illuminanceLux', 'temperatureCelsius', 'timestamp'].sort(),
    );
  });
});
