/**
 * 通知の経過・回復日時の導出（Issue #238。ADR-0019 の D-42。純粋関数）。
 * 通知の時点から、同じ観点・設備の次の通知（なければ現在）までの、状態の変化（経過）と、最初に「正常」に戻った日時（回復日時）を、
 * 状態の変化の履歴から導出する。新しい保存はなく、これまでの通知にも使える。「不明」は、状態の変化とみなさず、経過に出さない（D-37）。
 */

import type { EvaluationStatus } from '@smart-farm/shared/constants/status';
import type { NotificationProgress } from '@smart-farm/shared/schemas/notification';
import type { StatusHistoryEntry } from './notification-rules.ts';

export interface NotificationProgressInput {
  /** 通知の対象の観点・設備の、最終ステータスの変化の履歴（順不同でよい。「不明」を含んでよい）。 */
  readonly history: readonly StatusHistoryEntry[];
  /** 通知の作成日時。 */
  readonly notifiedAt: Date;
  /** 同じ観点・設備の、次の通知の作成日時。なければ null（現在まで）。 */
  readonly nextNotifiedAt: Date | null;
  /** 現在。 */
  readonly now: Date;
}

/**
 * 通知の経過・回復日時を求める。通知の時点の状態（通知の作成日時以前で、最後の「不明でない」変化）が履歴になければ、
 * 経過を示せないため、null を返す（設備を削除して、履歴がない、など）。
 */
export function buildNotificationProgress(
  input: NotificationProgressInput,
): NotificationProgress | null {
  const timeline = input.history
    .filter(
      (entry): entry is StatusHistoryEntry & { status: EvaluationStatus } =>
        entry.status !== 'UNKNOWN',
    )
    .map((entry) => ({
      status: entry.status,
      changedAt: entry.changedAt,
      at: Date.parse(entry.changedAt),
    }))
    .sort((left, right) => left.at - right.at);

  // 通知の時点の状態: 通知の作成日時以前で、最後の変化（通知の作成は、変化の記録のあとのため、変化の日時のほうが、わずかに早いことがある）
  let startIndex = -1;
  for (let index = 0; index < timeline.length; index += 1) {
    if ((timeline[index]?.at ?? Infinity) <= input.notifiedAt.getTime()) {
      startIndex = index;
    }
  }
  const start = timeline[startIndex];
  if (start === undefined) {
    return null;
  }

  const endMs = (input.nextNotifiedAt ?? input.now).getTime();
  const changes: { status: EvaluationStatus; changedAt: string }[] = [
    { status: start.status, changedAt: start.changedAt },
  ];
  for (const entry of timeline.slice(startIndex + 1)) {
    if (entry.at > endMs) {
      break;
    }
    // 同じ状態が続くもの（不明を挟んだ継続を含む）は、まとめる
    if (changes.at(-1)?.status !== entry.status) {
      changes.push({ status: entry.status, changedAt: entry.changedAt });
    }
  }

  const recovered = changes.slice(1).find((change) => change.status === 'NORMAL');
  return {
    changes,
    recovery:
      recovered === undefined
        ? null
        : {
            recoveredAt: recovered.changedAt,
            elapsedSeconds: Math.max(
              0,
              Math.floor((Date.parse(recovered.changedAt) - start.at) / 1000),
            ),
          },
  };
}
