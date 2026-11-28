/**
 * デモ用の合成データのファイルの生成（擬似のロボット・環境センサー。Issue #77・#344。ADR-0012・ADR-0025）のテスト: ファイルの生成の規則。
 * 配信（HTTP のハンドラ）と、取り込みの通しは、demo-feed-http.test.ts。
 * ファイルは、その時点のスナップショット 1 つ（フラットな JSON。設備の識別子・記録の配列は持たない）。
 */

import { describe, expect, it } from 'vitest';
import { DEMO_FEED_INTERVAL_MINUTES } from '../../src/backend/application/demo/demo-feed-schedule.ts';
import { buildDemoFeedFiles } from '../../src/backend/infrastructure/local/demo-feed-files.ts';

const OPTIONS = { intervalMinutes: DEMO_FEED_INTERVAL_MINUTES };
// 区間の途中の時刻（UTC 04:22）。区間の開始は、04:15
const NOW = new Date('2026-10-20T04:22:30.000Z');

interface RobotFile {
  timestamp: string;
  harvestCount: number;
  operatingHours: number;
  statusCode: string;
}

const timestampOf = (content: string | undefined) =>
  (JSON.parse(content ?? '{}') as { timestamp: string }).timestamp;

describe('合成データのファイルの生成（buildDemoFeedFiles）', () => {
  it('取り込み元ごとに、1 つのファイル（latest.json）を作る。どちらも JSON で、現在の区間のスナップショット 1 つ（1 つのファイルを随時上書きする方式。ADR-0016 の D-08）', () => {
    const files = buildDemoFeedFiles(NOW, OPTIONS);

    expect(files.map((file) => `${file.sourceId}/${file.name}`)).toEqual([
      'robot/latest.json',
      'environment-sensor/latest.json',
    ]);
    expect(files.every((file) => file.contentType === 'application/json')).toBe(true);
    expect(files.map((file) => timestampOf(file.content))).toEqual([
      '2026-10-20T04:15:00.000Z',
      '2026-10-20T04:15:00.000Z',
    ]);
  });

  it('内容は、区間の時刻から決まる（同じ区間は同じ内容。実行の時刻が違っても、同じ区間は同じ）。区間が変われば、計測日時が進み、内容が変わる', () => {
    const first = buildDemoFeedFiles(NOW, OPTIONS);
    const sameBucketLater = buildDemoFeedFiles(new Date('2026-10-20T04:29:59.000Z'), OPTIONS);
    const nextBucket = buildDemoFeedFiles(new Date('2026-10-20T04:31:00.000Z'), OPTIONS);

    expect(sameBucketLater).toEqual(first);
    expect(nextBucket.map((file) => timestampOf(file.content))).toEqual([
      '2026-10-20T04:30:00.000Z',
      '2026-10-20T04:30:00.000Z',
    ]);
    expect(nextBucket[0]?.content).not.toBe(first[0]?.content);
    expect(nextBucket[1]?.content).not.toBe(first[1]?.content);
  });

  it('ロボットの収穫数・稼働時間は、「今日（日本時間）これまでの累計」（累積。日本時間の 0 時にリセット。D-26）', () => {
    // 日本時間 2026-10-21 00:15（UTC 2026-10-20T15:15Z）。0:00 の区間（15:00Z）でリセットされ、0:15 の値は、0:00 の値より大きい。
    // 前の日の最後の区間（14:45Z）の値は、0:00 の値より大きい（減る = リセット）
    const at = (iso: string) =>
      JSON.parse(buildDemoFeedFiles(new Date(iso), OPTIONS)[0]?.content ?? '{}') as RobotFile;
    const last = at('2026-10-20T14:50:00.000Z');
    const first = at('2026-10-20T15:05:00.000Z');
    const second = at('2026-10-20T15:20:00.000Z');

    expect([last.timestamp, first.timestamp, second.timestamp]).toEqual([
      '2026-10-20T14:45:00.000Z',
      '2026-10-20T15:00:00.000Z',
      '2026-10-20T15:15:00.000Z',
    ]);
    // 前日の最後 > 当日の最初（リセット）。当日は、増える。0:00 の稼働時間は、1 区間分（0.25 時間）
    expect(last.harvestCount).toBeGreaterThan(first.harvestCount);
    expect(second.harvestCount).toBeGreaterThan(first.harvestCount);
    expect(first.operatingHours).toBe(0.25);
    expect(second.operatingHours).toBe(0.5);
  });

  it('ロボットも環境センサーも、設備の識別子・記録の配列を持たない。ファイルの項目名は、形式定義の項目名（FormatProfile が読める形）', () => {
    const files = buildDemoFeedFiles(NOW, OPTIONS);
    const robot = JSON.parse(files[0]?.content ?? '{}') as Record<string, unknown>;
    const sensor = JSON.parse(files[1]?.content ?? '{}') as Record<string, unknown>;

    expect(Object.keys(robot).sort()).toEqual(
      [
        'harvestCount',
        'operatingHours',
        'standbyHours',
        'harvestOperatingHours',
        'travelStoppedHours',
        'statusCode',
        'timestamp',
      ].sort(),
    );
    expect(Object.keys(sensor).sort()).toEqual(
      ['co2', 'humidity', 'illuminance', 'temperature', 'timestamp'].sort(),
    );
  });
});
