/**
 * 「対応の結果を記録する」（SC-02-10。UC-06）。異常・注意の観点のカード・詳細から、データ入力へ、対象の設備を指定して移る
 * （データ入力の設備の初期値は、直前に入力した設備より、リンクで指定した設備を優先する。機能仕様書 3.5）。
 * 正常・不明には出さない（不明のときは、データ入力へ誘導する案内が、別にある）。
 */

import type { ReactNode } from 'react';
import type { EvaluationStatus } from '@smart-farm/shared/constants/status';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';

export function RecordResponseLink(props: {
  readonly status: EvaluationStatus;
  readonly equipmentId: string;
}): ReactNode {
  if (props.status !== 'ERROR' && props.status !== 'CAUTION') {
    return null;
  }
  return (
    <p className="record-response">
      <Link to={PATHS.dataEntryFor(props.equipmentId)}>{MESSAGES.viewpoint.recordResponse}</Link>
    </p>
  );
}
