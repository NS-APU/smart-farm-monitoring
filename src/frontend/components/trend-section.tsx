/**
 * 観点の詳細: 推移（UC-03。FR-5.6、FR-6.5、FR-6.10）。メトリクスの時系列グラフ（指標ごとに開閉できる）と期間の平均値、値の表（折りたたみ）、
 * 観点のステータスの推移を示す。欄全体も、折りたたみ（既定は閉。SC-03-4）。
 * 視点（短期・長期）ごとの診断メッセージ・推奨アクションは、診断の欄（diagnosis-section.tsx）に、1 箇所だけ示す。
 */

import type { ReactNode } from 'react';
import { formatMetricValue, getMetricMeta } from '@smart-farm/shared/constants/metrics';
import { STATUS_LABELS, type EvaluationStatus } from '@smart-farm/shared/constants/status';
import { criterionBands, criterionStatusAt } from '@smart-farm/shared/criteria-text';
import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import type {
  SeriesMetric,
  SeriesResponse,
  ViewpointDetailResponse,
} from '@smart-farm/shared/schemas/evaluation';
import { MESSAGES } from '../i18n/messages.ts';
import { formatBucketLabel } from './bucket-label.ts';
import { CollapsiblePanel, type PanelOpenProps } from './collapsible-panel.tsx';
import { formatDateTimeJst } from './format.ts';
import { LineChart } from './line-chart.tsx';
import { StatusBadge } from './status-badge.tsx';

function MetricTrend(props: {
  readonly metric: SeriesMetric;
  readonly series: SeriesResponse;
  readonly detail: ViewpointDetailResponse;
}): ReactNode {
  const { metric, series, detail } = props;
  const meta = getMetricMeta(metric.metricId);
  const hasData = metric.points.some((point) => point.value !== null);
  const criterion = detail.criteria.criteria.find((item) => item.indicator === metric.metricId);
  const bands = criterion === undefined ? [] : criterionBands(criterion);
  return (
    <details
      className="trend-metric"
      open={metric.isPrimary}
      data-testid={`trend-${metric.metricId}`}
    >
      <summary>
        <span className="trend-title">{meta.label}</span>
        <span className="trend-average" data-testid={`trend-average-${metric.metricId}`}>
          {MESSAGES.viewpoint.trendAverage}: {formatMetricValue(metric.metricId, metric.average)}
        </span>
      </summary>
      {hasData ? (
        <>
          <LineChart
            title={meta.label}
            unit={meta.unit}
            points={metric.points}
            bucket={series.bucket}
            bands={bands}
            average={metric.average}
            formatValue={(value) => formatMetricValue(metric.metricId, value)}
          />
          {/* 値の表: 点をタップしなくても、全区間の値を読める（見える折りたたみ。スクリーンリーダーでも読める。SC-03-2） */}
          <details className="trend-values" data-testid={`trend-values-${metric.metricId}`}>
            <summary>{MESSAGES.viewpoint.trendValues}</summary>
            <div className="table-scroll">
              <table data-testid={`trend-table-${metric.metricId}`}>
                <caption>{MESSAGES.viewpoint.trendTableCaption(meta.label)}</caption>
                <thead>
                  <tr>
                    <th scope="col">{MESSAGES.viewpoint.trendTableTime}</th>
                    <th scope="col">
                      {meta.unit === '' ? meta.label : `${meta.label}（${meta.unit}）`}
                    </th>
                    <th scope="col">{MESSAGES.viewpoint.trendTableStatus}</th>
                  </tr>
                </thead>
                <tbody>
                  {metric.points.map((point) => {
                    const status =
                      point.value === null ? null : criterionStatusAt(bands, point.value);
                    return (
                      <tr key={point.at}>
                        <td>{formatBucketLabel(point.at, series.bucket)}</td>
                        <td>
                          {point.value === null
                            ? MESSAGES.common.missingValue
                            : formatMetricValue(metric.metricId, point.value)}
                        </td>
                        <td>
                          {point.value === null
                            ? MESSAGES.common.missingValue
                            : status === null
                              ? MESSAGES.viewpoint.noJudgement
                              : STATUS_LABELS[status]}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        <p className="muted trend-empty">{MESSAGES.viewpoint.trendNoData}</p>
      )}
    </details>
  );
}

interface Segment {
  readonly status: EvaluationStatus;
  readonly from: number;
  readonly to: number;
}

/** 期間の開始時点のステータスと、期間内の変化から、ステータスが続いた区間を作る。 */
function buildSegments(
  history: SeriesResponse['statusHistory'],
  from: string,
  to: string,
): Segment[] {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const points: { status: EvaluationStatus; at: number }[] = [
    ...(history.initial === null ? [] : [{ status: history.initial, at: fromMs }]),
    ...history.changes.map((change) => ({
      status: change.status,
      at: Date.parse(change.changedAt),
    })),
  ];
  return points.map((point, index) => ({
    status: point.status,
    from: point.at,
    to: points[index + 1]?.at ?? toMs,
  }));
}

function StatusHistory(props: { readonly series: SeriesResponse }): ReactNode {
  const { series } = props;
  const { statusHistory } = series;
  const segments = buildSegments(statusHistory, series.from, series.to);
  // 区間の長さ（短すぎる区間も、最小の幅を持つ）の比率で、帯の全幅を分ける。
  // 期間の開始時点のステータスがなく、変化が期間の終わり近くだけの場合も、帯が縮まない（flex-grow の合計が 1 未満だと、残りの幅が余る）
  const weighted = segments.map((segment) => ({
    segment,
    weight: Math.max(segment.to - segment.from, MS_PER_MINUTE),
  }));
  const totalMs = weighted.reduce((sum, item) => sum + item.weight, 0);
  return (
    <div className="status-history" data-testid="status-history">
      <h3>{MESSAGES.viewpoint.statusHistory}</h3>
      <p className="muted" data-testid="status-history-note">
        {MESSAGES.viewpoint.statusHistoryNote}
      </p>
      {segments.length === 0 ? (
        <p className="muted">{MESSAGES.viewpoint.statusHistoryNone}</p>
      ) : (
        <>
          <div className="status-timeline" role="img" aria-label={MESSAGES.viewpoint.statusHistory}>
            {weighted.map(({ segment, weight }) => (
              <span
                key={segment.from}
                className={`status-segment status-${segment.status.toLowerCase()}`}
                style={{ flexGrow: weight / totalMs }}
                title={STATUS_LABELS[segment.status]}
              >
                <span className="status-segment-label">{STATUS_LABELS[segment.status]}</span>
              </span>
            ))}
          </div>
          {/* 帯の両端の日時（帯は、期間の開始から終了まで） */}
          <div className="status-timeline-range">
            <time dateTime={series.from} data-testid="status-timeline-from">
              {formatDateTimeJst(series.from)}
            </time>
            <time dateTime={series.to} data-testid="status-timeline-to">
              {formatDateTimeJst(series.to)}
            </time>
          </div>
          <ol className="status-changes">
            {statusHistory.initial === null ? null : (
              <li>
                <span>{MESSAGES.viewpoint.statusHistoryInitial}</span>
                <StatusBadge status={statusHistory.initial} />
              </li>
            )}
            {statusHistory.changes.map((change) => (
              <li key={change.changedAt}>
                <time dateTime={change.changedAt}>{formatDateTimeJst(change.changedAt)}</time>
                <StatusBadge status={change.status} />
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

export function TrendSection(
  props: PanelOpenProps & {
    readonly series: SeriesResponse;
    readonly detail: ViewpointDetailResponse;
  },
): ReactNode {
  const { series, detail } = props;
  return (
    <CollapsiblePanel
      testId="trend"
      headingId="trend-heading"
      title={MESSAGES.viewpoint.trend}
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      <p className="muted">
        {MESSAGES.viewpoint.trendPeriod}: {formatDateTimeJst(series.from)} 〜{' '}
        {formatDateTimeJst(series.to)}（
        {series.bucket === 'HOUR' ? MESSAGES.viewpoint.trendHourly : MESSAGES.viewpoint.trendDaily}
        ）
      </p>
      <p className="muted">{MESSAGES.viewpoint.chartLegend}</p>
      <p className="muted" data-testid="chart-band-note">
        {MESSAGES.viewpoint.chartBandNote}
      </p>
      <div className="trend-list">
        {series.metrics.map((metric) => (
          <MetricTrend key={metric.metricId} metric={metric} series={series} detail={detail} />
        ))}
      </div>
      <StatusHistory series={series} />
    </CollapsiblePanel>
  );
}
