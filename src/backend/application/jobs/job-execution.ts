/**
 * ジョブを、排他して実行する（Issue #76。ADR-0011）。EventBridge からの起動（Lambda）が使う。
 * 同じジョブが、すでに実行中（ロックを、ほかの実行が持っている）なら、何もせずに終える（二重の取り込み・配信を避ける）。
 * ジョブが失敗しても、ロックは、解放する（次の実行を、期限まで待たせない）。
 */

import { errorLogFields } from '../error-fields.ts';
import type { JobLockPort } from '../ports/job-lock-port.ts';
import type { Logger } from '../ports/logger-port.ts';
import type { JobId, JobResult, JobRunner } from './job-runner.ts';

export type ExclusiveJobOutcome =
  { readonly outcome: 'EXECUTED'; readonly result: JobResult } | { readonly outcome: 'SKIPPED' };

export interface ExclusiveJobDeps {
  readonly runner: JobRunner;
  readonly lock: JobLockPort;
  readonly logger: Logger;
  /** ロックの期限（ミリ秒）。ジョブの最大の実行時間より長くする。 */
  readonly leaseMs: number;
}

export async function runJobExclusively(
  jobId: JobId,
  deps: ExclusiveJobDeps,
): Promise<ExclusiveJobOutcome> {
  const lease = await deps.lock.tryAcquire(`job:${jobId}`, deps.leaseMs);
  if (lease === null) {
    deps.logger.info('前回の実行が続いているため、ジョブを実行しません', { jobId });
    return { outcome: 'SKIPPED' };
  }
  try {
    return { outcome: 'EXECUTED', result: await deps.runner.run(jobId) };
  } finally {
    try {
      await lease.release();
    } catch (error) {
      // 解放の失敗で、ジョブの結果（成功・失敗）を隠さない。ロックは、期限が過ぎれば、取れる
      deps.logger.warn('ジョブのロックを解放できませんでした', { jobId, ...errorLogFields(error) });
    }
  }
}
