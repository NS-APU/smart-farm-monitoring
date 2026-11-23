/**
 * 手動入力の保存・修正・削除の後の結果: 結果と、更新後の関連観点のステータス（FR-4.1.5。修正・削除の後も同じ。D-27）。
 * 結果の通知（`ResultNotice`）と同じく、`role="status"` で読み上げ、表示されたとき（保存のたび）に、画面内へスクロールする。フォーカスは動かさない（Issue #150。SC-06-3）。
 */

import type { ReactNode } from 'react';
import type { ManualEntrySaveResponse } from '@smart-farm/shared/schemas/manual-entry';
import { useRevealOnChange } from '../hooks/use-reveal-on-change.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';
import { StatusBadge } from './status-badge.tsx';

/** 結果の種類（保存〔SC-06〕・修正・削除〔SC-07〕）。説明の文と、一覧へのリンクの有無を決める。 */
export type ManualEntryResultKind = 'saved' | 'updated' | 'deleted';

/** 評価の状態（DONE: 更新した／DEFERRED: 定期の評価で更新する）ごとの、説明の文。 */
const LEADS = {
  saved: { done: MESSAGES.entry.savedLead, deferred: MESSAGES.entry.savedLeadDeferred },
  updated: { done: MESSAGES.entries.updatedLead, deferred: MESSAGES.entries.updatedLeadDeferred },
  deleted: { done: MESSAGES.entries.deletedLead, deferred: MESSAGES.entries.deletedLeadDeferred },
} as const;

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
