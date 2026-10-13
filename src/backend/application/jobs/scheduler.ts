/**
 * スケジューラ（ジョブ層。architecture.md 3.2）。
 * 本番は EventBridge が Lambda を起動する。ローカルでは、このスケジューラが時計（ClockPort）に基づいて
 * 実行すべきジョブを判定する。`tick()` を手動・テストから呼び出せる（時計を固定・進行して検証できる）。
 * ジョブの失敗は、他のジョブに影響させない（P-3）。
 */

import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import type { ClockPort } from '../ports/clock-port.ts';
import { errorLogFields } from '../error-fields.ts';
import type { Logger } from '../ports/logger-port.ts';
import { withTimeout } from '../with-timeout.ts';
import type { JobId, JobRunner } from './job-runner.ts';

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

export interface Scheduler {
  /** 実行すべきジョブ（前回の実行から間隔が過ぎたもの）を実行し、実行したジョブの識別子を返す。 */
  tick(): Promise<JobId[]>;
  /** 各ジョブの「前回の実行」を忘れる（開発用のリセット。次の tick で、全ジョブを実行する）。 */
  reset(): void;
  /** 実時間の間隔で tick を繰り返す（ローカルのサーバー用）。 */
  start(tickIntervalMs: number): void;
  stop(): void;
}

/** 1つのジョブの最大の実行時間（ミリ秒）の既定。超えたら、失敗として記録し、次のジョブへ進む。 */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;

export interface SchedulerDeps {
  readonly runner: JobRunner;
  readonly clock: ClockPort;
  readonly plans: readonly SchedulePlan[];
  readonly logger: Logger;
  /**
   * 1つのジョブの最大の実行時間（ミリ秒）。応答しない外部通信などでジョブが終わらなくても、スケジューラ全体
   * （評価・連携・通知の配信）が止まり続けないようにする。省略すると既定（10分）。0 以下なら、設けない。
   */
  readonly jobTimeoutMs?: number;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const jobTimeoutMs = deps.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const lastRunAt = new Map<JobId, number>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  async function tick(): Promise<JobId[]> {
    if (ticking) {
      return [];
    }
    ticking = true;
    const executed: JobId[] = [];
    try {
      for (const plan of deps.plans) {
        const nowMs = deps.clock.now().getTime();
        const last = lastRunAt.get(plan.jobId);
        if (last !== undefined && nowMs - last < plan.intervalMinutes * MS_PER_MINUTE) {
          continue;
        }
        lastRunAt.set(plan.jobId, nowMs);
        executed.push(plan.jobId);
        try {
          await withTimeout(
            () => deps.runner.run(plan.jobId),
            jobTimeoutMs,
            `ジョブ ${plan.jobId}`,
          );
        } catch (error) {
          deps.logger.error('ジョブの実行に失敗しました', {
            jobId: plan.jobId,
            ...errorLogFields(error),
          });
        }
      }
    } finally {
      ticking = false;
    }
    return executed;
  }

  return {
    tick,
    reset() {
      lastRunAt.clear();
    },
    start(tickIntervalMs) {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        void tick();
      }, tickIntervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
