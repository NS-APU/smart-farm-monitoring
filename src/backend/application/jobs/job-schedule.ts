/**
 * ジョブの実行間隔と、Lambda での実行の時間の定数。ローカルのスケジューラ（scheduler.ts）と、IaC（EventBridge のスケジュール。
 * infra/lib/evaluation-stack.ts）が、同じ値を使う（Issue #76）。IaC から読み込まれるため、依存を持たない。
 */

import type { JobId } from './job-runner.ts';

export interface SchedulePlan {
  readonly jobId: JobId;
  readonly intervalMinutes: number;
}

/**
 * 既定の実行間隔（暫定）。JB-01 は、取り込み元ごとの取得間隔を、ジョブの中で判定する。
 * JB-02 は、データの途絶を「不明」へ反映するための定期の評価。
 */
export const DEFAULT_SCHEDULE: readonly SchedulePlan[] = [
  { jobId: 'JB-01', intervalMinutes: 1 },
  { jobId: 'JB-02', intervalMinutes: 5 },
  { jobId: 'JB-03', intervalMinutes: 5 },
  { jobId: 'JB-04', intervalMinutes: 1 },
];

/** ジョブの Lambda のタイムアウト（秒）の初期値。実行時間の実測による調整は、Issue #79。 */
export const JOB_LAMBDA_TIMEOUT_SECONDS = 300;

/**
 * ジョブのロックの期限（ミリ秒）。Lambda のタイムアウトより長くする（実行中に、期限が切れて、次の実行が始まらないように）。
 * 実行が異常終了して、ロックが解放されなくても、この時間が過ぎれば、次の実行が取れる。
 */
export const JOB_LEASE_MS = (JOB_LAMBDA_TIMEOUT_SECONDS + 60) * 1000;
