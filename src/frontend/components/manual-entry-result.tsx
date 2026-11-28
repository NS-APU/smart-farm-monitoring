/**
 * 手動入力の保存・修正・削除の後の結果: 結果と、更新後の関連観点のステータス（FR-4.1.5。修正・削除の後も同じ。D-27）。
 * 結果の通知（`ResultNotice`）と同じく、`role="status"` で読み上げ、表示されたとき（保存のたび）に、画面内へスクロールする。フォーカスは動かさない（Issue #150。SC-06-3）。
 * 保存・修正の結果には、評価に使われない項目（自動取り込みの値がある期間の、合計の項目の手動入力。D-26）を一覧する（保存はできている。Issue #162 の SC-06-5）。
 */

import type { ReactNode } from 'react';
import { findItemDefinition } from '@smart-farm/shared/constants/items';
import type {
  ManualEntryItemUsage,
  ManualEntrySaveResponse,
} from '@smart-farm/shared/schemas/manual-entry';
import { useRevealOnChange } from '../hooks/use-reveal-on-change.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';
import { usageReasonText } from './evaluation-usage.ts';
import { Icon } from './icon.tsx';
import { StatusBadge } from './status-badge.tsx';

/** 結果の種類（保存〔SC-06〕・修正・削除〔SC-07〕）。説明の文と、一覧へのリンクの有無を決める。 */
export type ManualEntryResultKind = 'saved' | 'updated' | 'deleted';

/**
 * 評価の状態（DONE: 全期間を更新した／CURRENT: 「現在」だけ更新した。「期間の評価」は定期の評価で更新する〔#591〕／
 * DEFERRED: 定期の評価で更新する）ごとの、説明の文。評価の状態がなければ、DONE。
 */
const LEADS = {
  saved: {
    done: MESSAGES.entry.savedLead,
    current: MESSAGES.entry.savedLeadCurrent,
    deferred: MESSAGES.entry.savedLeadDeferred,
  },
  updated: {
    done: MESSAGES.entries.updatedLead,
    current: MESSAGES.entries.updatedLeadCurrent,
    deferred: MESSAGES.entries.updatedLeadDeferred,
  },
  deleted: {
    done: MESSAGES.entries.deletedLead,
    current: MESSAGES.entries.deletedLeadCurrent,
    deferred: MESSAGES.entries.deletedLeadDeferred,
  },
} as const;

/** 項目ごとの説明（項目名と、評価に使われない理由）。 */
function usageText(usage: ManualEntryItemUsage): string {
  const label = findItemDefinition(usage.itemKey)?.label ?? usage.itemKey;
  return `${label}: ${usageReasonText(usage)}`;
}

export function ManualEntryResult(props: {
  readonly response: ManualEntrySaveResponse;
  readonly title: string;
  /** 既定は、保存。 */
  readonly kind?: ManualEntryResultKind;
  /** 試験・E2E 用の識別子。既定は `entry-result`。 */
  readonly testId?: string;
}): ReactNode {
  const { response } = props;
  const kind = props.kind ?? 'saved';
  const lead = LEADS[kind];
  // 自動取り込みの値を使うため、評価に使われない項目がある入力だけ（削除の結果には、ない）
  const autoPriorityUsages = (response.usage ?? []).filter(
    (usage) => usage.autoPriorityPeriods.length > 0,
  );
  // 保存のたびに、新しい応答の object になる。同じ応答のままの描き直しでは、スクロールしない
  const ref = useRevealOnChange<HTMLElement>(response);
  return (
    <section
      ref={ref}
      role="status"
      className="panel entry-result"
      aria-labelledby="entry-result-heading"
      data-testid={props.testId ?? 'entry-result'}
    >
      <h2 id="entry-result-heading">{props.title}</h2>
      <p data-testid="entry-lead">
        {response.evaluation === 'DEFERRED'
          ? lead.deferred
          : response.evaluation === 'CURRENT'
            ? lead.current
            : lead.done}
      </p>
      {autoPriorityUsages.length === 0 ? null : (
        <div className="notice notice-warning" data-testid="usage-notice">
          <Icon name="status-caution" size={18} />
          <p>{MESSAGES.entry.usageTitle}</p>
          <ul>
            {autoPriorityUsages.map((usage) => (
              <li key={usage.itemKey} data-testid={`usage-${usage.itemKey}`}>
                {usageText(usage)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {response.viewpointStatuses.length === 0 ? (
        <p className="muted">{MESSAGES.entry.noRelated}</p>
      ) : (
        <ul className="related-statuses">
          {response.viewpointStatuses.map((item) => (
            <li key={item.viewpointId} data-testid={`related-${item.viewpointId}`}>
              <Link to={PATHS.viewpoint(item.viewpointId)}>{item.name}</Link>
              {/* 「現在」と「期間の評価」を、別々に示す（短期と長期の「悪い方」には、合成しない。#591）。短期を持たない観点は、「期間の評価」だけ */}
              {item.current === null ? null : (
                <span
                  className="related-status"
                  data-testid={`related-current-${item.viewpointId}`}
                >
                  <span className="related-label">{MESSAGES.entry.relatedCurrent}</span>
                  <StatusBadge status={item.current} />
                </span>
              )}
              <span className="related-status" data-testid={`related-period-${item.viewpointId}`}>
                <span className="related-label">{MESSAGES.entry.relatedPeriod}</span>
                {item.period === null ? (
                  <span className="muted">{MESSAGES.entry.relatedNotEvaluated}</span>
                ) : (
                  <StatusBadge status={item.period} />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="notice-links">
        {kind === 'saved' ? <Link to={PATHS.dataEntryList}>{MESSAGES.entry.goList}</Link> : null}
        <Link to={PATHS.dashboard}>{MESSAGES.entry.goDashboard}</Link>
      </p>
    </section>
  );
}
