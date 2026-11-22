/**
 * 指標の名前と、ヘルプヒント（用語辞書。`shared/constants/metrics.ts` の表示名・説明。Issue #154）。
 * 説明のない指標は、名前だけを示す。
 */

import type { ReactNode } from 'react';
import { getMetricMeta } from '@smart-farm/shared/constants/metrics';
import { HelpHint } from './help-hint.tsx';

export function MetricLabel(props: { readonly metricId: string }): ReactNode {
  const { label, help } = getMetricMeta(props.metricId);
  return (
    <>
      {label}
      {help === undefined ? null : <HelpHint name={label} help={help} />}
    </>
  );
}
