/**
 * 観点の詳細: 推移（UC-03。FR-5.6、FR-6.5、FR-6.10）。メトリクスの時系列グラフ（指標ごとに開閉できる）と期間の平均値、
 * 観点のステータスの推移、視点（短期・長期）ごとのフィードバックを示す。
 * 短期評価を持たない観点では、短期のフィードバックは示さない。
 */

import type { ReactNode } from 'react';
import { formatMetricValue, getMetricMeta } from '@smart-farm/shared/constants/metrics';
import { STATUS_LABELS, type EvaluationStatus } from '@smart-farm/shared/constants/status';
import { criterionBands } from '@smart-farm/shared/criteria-text';
import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import type {
  HorizonDiagnosis,
  SeriesMetric,
  SeriesResponse,
  ViewpointDetailResponse,
} from '@smart-farm/shared/schemas/evaluation';
import { MESSAGES } from '../i18n/messages.ts';
import { formatBucketLabel } from './bucket-label.ts';
import { horizonLabel } from './diagnosis-section.tsx';
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
            bands={criterion === undefined ? [] : criterionBands(criterion)}
            average={metric.average}
            formatValue={(value) => formatMetricValue(metric.metricId, value)}
          />
          {/* 点の値は、マウスの操作でしか得られないため、同じ内容を、表として提供する（見えない文字。V-153） */}
          {/* 表（table）は、overflow・clip で内容を切れないため、見えない枠（div）に入れる。表の行が、ページの下に、余計な空白を作らない */}
          <div className="visually-hidden">
            <table data-testid={`trend-table-${metric.metricId}`}>
              <caption>{MESSAGES.viewpoint.trendTableCaption(meta.label)}</caption>
              <thead>
                <tr>
                  <th scope="col">{MESSAGES.viewpoint.trendTableTime}</th>
                  <th scope="col">
                    {meta.unit === '' ? meta.label : `${meta.label}（${meta.unit}）`}
                  </th>
                </tr>
              </thead>
              <tbody>
                {metric.points.map((point) => (
                  <tr key={point.at}>
                    <td>{formatBucketLabel(point.at, series.bucket)}</td>
                    <td>
                      {point.value === null
                        ? MESSAGES.common.missingValue
                        : formatMetricValue(metric.metricId, point.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

function FeedbackCard(props: {
  readonly testId: string;
  readonly title: string;
  readonly diagnosis: HorizonDiagnosis | null;
  readonly emptyText: string;
}): ReactNode {
  const { diagnosis } = props;
  return (
    <div className="feedback-card" data-testid={props.testId}>
      <h4>{props.title}</h4>
      {diagnosis === null ? (
        <p className="muted">{props.emptyText}</p>
      ) : (
        <>
          <StatusBadge status={diagnosis.status} />
          <p>{diagnosis.diagnosticMessage}</p>
          <p>
            <strong>{MESSAGES.viewpoint.recommendedAction}: </strong>
            {diagnosis.recommendedAction}
          </p>
        </>
      )}
    </div>
  );
}

export function TrendSection(props: {
  readonly series: SeriesResponse;
  readonly detail: ViewpointDetailResponse;
}): ReactNode {
  const { series, detail } = props;
  return (
    <section className="panel" aria-labelledby="trend-heading" data-testid="trend">
      <h2 id="trend-heading">{MESSAGES.viewpoint.trend}</h2>
      <p className="muted">
        {MESSAGES.viewpoint.trendPeriod}: {formatDateTimeJst(series.from)} 〜{' '}
        {formatDateTimeJst(series.to)}（
        {series.bucket === 'HOUR' ? MESSAGES.viewpoint.trendHourly : MESSAGES.viewpoint.trendDaily}
        ）
      </p>
      {series.horizon === series.horizonUsed ? null : (
        <p className="muted">{MESSAGES.viewpoint.horizonUsedLong}</p>
      )}
      <p className="muted">{MESSAGES.viewpoint.chartLegend}</p>
      <div className="trend-list">
        {series.metrics.map((metric) => (
          <MetricTrend key={metric.metricId} metric={metric} series={series} detail={detail} />
        ))}
      </div>
      <StatusHistory series={series} />
      <h3>{MESSAGES.viewpoint.feedback}</h3>
      {series.hasShortHorizon ? null : (
        <p className="muted" data-testid="no-short-note">
          {MESSAGES.viewpoint.noShort}
        </p>
      )}
      <div className="feedback-cards">
        {series.hasShortHorizon ? (
          <FeedbackCard
            testId="feedback-short"
            title={horizonLabel('SHORT', null)}
            diagnosis={series.feedback.short}
            emptyText={MESSAGES.viewpoint.notEvaluated}
          />
        ) : null}
        <FeedbackCard
          testId="feedback-long"
          title={horizonLabel('LONG', detail.periodDays)}
          diagnosis={series.feedback.long}
          emptyText={MESSAGES.viewpoint.notEvaluated}
        />
      </div>
    </section>
  );
}
