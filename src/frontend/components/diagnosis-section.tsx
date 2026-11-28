/**
 * 観点の詳細: 診断結果（UC-02・UC-04。FR-5.5、FR-6.4）。「現在」（短期の評価。直近 24 時間）と「期間の評価」（長期の評価。選んだ期間）を、
 * 別々の欄で示す。ステータス・診断メッセージ・推奨アクション・判定の対象期間・評価の時刻は、欄ごとの 1 回の評価の結果だけから示し、
 * 短期と長期の「悪い方」への合成は、示さない（FR-5.6。#591）。視点（短期・長期）の切り替えは、ない。
 * 評価できない（不明）場合は、その旨と、データの取得・入力を確認する導線を示す。
 * 短期評価を持たない観点は、「現在」の欄に「現在の評価はありません」を示し、理由のヘルプヒントを添える（SC-03-9）。
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
import { HelpHint } from './help-hint.tsx';
import { RecordResponseLink } from './record-response-link.tsx';
import { StatusBadge } from './status-badge.tsx';

/** 「期間の評価」の欄の見出し（選んだ期間つき）。 */
export function periodTitle(periodDays: PeriodDays | null): string {
  return `${MESSAGES.viewpoint.periodTitle}（${MESSAGES.dashboard.periodDays[periodDays ?? DEFAULT_PERIOD_DAYS]}）`;
}

/** 「現在」の欄の見出し。 */
export function currentTitle(): string {
  return `${MESSAGES.viewpoint.currentTitle}（${MESSAGES.dashboard.shortWindow}）`;
}

function Period(props: { readonly diagnosis: HorizonDiagnosis }): ReactNode {
  return (
    <>
      <p className="evaluated-period">
        {MESSAGES.dashboard.evaluatedPeriod}: {formatDateTimeJst(props.diagnosis.evaluatedFrom)} 〜{' '}
        {formatDateTimeJst(props.diagnosis.evaluatedTo)}
      </p>
      <p className="evaluated-at">
        {MESSAGES.dashboard.cardEvaluatedAt}: {formatDateTimeJst(props.diagnosis.evaluatedAt)}
      </p>
    </>
  );
}

/** データ不足（不明）のときの導線: データ入力・取り込みへ。 */
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

/** 診断結果の 1 つの欄（「現在」または「期間の評価」）。評価がなければ、空の理由を示す。 */
function DiagnosisBlock(props: {
  /** 欄の種類（`data-testid` の接頭辞）。 */
  readonly scope: 'current' | 'period';
  readonly title: string;
  readonly diagnosis: HorizonDiagnosis | null;
  readonly emptyText: string;
  /** 空の理由の説明（ヘルプヒント）。 */
  readonly emptyHint?: ReactNode;
  /** 評価がまだないときに、推奨アクションとして示す文（期間の評価だけ）。 */
  readonly emptyAction?: string;
}): ReactNode {
  const { diagnosis, scope } = props;
  // 「期間の評価」は、診断メッセージ・推奨アクションの `data-testid` を、従来のまま（`diagnostic-message`・`recommended-action`）にする
  const messageId = scope === 'period' ? 'diagnostic-message' : 'current-diagnostic-message';
  const actionId = scope === 'period' ? 'recommended-action' : 'current-recommended-action';
  if (diagnosis === null) {
    return (
      <div className="diagnosis-block diagnosis-unknown" data-testid={`diagnosis-${scope}`}>
        <h3 className="diagnosis-block-head">{props.title}</h3>
        {/* 読み込み中の表示（`state-view`・`role="status"`）とは、別の表示（空の欄の説明） */}
        <p className="muted">
          {props.emptyText}
          {props.emptyHint}
        </p>
        {props.emptyAction === undefined ? null : (
          <p className="recommended-action" data-testid={actionId}>
            <strong>{MESSAGES.viewpoint.recommendedAction}</strong>
            <span>{props.emptyAction}</span>
          </p>
        )}
      </div>
    );
  }
  return (
    <div
      className={`diagnosis-block diagnosis-${diagnosis.status.toLowerCase()}`}
      data-testid={`diagnosis-${scope}`}
    >
      <h3 className="diagnosis-block-head">
        <span>{props.title}</span>
        <StatusBadge status={diagnosis.status} />
      </h3>
      <p className="diagnostic-message" data-testid={messageId}>
        <strong>{MESSAGES.viewpoint.diagnosticMessage}</strong>
        <span>{diagnosis.diagnosticMessage}</span>
      </p>
      <p className="recommended-action" data-testid={actionId}>
        <strong>{MESSAGES.viewpoint.recommendedAction}</strong>
        <span>{diagnosis.recommendedAction}</span>
      </p>
      {diagnosis.isCustomCriteria ? (
        <p className="custom-criteria">{MESSAGES.dashboard.customCriteria}</p>
      ) : null}
      <Period diagnosis={diagnosis} />
    </div>
  );
}

export function DiagnosisSection(props: { readonly detail: ViewpointDetailResponse }): ReactNode {
  const { detail } = props;
  return (
    <section className="panel" aria-labelledby="diagnosis-heading" data-testid="diagnosis">
      <h2 id="diagnosis-heading">{MESSAGES.viewpoint.diagnosis}</h2>
      <div className="diagnosis-blocks">
        <DiagnosisBlock
          scope="current"
          title={currentTitle()}
          diagnosis={detail.short}
          emptyText={
            detail.hasShortHorizon ? MESSAGES.viewpoint.notEvaluated : MESSAGES.viewpoint.noCurrent
          }
          emptyHint={
            detail.hasShortHorizon ? undefined : (
              <HelpHint
                name={MESSAGES.viewpoint.noCurrentHint.name}
                help={MESSAGES.viewpoint.noCurrentHint.help}
              />
            )
          }
        />
        <DiagnosisBlock
          scope="period"
          title={periodTitle(detail.periodDays)}
          diagnosis={detail.long}
          emptyText={MESSAGES.viewpoint.notEvaluated}
          emptyAction={UNKNOWN_ACTION}
        />
      </div>
      {/* データ不足（不明）の導線は、「現在」「期間の評価」のどちらかが不明、または、評価がまだのとき、欄の下に 1 回だけ示す */}
      {detail.long === null ||
      detail.long.status === 'UNKNOWN' ||
      detail.short?.status === 'UNKNOWN' ? (
        <UnknownGuide />
      ) : null}
      {/* 異常・注意のときの、対応の結果の記録への導線。「現在」「期間の評価」のどちらかが異常・注意なら出す（通知と同じ基準） */}
      <RecordResponseLink status={detail.status} equipmentId={detail.equipmentId} />
    </section>
  );
}
