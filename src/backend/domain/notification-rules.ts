/**
 * 通知の規則（FR-7.1, FR-7.3、architecture.md 8章。純粋関数）。
 * - 観点のステータスが「注意」「異常」に変わったときに通知する。同じ状態が続く間は繰り返さない
 * - 「不明」は通知しない（暫定。Q-010, Q-011）
 * - 重複抑制のキーは、観点・対象・ステータス
 */

import { STATUS_LABELS, type EvaluationStatus } from '@smart-farm/shared/constants/status';
import { MS_PER_MINUTE } from '@smart-farm/shared/time';

/** 同じ重複抑制のキーの通知を繰り返さない期間（分）。暫定（dev_spec.md 4章）。 */
export const DEFAULT_SUPPRESSION_MINUTES = 60;

/** 直前の最終ステータスと比べて、通知すべき変化か。 */
export function isNotifiableTransition(
  previous: EvaluationStatus | null,
  next: EvaluationStatus,
): boolean {
  return (next === 'CAUTION' || next === 'ERROR') && previous !== next;
}

export function buildStatusChangeDedupKey(
  viewpointId: string,
  equipmentId: string,
  status: EvaluationStatus,
): string {
  return `STATUS_CHANGE#${viewpointId}#${equipmentId}#${status}`;
}

/** 取り込みの通知の状況: FAILURE（取り込みの失敗）／STOPPED（新しいデータが届かない。無音の停止）。 */
export type IngestionNotificationSituation = 'FAILURE' | 'STOPPED';

export function buildIngestionFailureDedupKey(
  sourceId: string,
  situation: IngestionNotificationSituation = 'FAILURE',
): string {
  // 失敗の通知のキーは、従来のまま（保存済みの通知との重複抑制を保つ）
  return situation === 'FAILURE'
    ? `INGESTION_FAILURE#${sourceId}`
    : `INGESTION_STOPPED#${sourceId}`;
}

/** 抑制の期間内か（直近の同じキーの通知の日時から、抑制の期間が過ぎていなければ true）。 */
export function isWithinSuppression(
  lastCreatedAt: Date | null,
  now: Date,
  suppressionMinutes: number,
): boolean {
  if (lastCreatedAt === null) {
    return false;
  }
  return now.getTime() - lastCreatedAt.getTime() < suppressionMinutes * MS_PER_MINUTE;
}

export interface StatusChangeMessageInput {
  readonly viewpointName: string;
  readonly equipmentName: string;
  readonly status: EvaluationStatus;
  readonly diagnosticMessage: string;
}

/** 通知には、ステータス・観点名・対象の設備・診断メッセージを含める（FR-7.1）。 */
export function buildStatusChangeMessage(input: StatusChangeMessageInput): string {
  return `【${STATUS_LABELS[input.status]}】${input.viewpointName}（${input.equipmentName}）: ${input.diagnosticMessage}`;
}

export function buildIngestionFailureMessage(
  sourceName: string,
  reason: string,
  situation: IngestionNotificationSituation = 'FAILURE',
): string {
  const label = situation === 'FAILURE' ? 'データ取得失敗' : 'データ取得停止';
  return `【${label}】${sourceName}: ${reason}`;
}
