/**
 * SC-02 ダッシュボード（UC-01、UC-04。FR-6.1〜6.3、6.6、6.7）。ハウス単位。
 * 操作: 対象のハウス・期間の選択・手動の更新。表示: 最終のデータ取得日時・最終の評価日時・判定の対象期間（満足度を除く観点で同じなら、ここに 1 回。
 * 満足度の期間が、これと違うときだけ、満足度のカードに示す。日時は、分まで。Issue #160）、
 * ステータスごとの観点の数、観点別の状態の一覧（表）、観点のカード（ステータス・主要メトリクスと判定・診断メッセージ・推奨アクション）。
 * 評価が更新されていない（最終の評価から 15 分以上）ときは、警告を出す。古い設備があるときは、警告を開くと、設備名・最終の受信日時・基準（分）の一覧を示す
 * （Issue #158）。最終の評価・最終のデータ取得の横に、ヘルプヒントを置く。
 * 約10秒間隔で最新の評価結果を読み直す（タブの表示中のみ）。視点（短期・長期）の切り替えはない。
 * カードは、「現在」（直近 24 時間の評価。短期を持つ観点だけ）と「期間」（選んだ期間の評価）の 2 区画で示す。
 * 値・状態・診断・推奨アクションは、区画ごとに、1 回の評価の結果だけから示し、混ぜない。評価の時刻も、区画ごとに示す。
 * 状態の数・一覧の状態も、「現在」と「期間」を、別々に示す（FR-5.6。#591）。Issue #355・#356。
 * 期間は、URL のクエリで保持する。カード・表の行を選ぶと、観点の詳細（SC-03。満足度は SC-04）を、右からのドロワーで開く
 * （URL は `/?viewpoint=観点`。ダッシュボードは、描画したまま保つ。Issue #357）。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  EVALUATION_STALE_MINUTES,
  isEvaluationStale,
} from '@smart-farm/shared/constants/evaluation-schedule';
import { formatMetricValue } from '@smart-farm/shared/constants/metrics';
import { STATUS_INDICATOR_ID } from '@smart-farm/shared/constants/metrics';
import { MS_PER_SECOND } from '@smart-farm/shared/time';
import { defaultPeriodDays, findViewpointMeta } from '@smart-farm/shared/constants/viewpoints';
import {
  EVALUATION_STATUSES,
  STATUS_LABELS,
  type EvaluationStatus,
  type Horizon,
  type PeriodDays,
} from '@smart-farm/shared/constants/status';
import type {
  DashboardResponse,
  MetricValues,
  StatusDetail,
  ViewpointCard,
} from '@smart-farm/shared/schemas/evaluation';
import { getDashboard } from '../api/endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import { EquipmentSelect } from '../components/equipment-select.tsx';
import { formatDateTimeJst, formatDateTimeMinutesJst } from '../components/format.ts';
import {
  HorizonControls,
  periodQueryString,
  readPeriodQuery,
} from '../components/horizon-controls.tsx';
import { HelpHint } from '../components/help-hint.tsx';
import { Icon, STATUS_ICON, ViewpointIcon } from '../components/icon.tsx';
import { StatusLegend } from '../components/legend.tsx';
import { MetricLabel } from '../components/metric-label.tsx';
import { ErrorView, LoadingView } from '../components/state-views.tsx';
import { RecordResponseLink } from '../components/record-response-link.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { ViewpointDrawer } from '../components/viewpoint-drawer.tsx';
import { usePermission } from '../hooks/use-permission.ts';
import { usePeriodSelection } from '../hooks/use-horizon-selection.ts';
import { POLLING_INTERVAL_MS, usePolling } from '../hooks/use-polling.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS, viewpointDrawerPath } from '../router/paths.ts';
import { Link, navigate, useLocation } from '../router/router.tsx';

/** ダッシュボードの評価の視点。視点の切り替えはなく、長期（選んだ期間）で示す。 */
const DASHBOARD_HORIZON: Horizon = 'LONG';

/** 判定の対象期間。 */
interface EvaluatedPeriod {
  readonly from: string;
  readonly to: string;
}

/**
 * 観点の詳細へのパス。満足度は、専用の詳細（SC-04）へ。満足度は、期間を選んでいなければ、期間を付けない
 * （満足度の既定の 30 日で開く）。
 */
export function viewpointPath(
  viewpointId: string,
  periodDays: PeriodDays,
  selectedPeriodDays: PeriodDays | undefined,
): string {
  if (viewpointId !== 'satisfaction') {
    return `${PATHS.viewpoint(viewpointId)}?${periodQueryString(periodDays)}`;
  }
  return selectedPeriodDays === undefined
    ? PATHS.satisfaction
    : `${PATHS.satisfaction}?${new URLSearchParams({ periodDays: String(selectedPeriodDays) }).toString()}`;
}

function periodOf(card: ViewpointCard): EvaluatedPeriod | null {
  return card.evaluatedFrom === null || card.evaluatedTo === null
    ? null
    : { from: card.evaluatedFrom, to: card.evaluatedTo };
}

/**
 * 満足度を除く観点で、判定の対象期間が同じなら、その期間（ダッシュボードの上部に 1 回だけ示す）。評価前の観点（期間がない）は、除いて比べる。
 * 満足度は、既定の期間が 30 日で、ほかと違うため、比べる対象にしない（違うときだけ、満足度のカードに示す。Issue #160）。
 * 期間が違う観点がある、または、期間のある観点がなければ、null（カードごとに示す）。
 */
export function commonEvaluatedPeriod(cards: readonly ViewpointCard[]): EvaluatedPeriod | null {
  const periods = cards.flatMap((card) => {
    const period = card.viewpointId === 'satisfaction' ? null : periodOf(card);
    return period === null ? [] : [period];
  });
  const first = periods[0];
  if (first === undefined) {
    return null;
  }
  return periods.every((period) => period.from === first.from && period.to === first.to)
    ? first
    : null;
}

/** カードに、判定の対象期間を示すか。共通の期間（上部に示す）と同じなら、示さない。共通の期間がなければ、期間のあるカードごとに示す。 */
export function showsCardPeriod(card: ViewpointCard, common: EvaluatedPeriod | null): boolean {
  const period = periodOf(card);
  if (period === null) {
    return false;
  }
  return common?.from !== period.from || common.to !== period.to;
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

/** 主要メトリクスと、判定に使ったステータスコード。どちらもなければ、示さない。 */
function MetricList(props: {
  readonly metrics: MetricValues;
  readonly metricStatuses: Readonly<Record<string, EvaluationStatus>>;
  readonly statusDetail: StatusDetail | null;
}): ReactNode {
  const metrics = Object.entries(props.metrics);
  if (metrics.length === 0 && props.statusDetail === null) {
    return null;
  }
  return (
    <dl className="metrics">
      {metrics.map(([metricId, value]) => (
        <div key={metricId}>
          <dt>
            <MetricLabel metricId={metricId} />
          </dt>
          <dd
            className={`metric-value metric-${props.metricStatuses[metricId]?.toLowerCase() ?? 'none'}`}
          >
            <MetricMark status={props.metricStatuses[metricId]} />
            {formatMetricValue(metricId, value)}
          </dd>
        </div>
      ))}
      {props.statusDetail === null ? null : (
        <div>
          <dt>
            <MetricLabel metricId={STATUS_INDICATOR_ID} />
          </dt>
          <dd className={`metric-value metric-${props.statusDetail.category.toLowerCase()}`}>
            <MetricMark status={props.statusDetail.category} />
            {props.statusDetail.name}
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * カードの 1 区画（「現在」または「期間」）。値・状態・診断・推奨アクションは、1 回の評価の結果だけから示し、評価の時刻を添える。
 * 別の評価の結果とは、混ぜない（FR-5.6。#591）。
 */
function ResultSection(props: {
  readonly testId: string;
  readonly title: string;
  readonly status: EvaluationStatus;
  readonly metrics: MetricValues;
  readonly metricStatuses: Readonly<Record<string, EvaluationStatus>>;
  readonly statusDetail: StatusDetail | null;
  readonly diagnosticMessage: string;
  readonly recommendedAction: string;
  readonly evaluatedAt: string | null;
  readonly isCustomCriteria: boolean;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <section className="card-section" data-testid={props.testId}>
      <h4 className="card-section-head">
        <span>{props.title}</span>
        <StatusBadge status={props.status} />
      </h4>
      <MetricList
        metrics={props.metrics}
        metricStatuses={props.metricStatuses}
        statusDetail={props.statusDetail}
      />
      <p className="diagnostic">{props.diagnosticMessage}</p>
      <p className="action">
        <strong>{MESSAGES.dashboard.recommendedAction}: </strong>
        {props.recommendedAction}
      </p>
      {props.children}
      {props.evaluatedAt === null ? null : (
        <p className="evaluated-at" data-testid={`${props.testId}-evaluated-at`}>
          {MESSAGES.dashboard.cardEvaluatedAt}: {formatDateTimeMinutesJst(props.evaluatedAt)}
        </p>
      )}
      {props.isCustomCriteria ? (
        <p className="custom-criteria">{MESSAGES.dashboard.customCriteria}</p>
      ) : null}
    </section>
  );
}

function ViewpointCardView(props: {
  readonly card: ViewpointCard;
  readonly path: string;
  /** 対象のハウス（「対応の結果を記録する」の対象の設備）。 */
  readonly equipmentId: string;
  /** 「期間」に、判定の対象期間を示すか（共通の期間と同じなら、ダッシュボードの上部に示すため、示さない）。 */
  readonly showPeriod: boolean;
}): ReactNode {
  const { card, path, equipmentId } = props;
  // 枠の色は、「現在」「期間」のうち悪い方（目を引くため。通知と同じ基準）。状態の表示は、区画ごと
  return (
    <li
      className={`viewpoint-card status-border-${card.status.toLowerCase()}`}
      data-testid={`card-${card.viewpointId}`}
    >
      <div className="card-head">
        <ViewpointIcon viewpointId={card.viewpointId} />
        {/* 詳細へのリンクは、題名の 1 つだけ（見出しの一覧から、観点名で移動できる。Issue #160） */}
        <h3>
          <Link to={path}>{card.name}</Link>
        </h3>
      </div>
      {card.current === null ? null : (
        <ResultSection
          testId={`current-${card.viewpointId}`}
          title={MESSAGES.dashboard.currentTitle}
          status={card.current.status}
          metrics={card.current.metrics}
          metricStatuses={card.current.metricStatuses}
          statusDetail={card.current.statusDetail}
          diagnosticMessage={card.current.diagnosticMessage}
          recommendedAction={card.current.recommendedAction}
          evaluatedAt={card.current.evaluatedAt}
          isCustomCriteria={card.current.isCustomCriteria}
        />
      )}
      <ResultSection
        testId={`period-${card.viewpointId}`}
        title={MESSAGES.dashboard.periodTitle}
        status={card.statuses.long}
        metrics={card.metrics}
        metricStatuses={card.metricStatuses}
        statusDetail={card.statusDetail}
        diagnosticMessage={card.diagnosticMessage}
        recommendedAction={card.recommendedAction}
        evaluatedAt={card.evaluatedAt}
        isCustomCriteria={card.isCustomCriteria}
      >
        {props.showPeriod && card.evaluatedFrom !== null ? (
          <p className="evaluated-period">
            {MESSAGES.dashboard.evaluatedPeriod}: {formatDateTimeMinutesJst(card.evaluatedFrom)} 〜{' '}
            {formatDateTimeMinutesJst(card.evaluatedTo)}
          </p>
        ) : null}
      </ResultSection>
      <RecordResponseLink status={card.status} equipmentId={equipmentId} />
    </li>
  );
}

/** 最終のデータ取得日時（ヘッダーから、ダッシュボードの中へ移した。Issue #355）。手動のみの運用は、最終の手動入力。 */
function DataStatusText(props: { readonly data: DashboardResponse }): ReactNode {
  const { data } = props;
  // 手動のみの運用（自動取り込みが有効でない）は、「最終のデータ取得」の代わりに、「最終の手動入力」を示す（Issue #202）
  const isManual = data.dataFreshness === 'MANUAL';
  const text = isManual
    ? data.lastManualInputAt === null
      ? MESSAGES.layout.noManualInput
      : formatDateTimeJst(data.lastManualInputAt)
    : data.dataFreshness === 'NONE'
      ? MESSAGES.layout.notReceived
      : formatDateTimeJst(data.lastReceivedAt);
  return (
    <span
      className={`data-status data-${data.dataFreshness.toLowerCase()}`}
      data-testid="data-status"
    >
      <span>{isManual ? MESSAGES.layout.lastManualInput : MESSAGES.layout.lastReceived}: </span>
      <span>{text}</span>
      {data.dataFreshness === 'STALE' ? <strong>（{MESSAGES.layout.stale}）</strong> : null}
    </span>
  );
}

/** 最終のデータ取得（手動のみの運用は、最終の手動入力）の横のヘルプヒント。画面の更新（10 秒）と、取得間隔の違いを説明する（SC-11-9）。 */
function DataStatusHint(props: { readonly data: DashboardResponse }): ReactNode {
  return props.data.dataFreshness === 'MANUAL' ? (
    <HelpHint
      name={MESSAGES.dashboard.lastManualInputHintName}
      help={MESSAGES.dashboard.lastManualInputHint}
    />
  ) : (
    <HelpHint
      name={MESSAGES.dashboard.lastReceivedHintName}
      help={MESSAGES.dashboard.lastReceivedHint(POLLING_INTERVAL_MS / MS_PER_SECOND)}
    />
  );
}

export function DashboardPage(): ReactNode {
  const { api } = useAuth();
  const {
    selectedEquipmentId,
    selectedFacilityId,
    selectEquipment,
    equipmentTree,
    equipmentError,
  } = useAppState();
  // 全設備を閲覧できない利用者（一般）には、設備の登録ではなく、割り当ての案内を示す（Issue #330）
  const canViewAll = usePermission('equipment:view-all');
  const { periodDays, selectedPeriodDays, setPeriodDays } = usePeriodSelection();
  // 観点の詳細のドロワー: URL の `viewpoint`（知らない観点は、無視する）
  const { pathname, search } = useLocation();
  const viewpointParam = search.get('viewpoint');
  const drawerViewpointId =
    viewpointParam !== null && findViewpointMeta(viewpointParam) !== undefined
      ? viewpointParam
      : undefined;
  const closeDrawer = useCallback(() => {
    // 期間（ドロワーの中で変えたものを含む）は、保ち、ドロワーのクエリ（観点・視点）だけを外す
    const next = new URLSearchParams(window.location.search);
    next.delete('viewpoint');
    next.delete('horizon');
    const query = next.toString();
    navigate(query === '' ? pathname : `${pathname}?${query}`, { replace: true });
  }, [pathname]);

  const fetchDashboard = useCallback(async () => {
    if (selectedFacilityId === undefined) {
      return undefined;
    }
    // 期間は、選んだときだけ送る（選んでいなければ、観点ごとの既定の期間。満足度は 30 日、ほかは 7 日）
    return getDashboard(api, {
      equipmentId: selectedFacilityId,
      horizon: DASHBOARD_HORIZON,
      periodDays: selectedPeriodDays,
    });
  }, [api, selectedFacilityId, selectedPeriodDays]);
  const { data, error, refreshError, reload, version } = usePolling(fetchDashboard);

  // ダッシュボードはハウス単位。観点の詳細で、ロボット・センサーを選んでから戻ったときは、選択を、そのハウスにそろえる
  // （カードから開く観点の詳細が、ダッシュボードの示すハウスの詳細になる）
  // ドロワーを開いている間は、そろえない（ドロワーの中で、ロボット・センサーを選べるように）。閉じたときに、そろえる
  const drawerOpen = drawerViewpointId !== undefined;
  useEffect(() => {
    if (
      !drawerOpen &&
      selectedFacilityId !== undefined &&
      selectedEquipmentId !== selectedFacilityId
    ) {
      selectEquipment(selectedFacilityId);
    }
  }, [drawerOpen, selectedEquipmentId, selectedFacilityId, selectEquipment]);

  // 手動の更新: 押した時点の取得の回数を覚え、取得が完了する（回数が変わる）まで、更新中にする
  const [refreshFrom, setRefreshFrom] = useState<number | null>(null);
  const refreshing = refreshFrom !== null && refreshFrom === version;
  const refresh = (): void => {
    if (!refreshing) {
      setRefreshFrom(version);
      reload();
    }
  };

  if (equipmentError !== undefined) {
    return <ErrorView error={equipmentError} />;
  }
  if (equipmentTree === undefined) {
    return <LoadingView />;
  }
  if (selectedFacilityId === undefined) {
    return (
      <section>
        <h1>{MESSAGES.dashboard.title}</h1>
        <div role="status" className="notice notice-info">
          <Icon name="info" size={18} />
          {canViewAll ? (
            <>
              <p>{MESSAGES.dashboard.noEquipment}</p>
              <p className="notice-links">
                <Link to={PATHS.settingsEquipment}>{MESSAGES.nav.equipment}</Link>
              </p>
            </>
          ) : (
            <p>{MESSAGES.dashboard.noViewableFacility}</p>
          )}
        </div>
      </section>
    );
  }

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
        <DashboardContent data={data} selectedPeriodDays={selectedPeriodDays} />
      </>
    );
  }

  const commonPeriod = data === undefined ? null : commonEvaluatedPeriod(data.viewpoints);
  // 期間を切り替えて取得し直している間も、切り替えの操作は表示したままにする
  return (
    <section className="dashboard">
      <div className="page-head">
        <h1>{MESSAGES.dashboard.title}</h1>
      </div>
      <div className="page-controls">
        <EquipmentSelect label={MESSAGES.dashboard.targetFacility} facilitiesOnly />
        <HorizonControls
          horizon={DASHBOARD_HORIZON}
          periodDays={periodDays}
          periodLabel={MESSAGES.dashboard.periodShort}
          onPeriodChange={setPeriodDays}
        />
        <button
          type="button"
          className="refresh-button"
          aria-disabled={refreshing}
          aria-busy={refreshing}
          onClick={refresh}
        >
          <Icon name="refresh" size={16} />
          {refreshing ? MESSAGES.dashboard.refreshing : MESSAGES.dashboard.refresh}
        </button>
      </div>
      {data === undefined ? null : (
        <p className="page-meta" data-testid="dashboard-meta">
          <DataStatusText data={data} />
          <DataStatusHint data={data} />
          {data.evaluatedAt === null ? null : (
            <>
              <span className="meta-separator" aria-hidden="true">
                ／
              </span>
              {MESSAGES.dashboard.evaluatedAt}: {formatDateTimeJst(data.evaluatedAt)}
              <HelpHint
                name={MESSAGES.dashboard.evaluatedAtHintName}
                help={MESSAGES.dashboard.evaluatedAtHint(EVALUATION_STALE_MINUTES)}
              />
            </>
          )}
          {commonPeriod === null ? null : (
            <>
              <span className="meta-separator" aria-hidden="true">
                ／
              </span>
              <span data-testid="evaluated-period-common">
                {MESSAGES.dashboard.evaluatedPeriod}: {formatDateTimeMinutesJst(commonPeriod.from)}{' '}
                〜 {formatDateTimeMinutesJst(commonPeriod.to)}
              </span>
            </>
          )}
        </p>
      )}
      {content}
      {drawerViewpointId === undefined ? null : (
        <ViewpointDrawer
          viewpointId={drawerViewpointId}
          pagePath={viewpointPath(
            drawerViewpointId,
            readPeriodQuery(search) ?? defaultPeriodDays(drawerViewpointId),
            readPeriodQuery(search),
          )}
          viewpointIds={data?.viewpoints.map((card) => card.viewpointId) ?? []}
          selectedPeriodDays={readPeriodQuery(search)}
          onClose={closeDrawer}
        />
      )}
    </section>
  );
}

/** 警告に示す、古い設備の名前の数（それを超えた分は、「ほか N 件」）。 */
const STALE_NAMES_SHOWN = 3;

/** 古い設備の一覧（開くと、設備名・最終の受信日時・基準〔分〕。Issue #158。ADR-0016 の D-12）。 */
function StaleEquipmentList(props: {
  readonly items: DashboardResponse['staleEquipment'];
}): ReactNode {
  return (
    <details className="stale-equipment-list" data-testid="stale-equipment-details">
      <summary>{MESSAGES.dashboard.staleEquipmentList(props.items.length)}</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">{MESSAGES.dashboard.staleEquipmentName}</th>
            <th scope="col">{MESSAGES.dashboard.staleEquipmentLastReceived}</th>
            <th scope="col">{MESSAGES.dashboard.staleEquipmentThreshold}</th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((item) => (
            <tr key={item.equipmentId}>
              <th scope="row">{item.name}</th>
              <td>{formatDateTimeJst(item.lastReceivedAt)}</td>
              <td>{MESSAGES.dashboard.staleEquipmentMinutes(item.thresholdMinutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** ステータスごとの観点の数（タイル）。「現在」と「期間」を、別々に示す（`scope`）。 */
function SummaryTiles(props: {
  readonly scope: 'current' | 'period';
  readonly label: string;
  readonly counts: DashboardResponse['summary'];
}): ReactNode {
  return (
    <>
      <h3 className="summary-scope">{props.label}</h3>
      <ul className="summary" data-testid={`summary-${props.scope}`}>
        {EVALUATION_STATUSES.map((status) => (
          <li
            key={status}
            className={`summary-tile summary-${status.toLowerCase()}`}
            data-testid={`summary-${props.scope}-${status}`}
          >
            <Icon name={STATUS_ICON[status]} size={30} />
            <span className="summary-count">{props.counts[status]}</span>
            <span className="summary-label" aria-hidden="true">
              {STATUS_LABELS[status]}
            </span>
            <span className="visually-hidden">
              {MESSAGES.dashboard.summaryCountLabel(STATUS_LABELS[status])}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function DashboardContent(props: {
  readonly data: DashboardResponse;
  readonly selectedPeriodDays: PeriodDays | undefined;
}): ReactNode {
  const { data } = props;
  const commonPeriod = commonEvaluatedPeriod(data.viewpoints);
  // 評価が更新されていないとき（最終の評価から 15 分以上）は、その日時。画面の更新（10 秒ごと）のたびに、判定し直す。
  // 現在は、端末の時計（サーバーとの時計のずれは、考慮しない）
  const staleEvaluatedAt = isEvaluationStale(data.evaluatedAt, new Date())
    ? data.evaluatedAt
    : null;
  const cards = data.viewpoints.map((card) => ({
    card,
    path: viewpointDrawerPath(card.viewpointId, props.selectedPeriodDays),
  }));
  return (
    <>
      {staleEvaluatedAt === null ? null : (
        <p role="alert" className="notice notice-warning" data-testid="evaluation-stale">
          <Icon name="status-caution" size={18} />
          {MESSAGES.dashboard.evaluationStale(formatDateTimeJst(staleEvaluatedAt))}
        </p>
      )}
      {data.dataFreshness === 'STALE' ? (
        <div className="notice notice-warning">
          <Icon name="status-caution" size={18} />
          <p role="alert">
            {MESSAGES.dashboard.freshnessStale}
            {data.staleEquipment.length > 0 ? (
              <span data-testid="stale-equipment">
                {MESSAGES.dashboard.staleEquipment(
                  data.staleEquipment.slice(0, STALE_NAMES_SHOWN).map((item) => item.name),
                  Math.max(0, data.staleEquipment.length - STALE_NAMES_SHOWN),
                )}
              </span>
            ) : null}
          </p>
          {data.staleEquipment.length > 0 ? (
            <StaleEquipmentList items={data.staleEquipment} />
          ) : null}
        </div>
      ) : null}
      {data.dataFreshness === 'MANUAL' ? (
        <div role="status" className="notice notice-info" data-testid="freshness-manual">
          <Icon name="info" size={18} />
          <p>{MESSAGES.dashboard.freshnessManual}</p>
          <p className="notice-links">
            <Link to={PATHS.dataEntry}>{MESSAGES.dashboard.goDataEntry}</Link>
          </p>
        </div>
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

      <StatusLegend />

      <h2>{MESSAGES.dashboard.summary}</h2>
      <SummaryTiles
        scope="current"
        label={MESSAGES.dashboard.summaryCurrent}
        counts={data.currentSummary}
      />
      <SummaryTiles
        scope="period"
        label={MESSAGES.dashboard.summaryPeriod}
        counts={data.periodSummary}
      />

      <h2>{MESSAGES.dashboard.statusTable}</h2>
      <table className="status-table" data-testid="viewpoint-status-table">
        <thead>
          <tr>
            <th scope="col">{MESSAGES.dashboard.statusTableViewpoint}</th>
            <th scope="col">{MESSAGES.dashboard.statusTableCurrent}</th>
            <th scope="col">{MESSAGES.dashboard.statusTablePeriod}</th>
          </tr>
        </thead>
        <tbody>
          {cards.map(({ card, path }) => (
            <tr key={card.viewpointId} data-testid={`status-row-${card.viewpointId}`}>
              <th scope="row">
                <ViewpointIcon viewpointId={card.viewpointId} size={18} />
                <Link to={path}>{card.name}</Link>
              </th>
              <td data-testid={`status-current-${card.viewpointId}`}>
                {card.current === null ? (
                  <>
                    <span aria-hidden="true">―</span>
                    <span className="visually-hidden">{MESSAGES.dashboard.noCurrent}</span>
                  </>
                ) : (
                  <StatusBadge status={card.current.status} />
                )}
              </td>
              <td data-testid={`status-period-${card.viewpointId}`}>
                <StatusBadge status={card.statuses.long} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{MESSAGES.dashboard.viewpointList}</h2>
      <ul className="viewpoint-cards">
        {cards.map(({ card, path }) => (
          <ViewpointCardView
            key={card.viewpointId}
            card={card}
            path={path}
            equipmentId={data.equipmentId}
            showPeriod={showsCardPeriod(card, commonPeriod)}
          />
        ))}
      </ul>
    </>
  );
}
