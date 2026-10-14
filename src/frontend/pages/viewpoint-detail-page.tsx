/**
 * SC-03 観点の詳細（UC-02・UC-03・UC-04。FR-5、FR-6.4、6.5、6.10）。
 * 診断結果（ステータス・診断メッセージ・推奨アクション・判定の対象期間）、根拠のメトリクス、判断基準、推移、元データを示す。
 * 視点（短期・長期）と期間は URL のクエリで保持する。満足度は、専用の詳細（SC-04）へ移る。
 */

import { useCallback, useEffect, type ReactNode } from 'react';
import { findViewpointMeta } from '@smart-farm/shared/constants/viewpoints';
import { ApiError } from '../api/client.ts';
import { getViewpointDetail, getViewpointSeries } from '../api/endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import { CriteriaTable } from '../components/criteria-table.tsx';
import { DiagnosisSection } from '../components/diagnosis-section.tsx';
import { HorizonControls, horizonQueryString } from '../components/horizon-controls.tsx';
import { MetricsTable } from '../components/metrics-table.tsx';
import { SourceDataSection } from '../components/source-data-section.tsx';
import { ErrorView, LoadingView } from '../components/state-views.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { TrendSection } from '../components/trend-section.tsx';
import { useHorizonSelection } from '../hooks/use-horizon-selection.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link, navigate } from '../router/router.tsx';

/** 満足度の詳細（SC-04）へ移る。 */
function RedirectToSatisfaction(): ReactNode {
  useEffect(() => {
    navigate(PATHS.satisfaction, { replace: true });
  }, []);
  return null;
}

export function ViewpointDetailPage(props: { readonly viewpointId: string }): ReactNode {
  if (props.viewpointId === 'satisfaction') {
    return <RedirectToSatisfaction />;
  }
  return <ViewpointDetailContent viewpointId={props.viewpointId} />;
}

function ViewpointDetailContent(props: { readonly viewpointId: string }): ReactNode {
  const { viewpointId } = props;
  const { api } = useAuth();
  const { selectedEquipmentId, equipmentNames, equipmentError } = useAppState();
  const { horizon, periodDays, setHorizon, setPeriodDays } = useHorizonSelection();

  const fetchDetail = useCallback(async () => {
    if (selectedEquipmentId === undefined) {
      return undefined;
    }
    return getViewpointDetail(api, {
      viewpointId,
      equipmentId: selectedEquipmentId,
      horizon,
      periodDays,
    });
  }, [api, viewpointId, selectedEquipmentId, horizon, periodDays]);
  const detail = usePolling(fetchDetail);

  const fetchSeries = useCallback(async () => {
    if (selectedEquipmentId === undefined) {
      return undefined;
    }
    return getViewpointSeries(api, {
      viewpointId,
      equipmentId: selectedEquipmentId,
      horizon,
      periodDays,
    });
  }, [api, viewpointId, selectedEquipmentId, horizon, periodDays]);
  const series = usePolling(fetchSeries);

  const backPath = `/?${horizonQueryString(horizon, periodDays)}`;
  const equipmentName =
    selectedEquipmentId === undefined ? undefined : equipmentNames.get(selectedEquipmentId);

  let content: ReactNode;
  if (equipmentError !== undefined) {
    content = <ErrorView error={equipmentError} />;
  } else if (detail.error instanceof ApiError && detail.error.code === 'NOT_FOUND') {
    // 選んだ設備では評価しない観点（例: センサーでは環境適応性のみ）
    content = (
      <div role="alert" className="state-view state-error" data-testid="not-applicable">
        <p>{detail.error.message}</p>
        <p>{MESSAGES.viewpoint.notApplicable}</p>
      </div>
    );
  } else if (detail.error !== undefined) {
    content = <ErrorView error={detail.error} onRetry={detail.reload} />;
  } else if (detail.data === undefined) {
    content = <LoadingView />;
  } else {
    const loaded = detail.data;
    content = (
      <>
        <DiagnosisSection detail={loaded} />
        <MetricsTable detail={loaded} />
        <CriteriaTable detail={loaded} />
        {series.data === undefined ? (
          <section className="panel">
            {series.error === undefined ? (
              <LoadingView />
            ) : (
              <ErrorView error={series.error} onRetry={series.reload} />
            )}
          </section>
        ) : (
          <TrendSection series={series.data} detail={loaded} />
        )}
        <SourceDataSection
          equipmentId={loaded.equipmentId}
          viewpointId={loaded.viewpointId}
          period={
            loaded.selected === null
              ? null
              : { from: loaded.selected.evaluatedFrom, to: loaded.selected.evaluatedTo }
          }
        />
      </>
    );
  }

  // 選んだ設備で評価しない観点（NOT_FOUND）は、観点の名称を見出しにする（どの観点を開いたか分かるように。V-173）。
  // 読み込み中は、従来どおり
  const isNotApplicable = detail.error instanceof ApiError && detail.error.code === 'NOT_FOUND';
  const heading =
    detail.data?.name ??
    (isNotApplicable ? findViewpointMeta(viewpointId)?.name : undefined) ??
    MESSAGES.nav.dashboard;
  return (
    <div className="viewpoint-detail">
      <nav aria-label={MESSAGES.viewpoint.breadcrumb} className="breadcrumb">
        <ol>
          <li>
            <Link to={backPath}>{MESSAGES.viewpoint.backToDashboard}</Link>
          </li>
          <li aria-current="page">{heading}</li>
        </ol>
      </nav>
      <div className="page-head">
        <h1>
          {heading}
          {detail.data === undefined ? null : <StatusBadge status={detail.data.status} />}
        </h1>
        <p className="page-meta">
          {MESSAGES.dashboard.target}: <strong>{equipmentName}</strong>
        </p>
      </div>
      <HorizonControls
        horizon={horizon}
        periodDays={periodDays}
        onHorizonChange={setHorizon}
        onPeriodChange={setPeriodDays}
      />
      {content}
    </div>
  );
}
