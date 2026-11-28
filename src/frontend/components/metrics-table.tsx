/**
 * 観点の詳細: 根拠のメトリクス（FR-6.4）。ダッシュボードに出さないメトリクスを含む全メトリクスの値と、指標ごとの判定を、
 * 「現在」（短期の評価。水準の指標は直近値）と「期間の評価」（長期の評価。水準の指標は平均）の列で、別々に示す（短期を持つ観点だけ「現在」の列がある。#591）。
 * ステータスコードは、カテゴリ名ではなく、名称で示す（メンテナンス性。functional-specification.md 3.2）。
 */

import type { ReactNode } from 'react';
import { formatMetricValue } from '@smart-farm/shared/constants/metrics';
import type {
  MetricRow,
  StatusDetail,
  ViewpointDetailResponse,
} from '@smart-farm/shared/schemas/evaluation';
import { MESSAGES } from '../i18n/messages.ts';
import { currentTitle, periodTitle } from './diagnosis-section.tsx';
import { MetricLabel } from './metric-label.tsx';
import { StatusBadge } from './status-badge.tsx';

/** 値と判定（1 つの評価の結果）。 */
function ValueCell(props: {
  readonly testId: string;
  readonly value: string;
  readonly judgement: ReactNode;
}): ReactNode {
  return (
    <td data-testid={props.testId}>
      <span className="metric-cell-value numeric">{props.value}</span>
      <span className="metric-cell-judgement">{props.judgement}</span>
    </td>
  );
}

function Judgement(props: { readonly status: MetricRow['indicatorStatus'] }): ReactNode {
  return props.status === null ? (
    <span className="muted">{MESSAGES.viewpoint.noJudgement}</span>
  ) : (
    <StatusBadge status={props.status} />
  );
}

function StatusJudgement(props: { readonly statusDetail: StatusDetail | null }): ReactNode {
  return props.statusDetail === null ? (
    <span className="muted">{MESSAGES.viewpoint.noJudgement}</span>
  ) : (
    <StatusBadge status={props.statusDetail.category} />
  );
}

export function MetricsTable(props: { readonly detail: ViewpointDetailResponse }): ReactNode {
  const { detail } = props;
  const periodStatusDetail = detail.long?.statusDetail ?? null;
  const currentStatusDetail = detail.short?.statusDetail ?? null;
  // 「現在」の列は、短期の評価がある観点だけ
  const currentRows = detail.currentMetrics;
  return (
    <section className="panel" aria-labelledby="basis-heading" data-testid="basis">
      <h2 id="basis-heading">{MESSAGES.viewpoint.basis}</h2>
      <table className="data-table metrics-detail-table">
        <thead>
          <tr>
            <th scope="col">{MESSAGES.viewpoint.metric}</th>
            {currentRows === null ? null : <th scope="col">{currentTitle()}</th>}
            <th scope="col">{periodTitle(detail.periodDays)}</th>
          </tr>
        </thead>
        <tbody>
          {detail.metrics.map((row, index) => {
            const current = currentRows?.[index];
            return (
              <tr key={row.metricId} data-testid={`metric-${row.metricId}`}>
                <th scope="row">
                  <MetricLabel metricId={row.metricId} />
                  {row.isPrimary ? (
                    <span className="tag">{MESSAGES.viewpoint.primaryMark}</span>
                  ) : null}
                </th>
                {current === undefined ? null : (
                  <ValueCell
                    testId={`metric-current-${row.metricId}`}
                    value={formatMetricValue(current.metricId, current.value)}
                    judgement={<Judgement status={current.indicatorStatus} />}
                  />
                )}
                <ValueCell
                  testId={`metric-period-${row.metricId}`}
                  value={formatMetricValue(row.metricId, row.value)}
                  judgement={<Judgement status={row.indicatorStatus} />}
                />
              </tr>
            );
          })}
          {detail.usesStatusIndicator ? (
            <tr data-testid="metric-status">
              <th scope="row">{MESSAGES.viewpoint.statusRow}</th>
              {currentRows === null ? null : (
                <ValueCell
                  testId="metric-current-status"
                  value={currentStatusDetail?.name ?? MESSAGES.common.missingValue}
                  judgement={<StatusJudgement statusDetail={currentStatusDetail} />}
                />
              )}
              <ValueCell
                testId="metric-period-status"
                value={periodStatusDetail?.name ?? MESSAGES.common.missingValue}
                judgement={<StatusJudgement statusDetail={periodStatusDetail} />}
              />
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
