/**
 * 手動入力の保存後の結果: 保存の結果と、更新後の関連観点のステータス（FR-4.1.5）。
 * 結果の通知（`ResultNotice`）と同じく、`role="status"` で読み上げ、表示されたとき（保存のたび）に、画面内へスクロールする。フォーカスは動かさない（Issue #150。SC-06-3）。
 */

import type { ReactNode } from 'react';
import type { ManualEntrySaveResponse } from '@smart-farm/shared/schemas/manual-entry';
import { useRevealOnChange } from '../hooks/use-reveal-on-change.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';
import { StatusBadge } from './status-badge.tsx';

export function ManualEntryResult(props: {
  readonly response: ManualEntrySaveResponse;
  readonly title: string;
}): ReactNode {
  const { response } = props;
  // 保存のたびに、新しい応答の object になる。同じ応答のままの描き直しでは、スクロールしない
  const ref = useRevealOnChange<HTMLElement>(response);
  return (
    <section
      ref={ref}
      role="status"
      className="panel entry-result"
      aria-labelledby="entry-result-heading"
      data-testid="entry-result"
    >
      <h2 id="entry-result-heading">{props.title}</h2>
      <p data-testid="entry-lead">
        {response.evaluation === 'DEFERRED'
          ? MESSAGES.entry.savedLeadDeferred
          : MESSAGES.entry.savedLead}
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
        <Link to={PATHS.dataEntryList}>{MESSAGES.entry.goList}</Link>
        <Link to={PATHS.dashboard}>{MESSAGES.entry.goDashboard}</Link>
      </p>
    </section>
  );
}
