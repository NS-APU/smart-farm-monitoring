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
