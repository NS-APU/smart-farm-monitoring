/**
 * ジョブ（JB-01〜JB-04）の Lambda のハンドラ（Issue #76。ADR-0011）。EventBridge のスケジュールが、入力
 * `{ "jobId": "JB-01" }` で起動する。API の Lambda（lambda.ts）と同じ組み立て（コンテナ）を使い、`JobRunner` の同じ入口から実行する。
 * 同じジョブが、すでに実行中なら、何もせずに終わる（DynamoDB のリース式ロック。二重の取り込み・配信を避ける）。
 * ジョブが失敗したら、例外を投げる（CloudWatch のログ・Lambda のエラーの指標に残る。再試行はしない。次の周期で、再び実行される）。
 * 組み立ては、最初の呼び出しで 1 度だけ行い、失敗したときは、次の呼び出しで再試行する（lambda.ts と同じ）。
 */

import { z } from 'zod';
import { errorLogFields } from '../application/error-fields.ts';
import { runJobExclusively, type ExclusiveJobOutcome } from '../application/jobs/job-execution.ts';
import { JOB_LEASE_MS } from '../application/jobs/job-schedule.ts';
import { JOB_IDS, type JobId } from '../application/jobs/job-runner.ts';
import { parseLambdaConfig } from './config.ts';
import { createContainer, type Container } from './container.ts';

const JobEventSchema = z.object({ jobId: z.enum(JOB_IDS) });

/** テストで、組み立てを差し替えるための依存。 */
export interface JobLambdaDeps {
  readonly createContainer?: typeof createContainer;
}

export type JobLambdaResponse = ExclusiveJobOutcome & { readonly jobId: JobId };

export type JobLambdaHandler = (event: unknown) => Promise<JobLambdaResponse>;

export function createJobLambdaHandler(
  env: Readonly<Record<string, string | undefined>>,
  deps: JobLambdaDeps = {},
): JobLambdaHandler {
  const build = deps.createContainer ?? createContainer;
  let ready: Promise<Container> | undefined;

  async function initialize(): Promise<Container> {
    const container = build(parseLambdaConfig(env));
    await container.initialize();
    return container;
  }

  async function containerOf(): Promise<Container> {
    const attempt = (ready ??= initialize());
    try {
      return await attempt;
    } catch (error) {
      // 失敗した Promise を保持しない。次の呼び出しで、初期化をやり直す
      if (ready === attempt) {
        ready = undefined;
      }
      throw error;
    }
  }

  return async (event) => {
    // 入力の値は、IaC が決める。想定外の入力は、内容を出さずに拒否する
    const parsed = JobEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error('ジョブの識別子（jobId）が不正です');
    }
    const { jobId } = parsed.data;
    const container = await containerOf();
    const startedAt = container.clock.now().getTime();
    try {
      const outcome = await runJobExclusively(jobId, {
        runner: container.jobRunner,
        lock: container.jobLock,
        logger: container.logger,
        leaseMs: JOB_LEASE_MS,
      });
      container.logger.info('ジョブを終了しました', {
        jobId,
        outcome: outcome.outcome,
        durationMs: container.clock.now().getTime() - startedAt,
      });
      return { jobId, ...outcome };
    } catch (error) {
      container.logger.error('ジョブの実行に失敗しました', {
        jobId,
        durationMs: container.clock.now().getTime() - startedAt,
        ...errorLogFields(error),
      });
      throw error;
    }
  };
}

export const handler: JobLambdaHandler = createJobLambdaHandler(process.env);
