/**
 * 観点の詳細: 診断結果（UC-02・UC-04。FR-5.5、FR-6.4）。ステータス・診断メッセージ・推奨アクション・判定の対象期間を、
 * 視点（短期・長期）ごとに示す。評価できない（不明）場合は、その旨と、データの取得・入力を確認する導線を示す。
 */

import type { ReactNode } from 'react';
import {
  DEFAULT_PERIOD_DAYS,
  UNKNOWN_ACTION,
  type PeriodDays,
} from '@smart-farm/shared/constants/status';
import type {
  HorizonDiagnosis,
  ViewpointDetailResponse,
} from '@smart-farm/shared/schemas/evaluation';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';
import { formatDateTimeJst } from './format.ts';
import { StatusBadge } from './status-badge.tsx';

/** 視点の表示名（短期は直近24時間、長期は選んだ期間）。 */
export function horizonLabel(horizon: 'SHORT' | 'LONG', periodDays: PeriodDays | null): string {
  return horizon === 'SHORT'
    ? `${MESSAGES.viewpoint.horizonShort}（${MESSAGES.dashboard.shortWindow}）`
    : `${MESSAGES.viewpoint.horizonLong}（${MESSAGES.dashboard.periodDays[periodDays ?? DEFAULT_PERIOD_DAYS]}）`;
}

function Period(props: { readonly diagnosis: HorizonDiagnosis }): ReactNode {
  return (
    <p className="evaluated-period">
      {MESSAGES.dashboard.evaluatedPeriod}: {formatDateTimeJst(props.diagnosis.evaluatedFrom)} 〜{' '}
      {formatDateTimeJst(props.diagnosis.evaluatedTo)}
    </p>
  );
}

/** データ不足（不明）のときの導線: データ入力・取り込み設定・状況へ。 */
function UnknownGuide(): ReactNode {
  return (
    <div className="unknown-guide" data-testid="unknown-guide">
      <p>{MESSAGES.viewpoint.unknownGuide}</p>
      <p className="notice-links">
        <Link to={PATHS.dataEntry}>{MESSAGES.dashboard.goDataEntry}</Link>
        <Link to={PATHS.settingsIngestion}>{MESSAGES.dashboard.goIngestion}</Link>
      </p>
    </div>
  );
}

function HorizonCard(props: {
  readonly testId: string;
  readonly title: string;
  readonly diagnosis: HorizonDiagnosis | null;
  readonly emptyText: string;
}): ReactNode {
  const { diagnosis } = props;
  return (
    <div className="horizon-card" data-testid={props.testId}>
      <h4>{props.title}</h4>
      {diagnosis === null ? (
        <p className="muted">{props.emptyText}</p>
      ) : (
        <>
          <StatusBadge status={diagnosis.status} />
          <Period diagnosis={diagnosis} />
        </>
      )}
    </div>
  );
}

export function DiagnosisSection(props: { readonly detail: ViewpointDetailResponse }): ReactNode {
  const { detail } = props;
  const { selected } = detail;
  return (
    <section className="panel" aria-labelledby="diagnosis-heading" data-testid="diagnosis">
      <h2 id="diagnosis-heading">{MESSAGES.viewpoint.diagnosis}</h2>
      {selected === null ? (
        <div className="diagnosis diagnosis-unknown">
          <p className="state-view" role="status">
            {MESSAGES.viewpoint.notEvaluated}
          </p>
          <p className="recommended-action" data-testid="recommended-action">
            <strong>{MESSAGES.viewpoint.recommendedAction}</strong>
            <span>{UNKNOWN_ACTION}</span>
          </p>
          <UnknownGuide />
        </div>
      ) : (
        <div className={`diagnosis diagnosis-${selected.status.toLowerCase()}`}>
          <div className="diagnosis-head">
            <StatusBadge status={selected.status} />
            <span className="diagnosis-horizon">
              {horizonLabel(detail.horizonUsed, selected.periodDays)}
            </span>
          </div>
          <p className="diagnostic-message" data-testid="diagnostic-message">
            <strong>{MESSAGES.viewpoint.diagnosticMessage}</strong>
            <span>{selected.diagnosticMessage}</span>
          </p>
          <p className="recommended-action" data-testid="recommended-action">
            <strong>{MESSAGES.viewpoint.recommendedAction}</strong>
            <span>{selected.recommendedAction}</span>
          </p>
          {selected.isCustomCriteria ? (
            <p className="custom-criteria">{MESSAGES.dashboard.customCriteria}</p>
          ) : null}
          {selected.status === 'UNKNOWN' ? <UnknownGuide /> : null}
          <Period diagnosis={selected} />
          {detail.horizon === detail.horizonUsed ? null : (
            <p className="muted">{MESSAGES.viewpoint.horizonUsedLong}</p>
          )}
        </div>
      )}

      <h3>{MESSAGES.viewpoint.horizons}</h3>
      <div className="horizon-cards">
        <HorizonCard
          testId="horizon-short"
          title={horizonLabel('SHORT', null)}
          diagnosis={detail.short}
          emptyText={
            detail.hasShortHorizon ? MESSAGES.viewpoint.notEvaluated : MESSAGES.viewpoint.noShort
          }
        />
        <HorizonCard
          testId="horizon-long"
          title={horizonLabel('LONG', detail.periodDays)}
          diagnosis={detail.long}
          emptyText={MESSAGES.viewpoint.notEvaluated}
        />
      </div>
    </section>
  );
}
