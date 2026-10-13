/**
 * 非同期・定期処理（ジョブ）の実行（functional-specification.md 5章の JB-01〜JB-04）。
 * スケジューラ（EventBridge、ローカルのスケジューラ、テスト、開発用 API）から、同じ入口で起動する。
 * 各ジョブは、同じ契機が重複しても結果が変わらない（冪等）ように実装する。
 */

import type { EvaluationRunSummary, EvaluationService } from '../evaluation/evaluation-service.ts';
import type { FederationRunSummary, FederationService } from '../federation/federation-service.ts';
import type { IngestionRunSummary, IngestionService } from '../ingestion/ingestion-service.ts';
import type {
  DeliveryRunSummary,
  NotificationService,
} from '../notification/notification-service.ts';

export const JOB_IDS = ['JB-01', 'JB-02', 'JB-03', 'JB-04'] as const;
export type JobId = (typeof JOB_IDS)[number];

export type JobResult =
  | { readonly jobId: 'JB-01'; readonly summaries: readonly IngestionRunSummary[] }
  | { readonly jobId: 'JB-02'; readonly summary: EvaluationRunSummary }
  | { readonly jobId: 'JB-03'; readonly summary: FederationRunSummary }
  | { readonly jobId: 'JB-04'; readonly summary: DeliveryRunSummary };

export interface JobRunner {
  run(jobId: JobId): Promise<JobResult>;
}

export interface JobRunnerDeps {
  readonly ingestion: IngestionService;
  readonly evaluation: EvaluationService;
  readonly federation: FederationService;
  readonly notifications: NotificationService;
}

export function isJobId(value: string): value is JobId {
  return (JOB_IDS as readonly string[]).includes(value);
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  return {
    async run(jobId) {
      switch (jobId) {
        case 'JB-01':
          return { jobId, summaries: await deps.ingestion.runDueSources() };
        case 'JB-02':
          return { jobId, summary: await deps.evaluation.evaluateAll('SCHEDULED') };
        case 'JB-03':
          return { jobId, summary: await deps.federation.runPending() };
        case 'JB-04':
          return { jobId, summary: await deps.notifications.deliverPending() };
      }
    },
  };
}
