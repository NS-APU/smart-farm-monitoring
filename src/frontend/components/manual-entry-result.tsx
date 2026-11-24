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
import { Icon } from './icon.tsx';
import { StatusBadge } from './status-badge.tsx';

/** 結果の種類（保存〔SC-06〕・修正・削除〔SC-07〕）。説明の文と、一覧へのリンクの有無を決める。 */
export type ManualEntryResultKind = 'saved' | 'updated' | 'deleted';

/** 評価の状態（DONE: 更新した／DEFERRED: 定期の評価で更新する）ごとの、説明の文。 */
const LEADS = {
  saved: { done: MESSAGES.entry.savedLead, deferred: MESSAGES.entry.savedLeadDeferred },
  updated: { done: MESSAGES.entries.updatedLead, deferred: MESSAGES.entries.updatedLeadDeferred },
  deleted: { done: MESSAGES.entries.deletedLead, deferred: MESSAGES.entries.deletedLeadDeferred },
} as const;

/** 自動取り込みの値を使うため、使われない評価の期間の呼び方（短期視点、長期視点〔当日・直近 N 日〕）。 */
function periodLabel(period: ManualEntryItemUsage['autoPriorityPeriods'][number]): string {
  return period.periodDays === null
    ? MESSAGES.entry.usageShort
    : MESSAGES.entry.usageLong(MESSAGES.dashboard.periodDays[period.periodDays]);
}

/** 項目ごとの説明。評価に使われる期間がなければ、「この期間は…使われません」。一部の期間だけなら、その期間を示す。 */
function usageText(usage: ManualEntryItemUsage): string {
  const label = findItemDefinition(usage.itemKey)?.label ?? usage.itemKey;
  const reason = usage.used
    ? MESSAGES.entry.usagePartial(usage.autoPriorityPeriods.map(periodLabel).join('・'))
    : MESSAGES.entry.usageNotUsed;
  return `${label}: ${reason}`;
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
        {response.evaluation === 'DEFERRED' ? lead.deferred : lead.done}
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
              <StatusBadge status={item.status} />
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
