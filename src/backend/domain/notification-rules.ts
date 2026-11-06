/**
 * 通知の規則（FR-7.1, FR-7.3、architecture.md 8章、ADR-0019。純粋関数）。
 * - 観点のステータスが「注意」「異常」に悪化したときに通知する。改善（異常 → 注意）は通知しない（D-42）
 * - 「不明」は通知せず、状態の変化とみなさない（直前の「不明でない」状態と比べる。D-37）
 * - 「正常が一定時間（既定 15 分）続いたあとの悪化」を、新しい出来事として通知する。短い行き来は、同じ出来事（D-38）。
 *   同じ出来事の中では、それまでに通知した重大度より重いときだけ通知する
 * - 取り込みの失敗・停止の通知は、同じ取り込み元・状況について、60 分に 1 件（D-38）
 */

import { STATUS_LABELS, type EvaluationStatus } from '@smart-farm/shared/constants/status';
import { MS_PER_MINUTE } from '@smart-farm/shared/time';

/** 同じ重複抑制のキーの通知を繰り返さない期間（分）。取り込みの失敗・停止、連携の期限切れの通知に使う（D-38）。 */
export const DEFAULT_SUPPRESSION_MINUTES = 60;

/**
 * 「正常が続いたあとの悪化」を、新しい出来事とみなす、正常が続いた時間（分）の既定。評価の周期（5 分）の 3 回分（D-38）。
 */
export const DEFAULT_RECURRENCE_AFTER_NORMAL_MINUTES = 15;

/** 状態の変化の履歴の 1 件（古い順に並べる。changedAt は ISO 8601）。 */
export interface StatusHistoryEntry {
  readonly status: EvaluationStatus;
  readonly changedAt: string;
}

export interface StatusChangeDecisionInput {
  /** 観点の最終ステータスの変化の履歴（古い順。「不明」を含んでよい。今回の変化は含めない）。 */
  readonly history: readonly StatusHistoryEntry[];
  /** 新しいステータス。 */
  readonly next: EvaluationStatus;
  /** 変化した日時（いま）。 */
  readonly now: Date;
  /** 正常が、この時間（分）以上続いたあとの悪化を、新しい出来事とみなす。 */
  readonly recurrenceMinutes?: number;
}

/** 重大度（通知するかの比較に使う）。「注意」より「異常」が重い。 */
const SEVERITY: Readonly<Record<EvaluationStatus, number>> = {
  UNKNOWN: 0,
  NORMAL: 0,
  CAUTION: 1,
  ERROR: 2,
};

/**
 * 状態の変化を、通知するか（Issue #236。D-37・D-38・D-42）。履歴から、「不明」を除いた時系列で判定する。
 * - 通知の対象は、新しいステータスが「注意」「異常」で、直前（「不明」を除く）より悪化したときだけ。履歴がなければ、通知する
 * - 直前が「正常」で、正常が `recurrenceMinutes` 以上続いていれば、新しい出来事として通知する
 * - それ以外は、同じ出来事の中の変化。出来事の区切りは、`recurrenceMinutes` 以上続いた正常。
 *   この出来事で、すでに、同じか、より重い重大度に達していれば、通知しない（行き来を繰り返さない）
 */
export function isNotifiableStatusChange(input: StatusChangeDecisionInput): boolean {
  const { next, now } = input;
  if (next !== 'CAUTION' && next !== 'ERROR') {
    return false;
  }
  const recurrenceMs =
    (input.recurrenceMinutes ?? DEFAULT_RECURRENCE_AFTER_NORMAL_MINUTES) * MS_PER_MINUTE;
  const timeline = input.history
    .filter((entry) => entry.status !== 'UNKNOWN')
    .map((entry) => ({ status: entry.status, at: Date.parse(entry.changedAt) }))
    .sort((left, right) => left.at - right.at);
  const last = timeline.at(-1);
  if (last === undefined) {
    return true;
  }
  if (last.status === 'NORMAL' && now.getTime() - last.at >= recurrenceMs) {
    return true;
  }

  // いまの出来事で、すでに達した最も重い重大度を求める（新しい方から、出来事の区切りまでさかのぼる）
  let reached = 0;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    const following = timeline[index + 1];
    if (entry === undefined) {
      break;
    }
    if (entry.status === 'NORMAL') {
      // この正常が、一定時間以上続いたあとに悪化していれば、ここが出来事の区切り
      if (following !== undefined && following.at - entry.at >= recurrenceMs) {
        break;
      }
      continue;
    }
    reached = Math.max(reached, SEVERITY[entry.status]);
  }
  return SEVERITY[next] > reached;
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

/** 連携の期限切れの通知の重複抑制のキー（種類ごとに 1 つ。60 分に 1 件）。 */
export function buildFederationExpiredDedupKey(): string {
  return 'FEDERATION_EXPIRED';
}

/** 連携の期限切れの通知の本文。件数は含めない（抑制の間の分は、連携のログに残るため）。 */
export function buildFederationExpiredMessage(expiryDays: number): string {
  return `【連携の期限切れ】農業情報基盤に ${String(expiryDays)} 日以上送れなかった項目を、破棄しました。連携のログを確認してください`;
}

export function buildIngestionFailureMessage(
  sourceName: string,
  reason: string,
  situation: IngestionNotificationSituation = 'FAILURE',
): string {
  const label = situation === 'FAILURE' ? 'データ取得失敗' : 'データ取得停止';
  return `【${label}】${sourceName}: ${reason}`;
}
