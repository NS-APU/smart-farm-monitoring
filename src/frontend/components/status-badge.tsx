/** ステータスの表示。色・アイコン・文字で示し、色だけに頼らない（NFR-7.2）。 */

import type { ReactNode } from 'react';
import {
  STATUS_ICONS,
  STATUS_LABELS,
  type EvaluationStatus,
} from '@smart-farm/shared/constants/status';

export function StatusBadge(props: { readonly status: EvaluationStatus }): ReactNode {
  const { status } = props;
  return (
    <span className={`status-badge status-${status.toLowerCase()}`}>
      <span aria-hidden="true">{STATUS_ICONS[status]}</span>
      <span>{STATUS_LABELS[status]}</span>
    </span>
  );
}
