/**
 * 診断メッセージと推奨アクションの文言（純粋関数）。
 * 文言は暫定（Q-010。推奨アクションの内容・提示ルールが未確定）。評価結果ごとに、
 * 判定の根拠となったメトリクスを示す（RQ-009）。変更した判断基準による判定には、その旨を示す（FR-5.8）。
 */

import {
  STATUS_LABELS,
  UNKNOWN_ACTION,
  type EvaluationStatus,
} from '@smart-farm/shared/constants/status';
import { findViewpointMeta, type ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import type { ViewpointDefinition } from './definition.ts';

export { UNKNOWN_ACTION };
export const CUSTOM_CRITERIA_NOTE = 'カスタムの判断基準による判定です';
const NORMAL_ACTION = '現在の状態を維持し、引き続き推移を確認してください';

export interface DiagnosticMessageInput {
  readonly viewpointId: ViewpointId;
  readonly status: EvaluationStatus;
  /** 「不明」の理由（「不明」以外では使わない）。 */
  readonly reason: string;
  /** 判定の根拠（指標ごとの値と判定）。 */
  readonly details: readonly string[];
  readonly isCustomCriteria: boolean;
}

export function buildDiagnosticMessage(input: DiagnosticMessageInput): string {
  const name = findViewpointMeta(input.viewpointId)?.name ?? input.viewpointId;
  const note = input.isCustomCriteria ? ` ${CUSTOM_CRITERIA_NOTE}。` : '';
  if (input.status === 'UNKNOWN') {
    return `${name}: データ不足のため評価できません。${input.reason}${note}`;
  }
  return `${name}: ${STATUS_LABELS[input.status]}。${input.details.join('、')}${note}`;
}

export function buildRecommendedAction(
  definition: ViewpointDefinition,
  status: EvaluationStatus,
): string {
  switch (status) {
    case 'UNKNOWN':
      return UNKNOWN_ACTION;
    case 'NORMAL':
      return NORMAL_ACTION;
    case 'CAUTION':
      return `確認が望ましい状態です。${definition.attentionAction}`;
    case 'ERROR':
      return `対応が必要な状態です。${definition.attentionAction}`;
  }
}
