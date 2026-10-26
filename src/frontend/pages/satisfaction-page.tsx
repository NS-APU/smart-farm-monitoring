/**
 * SC-04 満足度の詳細（UC-21。FR-6.9）。総合満足度（9観点の平均。小数第1位）と、各観点の満足度（1〜5スター）を
 * レーダーチャートで示す。9観点のいずれかが未入力の場合は「不明」とし、データ入力への導線を示す。
 */

import { useCallback, type ReactNode } from 'react';
import { SATISFACTION_MAX_STARS } from '@smart-farm/shared/constants/items';
import {
  OVERALL_SATISFACTION_METRIC_ID,
  formatMetricValue,
} from '@smart-farm/shared/constants/metrics';
import { describeCriterionRows } from '@smart-farm/shared/criteria-text';
import type { ViewpointDetailResponse } from '@smart-farm/shared/schemas/evaluation';
import { ApiError } from '../api/client.ts';
import { getViewpointDetail } from '../api/endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import { HorizonControls } from '../components/horizon-controls.tsx';
import { Icon, ViewpointIcon } from '../components/icon.tsx';
import { RadarChart } from '../components/radar-chart.tsx';
import { ErrorView, LoadingView } from '../components/state-views.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { useHorizonSelection } from '../hooks/use-horizon-selection.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';

function Stars(props: { readonly score: number | null }): ReactNode {
  if (props.score === null) {
    return <span className="muted">{MESSAGES.satisfaction.notEntered}</span>;
  }
  // 期間内に複数回入力された場合は、平均（小数）になる。スターは、四捨五入した数で示し、平均の値を添える
  const filled = Math.min(SATISFACTION_MAX_STARS, Math.max(0, Math.round(props.score)));
  return (
    <span
      className="stars"
      role="img"
      aria-label={`${String(props.score)} / ${String(SATISFACTION_MAX_STARS)}`}
    >
      {'★'.repeat(filled)}
      {'☆'.repeat(SATISFACTION_MAX_STARS - filled)}
      {Number.isInteger(props.score) ? null : (
        <span className="stars-value muted">（{props.score.toFixed(1)}）</span>
      )}
    </span>
  );
}

function SatisfactionContent(props: { readonly detail: ViewpointDetailResponse }): ReactNode {
  const { detail } = props;
  const overall =
    detail.metrics.find((row) => row.metricId === OVERALL_SATISFACTION_METRIC_ID)?.value ?? null;
  const axes = detail.radar ?? [];
  const missing = axes.filter((axis) => axis.score === null);
  const criterion = detail.criteria.criteria.find(
    (item) => item.indicator === OVERALL_SATISFACTION_METRIC_ID,
  );

  return (
    <>
      <section className="panel" aria-labelledby="overall-heading" data-testid="overall">
        <h2 id="overall-heading">{MESSAGES.satisfaction.overall}</h2>
        <div className="overall">
          <p className="overall-score" data-testid="overall-score">
            {formatMetricValue(OVERALL_SATISFACTION_METRIC_ID, overall)}
          </p>
          <StatusBadge status={detail.status} />
          <p className="muted">{MESSAGES.satisfaction.overallNote}</p>
        </div>
        {criterion === undefined ? null : (
          <ul className="criteria-inline" aria-label={MESSAGES.satisfaction.criteria}>
            {describeCriterionRows(criterion, { fractionDigits: 1 }).map((row) => (
              <li key={row.status}>
                <StatusBadge status={row.status} />
                <span>{row.condition}</span>
              </li>
            ))}
          </ul>
        )}
        {detail.selected === null ? (
          <p className="state-view" role="status">
            {MESSAGES.viewpoint.notEvaluated}
          </p>
        ) : null}
        {missing.length > 0 ? (
          <div className="notice notice-warning" role="status" data-testid="satisfaction-missing">
            <Icon name="status-caution" size={18} />
            <p>
              <strong>{MESSAGES.satisfaction.missingTitle}</strong>:{' '}
              {missing.map((axis) => axis.name).join('、')}
            </p>
            <p>{MESSAGES.satisfaction.missingLead}</p>
            <p className="notice-links">
              <Link to={PATHS.dataEntry}>{MESSAGES.satisfaction.goDataEntry}</Link>
            </p>
          </div>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="radar-heading" data-testid="radar">
        <h2 id="radar-heading">{MESSAGES.satisfaction.radar}</h2>
        <div className="radar-layout">
          <RadarChart axes={axes} max={SATISFACTION_MAX_STARS} />
          <table className="data-table score-table">
            <caption>
              {MESSAGES.satisfaction.scores}（{MESSAGES.satisfaction.scale}）
            </caption>
            <thead>
              <tr>
                <th scope="col">{MESSAGES.viewpoint.metric}</th>
                <th scope="col">{MESSAGES.viewpoint.value}</th>
              </tr>
            </thead>
            <tbody>
              {axes.map((axis) => (
                <tr key={axis.viewpointId} data-testid={`score-${axis.viewpointId}`}>
                  <th scope="row">{axis.name}</th>
                  <td>
                    <Stars score={axis.score} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export function SatisfactionPage(): ReactNode {
  const { api } = useAuth();
  const { selectedEquipmentId, equipmentNames, equipmentError } = useAppState();
  const { periodDays, setPeriodDays } = useHorizonSelection();

  const fetchDetail = useCallback(async () => {
    if (selectedEquipmentId === undefined) {
      return undefined;
    }
    return getViewpointDetail(api, {
      viewpointId: 'satisfaction',
      equipmentId: selectedEquipmentId,
      horizon: 'LONG',
      periodDays,
    });
  }, [api, selectedEquipmentId, periodDays]);
  const { data, error, reload } = usePolling(fetchDetail);

  const equipmentName =
    selectedEquipmentId === undefined ? undefined : equipmentNames.get(selectedEquipmentId);

  let content: ReactNode;
  if (equipmentError !== undefined) {
    content = <ErrorView error={equipmentError} />;
  } else if (error instanceof ApiError && error.code === 'NOT_FOUND') {
    content = (
      <div role="alert" className="state-view state-error" data-testid="not-applicable">
        <Icon name="status-error" size={20} />
        <p>{error.message}</p>
        <p>{MESSAGES.viewpoint.notApplicable}</p>
      </div>
    );
  } else if (error !== undefined) {
    content = <ErrorView error={error} onRetry={reload} />;
  } else if (data === undefined) {
    content = <LoadingView />;
  } else {
    content = <SatisfactionContent detail={data} />;
  }

  return (
    <div className="satisfaction">
      <div className="page-head">
        <h1>
          <ViewpointIcon viewpointId="satisfaction" size={22} />
          {MESSAGES.satisfaction.title}
          {data === undefined ? null : <StatusBadge status={data.status} />}
        </h1>
        <p className="page-meta">
          {MESSAGES.dashboard.target}: <strong>{equipmentName}</strong>
        </p>
      </div>
      <HorizonControls horizon="LONG" periodDays={periodDays} onPeriodChange={setPeriodDays} />
      {content}
    </div>
  );
}
