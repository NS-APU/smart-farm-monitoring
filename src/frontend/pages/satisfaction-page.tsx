/**
 * SC-04 満足度の詳細（UC-21。FR-6.9）。総合満足度（9観点の平均。小数第1位）と、各観点の満足度（1〜5スター）を
 * レーダーチャートで示す。9観点のいずれかが未入力の場合は「不明」とし、データ入力への導線を示す。
 * 案内の文言は、実態に合わせて 2 つ: 期間内に入力が 1 件もない場合と、一部の観点だけの以前の入力が残っている場合（Issue #160）。
 */

import { useCallback, type ReactNode } from 'react';
import { SATISFACTION_MAX_STARS } from '@smart-farm/shared/constants/items';
import { SATISFACTION_DEFAULT_PERIOD_DAYS } from '@smart-farm/shared/constants/viewpoints';
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
import { EquipmentSelect } from '../components/equipment-select.tsx';
import { HorizonControls } from '../components/horizon-controls.tsx';
import { Icon, ViewpointIcon } from '../components/icon.tsx';
import { NotApplicableNotice } from '../components/not-applicable-notice.tsx';
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
  // 9観点すべてが未入力: 期間内に、入力が 1 件もない。一部だけ未入力: 一部の観点だけの以前の入力が、最新の入力として残っている
  const noInput = missing.length === axes.length;
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
        {/* 総合満足度の判断基準（注意下限・異常下限）は、判断基準の編集（SC-13）で、他の観点と同じ部品で編集する（Issue #359） */}
        <p className="criteria-edit-row">
          <span
            className={`tag ${detail.criteria.isDefault ? '' : 'tag-changed'}`}
            data-testid="criteria-state"
          >
            {detail.criteria.isDefault
              ? MESSAGES.viewpoint.criteriaDefault
              : MESSAGES.viewpoint.criteriaChanged}
          </span>
          <Link className="panel-link" to={PATHS.criteria(detail.viewpointId)}>
            {MESSAGES.viewpoint.editCriteria}
          </Link>
        </p>
        {detail.selected === null ? (
          <p className="state-view" role="status">
            {MESSAGES.viewpoint.notEvaluated}
          </p>
        ) : null}
        {missing.length > 0 ? (
          <div className="notice notice-warning" role="status" data-testid="satisfaction-missing">
            <Icon name="status-caution" size={18} />
            {noInput ? (
              <p>
                <strong>{MESSAGES.satisfaction.noInputTitle}</strong>
              </p>
            ) : (
              <p>
                <strong>{MESSAGES.satisfaction.missingTitle}</strong>:{' '}
                {missing.map((axis) => axis.name).join('、')}
              </p>
            )}
            <p>{noInput ? MESSAGES.satisfaction.noInputLead : MESSAGES.satisfaction.missingLead}</p>
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
  return <SatisfactionView />;
}

/**
 * 満足度の詳細の本体。全画面のページ（`/satisfaction`）と、ダッシュボードの右からのドロワー（`variant="drawer"`。Issue #357）の両方で使う。
 * ドロワーでは、見出しは h2（ページの h1 は、ダッシュボード）。
 */
export function SatisfactionView(props: { readonly variant?: 'page' | 'drawer' }): ReactNode {
  const Heading = props.variant === 'drawer' ? 'h2' : 'h1';
  const { api } = useAuth();
  const { selectedEquipmentId, equipmentError } = useAppState();
  // 期間を選んでいなければ、満足度の既定の期間（30 日）。選べば、他の観点と同じ長期の期間
  const { periodDays, setPeriodDays } = useHorizonSelection(SATISFACTION_DEFAULT_PERIOD_DAYS);

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

  let content: ReactNode;
  if (equipmentError !== undefined) {
    content = <ErrorView error={equipmentError} />;
  } else if (error instanceof ApiError && error.code === 'NOT_FOUND') {
    content = <NotApplicableNotice message={error.message} viewpointId="satisfaction" />;
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
        <Heading>
          <ViewpointIcon viewpointId="satisfaction" size={22} />
          {MESSAGES.satisfaction.title}
          {data === undefined ? null : <StatusBadge status={data.status} />}
        </Heading>
      </div>
      {/* 対象の設備（ハウス・ロボット・センサー）の選択。以前は、ヘッダーにあった（Issue #355） */}
      <div className="page-controls">
        <EquipmentSelect label={MESSAGES.layout.equipment} />
        <HorizonControls horizon="LONG" periodDays={periodDays} onPeriodChange={setPeriodDays} />
      </div>
      {content}
    </div>
  );
}
