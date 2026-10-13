/**
 * メトリクスの推移（UC-03）の算出（純粋関数）の単体テスト: 区間の決め方、区間ごとの集計、平均、欠損の扱い。
 * 観点の元データの項目（FR-6.4）も、ここで確認する。
 */

import { describe, expect, it } from 'vitest';
import { findItemDefinition } from '../../../../src/shared/constants/items.ts';
import { JST_OFFSET_MINUTES } from '../../../../src/shared/time.ts';
import {
  computeMetricSeries,
  planBuckets,
} from '../../../../src/backend/domain/evaluation/series.ts';
import { getViewpointDefinition } from '../../../../src/backend/domain/evaluation/viewpoints/registry.ts';
import { viewpointSourceItemKeys } from '../../../../src/backend/domain/evaluation/viewpoints/source-items.ts';
import { VIEWPOINT_DEFINITIONS } from '../../../../src/backend/domain/evaluation/viewpoints/registry.ts';
import { observation, SENSOR_ID } from '../../../support/builders.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** 2026-10-09 12:00 JST（03:00Z）。 */
const NOW = new Date('2026-10-09T03:00:00.000Z');

describe('区間の決め方（planBuckets）', () => {
  it('短期は、評価時刻を含む1時間を最後にした、24区間（1時間ごと）', () => {
    const plan = planBuckets(
      new Date('2026-10-09T03:30:00.000Z'),
      'SHORT',
      null,
      JST_OFFSET_MINUTES,
    );

    expect(plan.bucket).toBe('HOUR');
    expect(plan.starts).toHaveLength(24);
    expect(plan.starts.at(-1)?.toISOString()).toBe('2026-10-09T03:00:00.000Z');
    expect(plan.starts[0]?.toISOString()).toBe('2026-10-08T04:00:00.000Z');
  });

  it('長期の当日（1日）も、1時間ごとの24区間', () => {
    const plan = planBuckets(NOW, 'LONG', 1, JST_OFFSET_MINUTES);

    expect(plan.bucket).toBe('HOUR');
    expect(plan.starts).toHaveLength(24);
  });

  it.each([7, 30, 60, 90] as const)(
    '長期の直近%s日は、日本時間の日ごとの区間（最後は今日）',
    (days) => {
      const plan = planBuckets(NOW, 'LONG', days, JST_OFFSET_MINUTES);

      expect(plan.bucket).toBe('DAY');
      expect(plan.starts).toHaveLength(days);
      // 今日（2026-10-09 JST）の開始 = 2026-10-08T15:00Z
      expect(plan.starts.at(-1)?.toISOString()).toBe('2026-10-08T15:00:00.000Z');
      expect(plan.starts[0]?.getTime()).toBe(
        Date.parse('2026-10-08T15:00:00.000Z') - (days - 1) * DAY_MS,
      );
    },
  );

  it('日本時間 0:00 ちょうどは、新しい日の開始。その1ミリ秒前は前の日', () => {
    const atMidnight = planBuckets(
      new Date('2026-10-08T15:00:00.000Z'),
      'LONG',
      7,
      JST_OFFSET_MINUTES,
    );
    const beforeMidnight = planBuckets(
      new Date('2026-10-08T14:59:59.999Z'),
      'LONG',
      7,
      JST_OFFSET_MINUTES,
    );

    expect(atMidnight.starts.at(-1)?.toISOString()).toBe('2026-10-08T15:00:00.000Z');
    expect(beforeMidnight.starts.at(-1)?.toISOString()).toBe('2026-10-07T15:00:00.000Z');
  });

  it('期間の指定がない長期は、1日として扱う', () => {
    const plan = planBuckets(NOW, 'LONG', null, JST_OFFSET_MINUTES);

    expect(plan.bucket).toBe('DAY');
    expect(plan.starts).toHaveLength(1);
  });
});

describe('区間ごとのメトリクス（computeMetricSeries）', () => {
  const environmental = getViewpointDefinition('environmentalAdaptability');
  const base = {
    definition: environmental,
    now: NOW,
    statusCodes: new Map(),
    expectedStreams: { robot: false, sensor: true },
    coverageSlotMinutes: 15,
    timeZoneOffsetMinutes: JST_OFFSET_MINUTES,
  };

  function temperature(value: number | null, hoursBefore: number, extra = {}) {
    return observation({
      equipmentId: SENSOR_ID,
      itemKey: 'temperatureCelsius',
      value,
      observedAt: new Date(NOW.getTime() - hoursBefore * HOUR_MS).toISOString(),
      ...extra,
    });
  }

  it('観測値を区間に振り分け、区間にデータがなければ欠損（null）。平均は値のある区間の平均', () => {
    const result = computeMetricSeries({
      ...base,
      horizon: 'SHORT',
      periodDays: null,
      observations: [temperature(10, 1), temperature(15, 0.75), temperature(40, 5)],
    });

    const metric = result.metrics.find((item) => item.metricId === 'temperatureCelsius');
    expect(result.bucket).toBe('HOUR');
    // 同じ区間（02:00Z〜03:00Z）の 10 と 15 は、短期の集計（状態値は最新）で 15
    expect(metric?.points.filter((point) => point.value !== null)).toEqual([
      { at: '2026-10-08T22:00:00.000Z', value: 40 },
      { at: '2026-10-09T02:00:00.000Z', value: 15 },
    ]);
    expect(metric?.average).toBe(27.5);
    expect(metric?.isPrimary).toBe(true);
    expect(result.from.toISOString()).toBe('2026-10-08T04:00:00.000Z');
  });

  it('長期（日ごと）の状態値は、区間内の平均', () => {
    const result = computeMetricSeries({
      ...base,
      horizon: 'LONG',
      periodDays: 7,
      observations: [temperature(10, 1), temperature(20, 2), temperature(30, 30)],
    });

    const metric = result.metrics.find((item) => item.metricId === 'temperatureCelsius');
    expect(metric?.points.at(-1)).toEqual({ at: '2026-10-08T15:00:00.000Z', value: 15 });
    expect(metric?.points.at(-2)).toEqual({ at: '2026-10-07T15:00:00.000Z', value: 30 });
  });

  it('期間の外（前・後）の観測値は使わない', () => {
    const result = computeMetricSeries({
      ...base,
      horizon: 'SHORT',
      periodDays: null,
      observations: [temperature(99, 30), temperature(98, -1)],
    });

    expect(
      result.metrics.every((metric) => metric.points.every((point) => point.value === null)),
    ).toBe(true);
    expect(result.metrics.every((metric) => metric.average === null)).toBe(true);
  });

  it('観測値が1件もなくても、区間の数だけ欠損の点を返す（0 で代用しない）', () => {
    const result = computeMetricSeries({
      ...base,
      horizon: 'LONG',
      periodDays: 30,
      observations: [],
    });

    expect(result.metrics).toHaveLength(environmental.detailMetrics.length);
    expect(result.metrics[0]?.points).toHaveLength(30);
    expect(result.metrics[0]?.points.every((point) => point.value === null)).toBe(true);
  });

  it('割合の指標は、区間に、分子・分母の両方がなければ欠損', () => {
    const result = computeMetricSeries({
      ...base,
      definition: getViewpointDefinition('harvestAccuracy'),
      expectedStreams: { robot: true, sensor: false },
      horizon: 'SHORT',
      periodDays: null,
      observations: [
        observation({
          itemKey: 'harvestCount',
          value: 100,
          observedAt: '2026-10-09T02:10:00.000Z',
        }),
        // 同じ区間（02:00Z）に、分子の項目がないため、可販果率は算出できない
        observation({ itemKey: 'harvestCount', value: 50, observedAt: '2026-10-09T01:10:00.000Z' }),
        observation({
          itemKey: 'damagedFruitCount',
          value: 1,
          observedAt: '2026-10-09T01:20:00.000Z',
        }),
        observation({
          itemKey: 'wrongHarvestCount',
          value: 1,
          observedAt: '2026-10-09T01:30:00.000Z',
        }),
      ],
    });

    const metric = result.metrics.find((item) => item.metricId === 'marketableFruitRatePercent');
    expect(metric?.points.filter((point) => point.value !== null)).toEqual([
      { at: '2026-10-09T01:00:00.000Z', value: 96 },
    ]);
  });
});

describe('観点の元データの項目（viewpointSourceItemKeys）', () => {
  it('観点の入力のうち、項目カタログにある項目を返す（環境適応性は、判定する環境の4項目）', () => {
    expect(viewpointSourceItemKeys(getViewpointDefinition('environmentalAdaptability'))).toEqual([
      'temperatureCelsius',
      'humidityPercent',
      'illuminanceLux',
      'co2Ppm',
    ]);
    expect(viewpointSourceItemKeys(getViewpointDefinition('harvestSpeed'))).toEqual([
      'harvestOperatingHours',
      'travelStoppedHours',
      'harvestCount',
      'statusCode',
    ]);
  });

  it('入力が集計値のみの観点（データ活用度合い）は、すべての観測値が対象（null）', () => {
    expect(viewpointSourceItemKeys(getViewpointDefinition('dataUtilization'))).toBeNull();
  });

  it('すべての観点の元データの項目は、項目カタログにある', () => {
    for (const definition of VIEWPOINT_DEFINITIONS) {
      const keys = viewpointSourceItemKeys(definition);
      if (keys !== null) {
        expect(keys.length).toBeGreaterThan(0);
        expect(keys.every((key) => findItemDefinition(key) !== undefined)).toBe(true);
      }
    }
  });
});
