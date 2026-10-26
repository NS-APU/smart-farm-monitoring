/** ステータスの表示。色・形（アイコン）・塗り方・文字で示し、色だけに頼らない（NFR-7.2）。 */

import type { ReactNode } from 'react';
import { STATUS_LABELS, type EvaluationStatus } from '@smart-farm/shared/constants/status';
import { Icon, STATUS_ICON } from './icon.tsx';

export function StatusBadge(props: { readonly status: EvaluationStatus }): ReactNode {
  const { status } = props;
  return (
    <span className={`status-badge status-${status.toLowerCase()}`}>
      <Icon name={STATUS_ICON[status]} size={16} />
      <span>{STATUS_LABELS[status]}</span>
    </span>
  );
}
