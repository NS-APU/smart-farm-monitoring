/**
 * SC-02 ダッシュボード（UC-01、UC-04。FR-6.1〜6.3、6.6、6.7）。
 * ステータスごとの件数、観点のカード（ステータス・主要メトリクスと判定・診断メッセージ・推奨アクション・判定の対象期間）、
 * 最終のデータ取得日時を表示し、約10秒間隔で最新の評価結果を読み直す（タブの表示中のみ）。
 * 視点（短期・長期）と期間は、URL のクエリで保持する。カードを選ぶと、観点の詳細（SC-03。満足度は SC-04）へ移る。
 */

import { useCallback, useEffect, type ReactNode } from 'react';
import { formatMetricValue, getMetricMeta } from '@smart-farm/shared/constants/metrics';
import {
  EVALUATION_STATUSES,
  STATUS_LABELS,
  type EvaluationStatus,
  type Horizon,
  type PeriodDays,
} from '@smart-farm/shared/constants/status';
import type { DashboardResponse, ViewpointCard } from '@smart-farm/shared/schemas/evaluation';
import { getDashboard } from '../api/endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import { formatDateTimeJst } from '../components/format.ts';
import { HorizonControls, horizonQueryString } from '../components/horizon-controls.tsx';
import { Icon, STATUS_ICON, ViewpointIcon } from '../components/icon.tsx';
import { ErrorView, LoadingView } from '../components/state-views.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { usePolling } from '../hooks/use-polling.ts';
import { useHorizonSelection } from '../hooks/use-horizon-selection.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';

/** 観点の詳細へのパス。満足度は、専用の詳細（SC-04）へ。 */
export function viewpointPath(
  viewpointId: string,
  horizon: Horizon,
  periodDays: PeriodDays,
): string {
  return viewpointId === 'satisfaction'
    ? `${PATHS.satisfaction}?${new URLSearchParams({ periodDays: String(periodDays) }).toString()}`
    : `${PATHS.viewpoint(viewpointId)}?${horizonQueryString(horizon, periodDays)}`;
}

function MetricMark(props: { readonly status: EvaluationStatus | undefined }): ReactNode {
  if (props.status === undefined) {
    return null;
  }
  return (
    <span className="metric-mark" title={STATUS_LABELS[props.status]}>
      <Icon name={STATUS_ICON[props.status]} size={15} />
      <span className="visually-hidden">{STATUS_LABELS[props.status]}</span>
    </span>
  );
}

function ViewpointCardView(props: {
  readonly card: ViewpointCard;
  readonly horizon: Horizon;
  readonly periodDays: PeriodDays;
}): ReactNode {
  const { card } = props;
  const path = viewpointPath(card.viewpointId, props.horizon, props.periodDays);
  const metrics = Object.entries(card.metrics);
  return (
    <li
      className={`viewpoint-card status-border-${card.status.toLowerCase()}`}
      data-testid={`card-${card.viewpointId}`}
    >
      <div className="card-head">
        <ViewpointIcon viewpointId={card.viewpointId} />
        <h3>
          <Link to={path}>{card.name}</Link>
        </h3>
        <StatusBadge status={card.status} />
      </div>
      {metrics.length === 0 && card.statusDetail === null ? null : (
        <dl className="metrics">
          {metrics.map(([metricId, value]) => (
            <div key={metricId}>
              <dt>{getMetricMeta(metricId).label}</dt>
              <dd
                className={`metric-value metric-${card.metricStatuses[metricId]?.toLowerCase() ?? 'none'}`}
              >
                <MetricMark status={card.metricStatuses[metricId]} />
                {formatMetricValue(metricId, value)}
              </dd>
            </div>
          ))}
          {card.statusDetail === null ? null : (
            <div>
              <dt>{getMetricMeta('status').label}</dt>
              <dd className={`metric-value metric-${card.statusDetail.category.toLowerCase()}`}>
                <MetricMark status={card.statusDetail.category} />
                {card.statusDetail.name}
              </dd>
            </div>
          )}
        </dl>
      )}
      <p className="diagnostic">{card.diagnosticMessage}</p>
      <p className="action">
        <strong>{MESSAGES.dashboard.recommendedAction}: </strong>
        {card.recommendedAction}
      </p>
      {card.evaluatedFrom === null ? null : (
        <>
          <p className="evaluated-period">
            {MESSAGES.dashboard.evaluatedPeriod}: {formatDateTimeJst(card.evaluatedFrom)} 〜{' '}
            {formatDateTimeJst(card.evaluatedTo)}
          </p>
          {card.horizonUsed === props.horizon ? null : (
            <p className="evaluated-period">{MESSAGES.dashboard.longNotice}</p>
          )}
        </>
      )}
      {card.isCustomCriteria ? (
        <p className="custom-criteria">{MESSAGES.dashboard.customCriteria}</p>
      ) : null}
      <Link className="card-link" to={path}>
        {MESSAGES.dashboard.detail}
        <span className="visually-hidden">（{card.name}）</span>
      </Link>
    </li>
  );
}

export function DashboardPage(): ReactNode {
  const { api } = useAuth();
  const { selectedEquipmentId, equipmentTree, equipmentNames, equipmentError, setDataStatus } =
    useAppState();
  const { horizon, periodDays, setHorizon, setPeriodDays } = useHorizonSelection();

  const fetchDashboard = useCallback(async () => {
    if (selectedEquipmentId === undefined) {
      return undefined;
    }
    return getDashboard(api, { equipmentId: selectedEquipmentId, horizon, periodDays });
  }, [api, selectedEquipmentId, horizon, periodDays]);
  const { data, error, refreshError, reload } = usePolling(fetchDashboard);

  // 最終のデータ取得日時を、共通のヘッダーに反映する
  useEffect(() => {
    setDataStatus(
      data === undefined
        ? undefined
        : { lastReceivedAt: data.lastReceivedAt, freshness: data.dataFreshness },
    );
    return () => {
      setDataStatus(undefined);
    };
  }, [data, setDataStatus]);

  if (equipmentError !== undefined) {
    return <ErrorView error={equipmentError} />;
  }
  if (equipmentTree === undefined) {
    return <LoadingView />;
  }
  if (selectedEquipmentId === undefined) {
    return (
      <section>
        <h1>{MESSAGES.dashboard.title}</h1>
        <div role="status" className="notice notice-info">
          <Icon name="info" size={18} />
          <p>{MESSAGES.dashboard.noEquipment}</p>
          <p className="notice-links">
            <Link to={PATHS.settingsEquipment}>{MESSAGES.nav.equipment}</Link>
          </p>
        </div>
      </section>
    );
  }

  const equipmentName = equipmentNames.get(selectedEquipmentId);

  let content: ReactNode;
  if (error !== undefined) {
    content = <ErrorView error={error} onRetry={reload} />;
  } else if (data === undefined) {
    content = <LoadingView />;
  } else {
    // 更新に一時的に失敗しても、取得済みの内容を消さず、古い内容であることを知らせる（V-061）
    content = (
      <>
        {refreshError === undefined ? null : (
          <p role="status" className="notice notice-warning" data-testid="stale-data-notice">
            <Icon name="status-caution" size={18} />
            {MESSAGES.common.staleData}
          </p>
        )}
        <DashboardContent data={data} horizon={horizon} periodDays={periodDays} />
      </>
    );
  }

  // 視点・期間を切り替えて取得し直している間も、切り替えの操作は表示したままにする
  return (
    <section className="dashboard">
      <div className="page-head">
        <h1>{MESSAGES.dashboard.title}</h1>
        <p className="page-meta">
          {MESSAGES.dashboard.target}: <strong>{equipmentName}</strong>
          {data?.evaluatedAt === null || data === undefined ? null : (
            <>
              <span className="meta-separator" aria-hidden="true">
                ／
              </span>
              {MESSAGES.dashboard.evaluatedAt}: {formatDateTimeJst(data.evaluatedAt)}
            </>
          )}
        </p>
      </div>
      <HorizonControls
        horizon={horizon}
        periodDays={periodDays}
        onHorizonChange={setHorizon}
        onPeriodChange={setPeriodDays}
      />
      {content}
    </section>
  );
}

function DashboardContent(props: {
  readonly data: DashboardResponse;
  readonly horizon: Horizon;
  readonly periodDays: PeriodDays;
}): ReactNode {
  const { data } = props;
  return (
    <>
      {data.dataFreshness === 'STALE' ? (
        <p role="alert" className="notice notice-warning">
          <Icon name="status-caution" size={18} />
          {MESSAGES.dashboard.freshnessStale}
        </p>
      ) : null}
      {data.dataFreshness === 'NONE' ? (
        <div role="status" className="notice notice-info">
          <Icon name="info" size={18} />
          <p>{MESSAGES.dashboard.freshnessNone}</p>
          <p className="notice-links">
            <Link to={PATHS.dataEntry}>{MESSAGES.dashboard.goDataEntry}</Link>
            <Link to={PATHS.settingsIngestion}>{MESSAGES.dashboard.goIngestion}</Link>
          </p>
        </div>
      ) : null}

      <h2>{MESSAGES.dashboard.summary}</h2>
      <ul className="summary" aria-label={MESSAGES.dashboard.summary}>
        {EVALUATION_STATUSES.map((status) => (
          <li
            key={status}
            className={`summary-tile summary-${status.toLowerCase()}`}
            data-testid={`summary-${status}`}
          >
            <Icon name={STATUS_ICON[status]} size={30} />
            <span className="summary-count">{data.summary[status]}</span>
            <span className="summary-label" aria-hidden="true">
              {STATUS_LABELS[status]}
            </span>
            <span className="visually-hidden">
              {MESSAGES.dashboard.summaryCountLabel(STATUS_LABELS[status])}
            </span>
          </li>
        ))}
      </ul>

      <h2>{MESSAGES.dashboard.viewpointList}</h2>
      <ul className="viewpoint-cards">
        {data.viewpoints.map((card) => (
          <ViewpointCardView
            key={card.viewpointId}
            card={card}
            horizon={props.horizon}
            periodDays={props.periodDays}
          />
        ))}
      </ul>
    </>
  );
}
