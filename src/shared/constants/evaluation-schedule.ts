/**
 * 評価の更新の間隔と、「評価が更新されていない」の基準（Issue #158。SC-02-6。ADR-0011・ADR-0014）。
 * 評価（JB-02）は、5 分ごとの定期の評価が、すべての設備の結果を保存し直す。評価のジョブが止まると、ダッシュボードの
 * 古い状態が、現在のものに見えるため、評価の日時が、間隔の 3 回分以上更新されていなければ、警告を出す。
 */

import { MS_PER_MINUTE } from '../time.ts';

/**
 * 評価の更新の間隔（分）。評価のジョブ（JB-02）の実行間隔（`DEFAULT_SCHEDULE`。src/backend/application/jobs/job-schedule.ts）と同じ値にする
 * （IaC が job-schedule.ts を直接読み込むため、共有の定数からは参照できない。2 つが一致することは、単体テストで確かめる）。
 */
export const EVALUATION_INTERVAL_MINUTES = 5;

/** 「評価が更新されていない」とみなす、更新されなかった評価の回数（通知の「正常が続いた時間」〔評価の周期の 3 回分。D-38〕と同じ考え方）。 */
export const EVALUATION_STALE_AFTER_INTERVALS = 3;

/** 「評価が更新されていない」の基準（分）。評価の間隔 × 3 回分（5 分 × 3 = 15 分）。 */
export const EVALUATION_STALE_MINUTES =
  EVALUATION_INTERVAL_MINUTES * EVALUATION_STALE_AFTER_INTERVALS;

/**
 * 評価が更新されていないか（最終の評価の日時から、基準〔15 分〕以上たっているか）。
 * 評価がまだない（null）・日時として読めない場合は、判定しない（false）。現在が、評価の日時より前（端末の時計のずれ）でも、false。
 */
export function isEvaluationStale(evaluatedAt: string | null, now: Date): boolean {
  if (evaluatedAt === null) {
    return false;
  }
  const evaluatedMs = Date.parse(evaluatedAt);
  if (Number.isNaN(evaluatedMs)) {
    return false;
  }
  return now.getTime() - evaluatedMs >= EVALUATION_STALE_MINUTES * MS_PER_MINUTE;
}
