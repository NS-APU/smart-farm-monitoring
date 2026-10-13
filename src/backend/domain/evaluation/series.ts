/**
 * メトリクスの推移（時系列。FR-6.5、UC-03）の算出（純粋関数）。
 * 期間を区間（バケット）に区切り、区間ごとに、評価と同じ集計・算出式でメトリクスを求める。
 * - 短期視点・当日: 直近24時間の1時間ごと（短期の集計＝状態値は最新）。直近7日以上: 日本時間の日ごと（長期の集計）
 * - 区間にデータがない・算出できないメトリクスは、欠損（null）。0 で代用しない
 * - 期間の平均値は、値がある区間の平均（暫定。dev_spec.md 4章）
 */

import type { Horizon, PeriodDays } from '@smart-farm/shared/constants/status';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import type { SeriesMetric } from '@smart-farm/shared/schemas/evaluation';
import type { StatusCodeDefinition } from '@smart-farm/shared/schemas/status-code';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '@smart-farm/shared/time';
import type { ViewpointDefinition } from './definition.ts';
import { aggregateMeasures, type ExpectedStreams } from './measures.ts';
import { normalizeMetric } from './numbers.ts';

/** 短期・当日の推移の区間の数（24時間）。 */
const HOURLY_BUCKET_COUNT = 24;

export type SeriesBucket = 'HOUR' | 'DAY';

export interface BucketPlan {
  readonly bucket: SeriesBucket;
  /** 各区間の開始（古い順）。最後の区間は、評価時刻を含む区間（途中まで）。 */
  readonly starts: readonly Date[];
}

/** 視点・期間に応じた区間を決める。 */
export function planBuckets(
  now: Date,
  horizon: Horizon,
  periodDays: PeriodDays | null,
  timeZoneOffsetMinutes: number,
): BucketPlan {
  const nowMs = now.getTime();
  if (horizon === 'SHORT' || periodDays === 1) {
    const currentStart = Math.floor(nowMs / MS_PER_HOUR) * MS_PER_HOUR;
    return {
      bucket: 'HOUR',
      starts: Array.from(
        { length: HOURLY_BUCKET_COUNT },
        (_, index) => new Date(currentStart - (HOURLY_BUCKET_COUNT - 1 - index) * MS_PER_HOUR),
      ),
    };
  }
  const days = periodDays ?? 1;
  const offsetMs = timeZoneOffsetMinutes * MS_PER_MINUTE;
  const todayStart = Math.floor((nowMs + offsetMs) / MS_PER_DAY) * MS_PER_DAY - offsetMs;
  return {
    bucket: 'DAY',
    starts: Array.from(
      { length: days },
      (_, index) => new Date(todayStart - (days - 1 - index) * MS_PER_DAY),
    ),
  };
}

export interface SeriesInput {
  readonly definition: ViewpointDefinition;
  /** 評価の単位の観測値（区間の全体を含む）。 */
  readonly observations: readonly Observation[];
  readonly now: Date;
  readonly horizon: Horizon;
  readonly periodDays: PeriodDays | null;
  readonly statusCodes: ReadonlyMap<string, StatusCodeDefinition>;
  readonly expectedStreams: ExpectedStreams;
  readonly coverageSlotMinutes: number;
  readonly timeZoneOffsetMinutes: number;
}

export interface SeriesResult {
  readonly bucket: SeriesBucket;
  /** 推移の期間の開始（最初の区間の開始）。終了は評価時刻。 */
  readonly from: Date;
  readonly metrics: SeriesMetric[];
}

function averageOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) {
    return null;
  }
  return normalizeMetric(present.reduce((sum, value) => sum + value, 0) / present.length);
}

export function computeMetricSeries(input: SeriesInput): SeriesResult {
  const { definition, now } = input;
  const plan = planBuckets(now, input.horizon, input.periodDays, input.timeZoneOffsetMinutes);
  const unitMs = plan.bucket === 'HOUR' ? MS_PER_HOUR : MS_PER_DAY;
  const firstStartMs = plan.starts[0]?.getTime() ?? now.getTime();

  // 観測値を、区間ごとに振り分ける（区間ごとに全件を走査しない）
  const groups: Observation[][] = plan.starts.map(() => []);
  for (const observation of input.observations) {
    const index = Math.floor((Date.parse(observation.observedAt) - firstStartMs) / unitMs);
    groups[index]?.push(observation);
  }

  const metricValues = plan.starts.map((start, index) => {
    const isLast = index === plan.starts.length - 1;
    const to = isLast ? now : new Date(start.getTime() + unitMs - 1);
    const measures = aggregateMeasures({
      observations: groups[index] ?? [],
      horizon: input.horizon,
      from: start,
      to,
      // 区間の終了より後に受信した値（遅延）も、現在までに受信済みなら、その区間の値として使う
      knownAt: now,
      statusCodes: input.statusCodes,
      expectedStreams: input.expectedStreams,
      coverageSlotMinutes: input.coverageSlotMinutes,
    });
    return definition.computeMetrics(measures.values);
  });

  const metrics = definition.detailMetrics.map((metricId): SeriesMetric => {
    const values = metricValues.map((computed) => computed[metricId] ?? null);
    return {
      metricId,
      isPrimary: definition.dashboardMetrics.includes(metricId),
      points: plan.starts.map((start, index) => ({
        at: start.toISOString(),
        value: values[index] ?? null,
      })),
      average: averageOf(values),
    };
  });
  return { bucket: plan.bucket, from: new Date(firstStartMs), metrics };
}
