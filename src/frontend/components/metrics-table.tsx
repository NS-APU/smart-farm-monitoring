/**
 * 観点の詳細: 根拠のメトリクス（FR-6.4）。ダッシュボードに出さないメトリクスを含む全メトリクスの値と、指標ごとの判定を示す。
 * ステータスコードは、カテゴリ名ではなく、名称で示す（メンテナンス性。functional-specification.md 3.2）。
 */

import type { ReactNode } from 'react';
import { formatMetricValue, getMetricMeta } from '@smart-farm/shared/constants/metrics';
import type { ViewpointDetailResponse } from '@smart-farm/shared/schemas/evaluation';
import { MESSAGES } from '../i18n/messages.ts';
import { StatusBadge } from './status-badge.tsx';

export function MetricsTable(props: { readonly detail: ViewpointDetailResponse }): ReactNode {
  const { detail } = props;
  const statusDetail = detail.selected?.statusDetail ?? null;
  return (
    <section className="panel" aria-labelledby="basis-heading" data-testid="basis">
      <h2 id="basis-heading">{MESSAGES.viewpoint.basis}</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{MESSAGES.viewpoint.metric}</th>
            <th scope="col" className="numeric">
              {MESSAGES.viewpoint.value}
            </th>
            <th scope="col">{MESSAGES.viewpoint.judgement}</th>
          </tr>
        </thead>
        <tbody>
          {detail.metrics.map((row) => (
            <tr key={row.metricId} data-testid={`metric-${row.metricId}`}>
              <th scope="row">
                {getMetricMeta(row.metricId).label}
                {row.isPrimary ? (
                  <span className="tag">{MESSAGES.viewpoint.primaryMark}</span>
                ) : null}
              </th>
              <td className="numeric">{formatMetricValue(row.metricId, row.value)}</td>
              <td>
                {row.indicatorStatus === null ? (
                  <span className="muted">{MESSAGES.viewpoint.noJudgement}</span>
                ) : (
                  <StatusBadge status={row.indicatorStatus} />
                )}
              </td>
            </tr>
          ))}
          {detail.usesStatusIndicator ? (
            <tr data-testid="metric-status">
              <th scope="row">{MESSAGES.viewpoint.statusRow}</th>
              <td className="numeric">{statusDetail?.name ?? MESSAGES.common.missingValue}</td>
              <td>
                {statusDetail === null ? (
                  <span className="muted">{MESSAGES.viewpoint.noJudgement}</span>
                ) : (
                  <StatusBadge status={statusDetail.category} />
                )}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
