import { describe, expect, it, vi } from 'vitest';
import { runJobExclusively } from '../../../../src/backend/application/jobs/job-execution.ts';
import type { JobResult, JobRunner } from '../../../../src/backend/application/jobs/job-runner.ts';
import type { JobLockPort } from '../../../../src/backend/application/ports/job-lock-port.ts';
import type { Logger } from '../../../../src/backend/application/ports/logger-port.ts';
import { createControllableClock } from '../../../../src/backend/infrastructure/local/clocks.ts';
import { createInMemoryJobLock } from '../../../../src/backend/infrastructure/local/in-memory-job-lock.ts';

const LEASE_MS = 6 * 60_000;
const DELIVERY: JobResult = {
  jobId: 'JB-04',
  summary: { notificationsProcessed: 1, delivered: 1, failed: 0 },
};

function recordingLogger() {
  const warnings: string[] = [];
  const infos: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: (message) => infos.push(message),
    warn: (message) => warnings.push(message),
    error: () => undefined,
    child: () => logger,
  };
  return { logger, warnings, infos };
}

function setup(run: JobRunner['run'] = () => Promise.resolve(DELIVERY)) {
  const clock = createControllableClock(new Date('2026-10-20T03:00:00.000Z'));
  clock.freeze();
  const runner = { run: vi.fn(run) };
  return { runner, lock: createInMemoryJobLock(clock), ...recordingLogger() };
}

describe('ジョブの排他の実行（Issue #76）', () => {
  it('ロックを取れたら、ジョブを実行して、結果を返す。終わったら、ロックを解放する', async () => {
    const { runner, lock, logger } = setup();

    const first = await runJobExclusively('JB-04', { runner, lock, logger, leaseMs: LEASE_MS });
    const second = await runJobExclusively('JB-04', { runner, lock, logger, leaseMs: LEASE_MS });

    expect(first).toEqual({ outcome: 'EXECUTED', result: DELIVERY });
    expect(second).toEqual({ outcome: 'EXECUTED', result: DELIVERY });
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('同じジョブが実行中なら、実行せずに終える（二重の取り込み・配信を避ける）。別のジョブは、実行できる', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner, lock, logger, infos } = setup(async () => {
      await gate;
      return DELIVERY;
    });
    const deps = { runner, lock, logger, leaseMs: LEASE_MS };

    const running = runJobExclusively('JB-04', deps);
    await vi.waitFor(() => {
      expect(runner.run).toHaveBeenCalledTimes(1);
    });
    const duplicate = await runJobExclusively('JB-04', deps);
    const otherJob = runJobExclusively('JB-03', deps);
    release();

    expect(duplicate).toEqual({ outcome: 'SKIPPED' });
    expect(infos).toContain('前回の実行が続いているため、ジョブを実行しません');
    expect(await running).toMatchObject({ outcome: 'EXECUTED' });
    expect(await otherJob).toMatchObject({ outcome: 'EXECUTED' });
    // 重複した起動は、実行されない（JB-04 が 1 回、JB-03 が 1 回）
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('ジョブが失敗しても、エラーを呼び出し元へ伝え、ロックは解放する（次の実行を、期限まで待たせない）', async () => {
    const { runner, lock, logger } = setup(() => Promise.reject(new Error('一時的な失敗')));
    const deps = { runner, lock, logger, leaseMs: LEASE_MS };

    await expect(runJobExclusively('JB-04', deps)).rejects.toThrow('一時的な失敗');

    runner.run.mockResolvedValueOnce(DELIVERY);
    expect(await runJobExclusively('JB-04', deps)).toMatchObject({ outcome: 'EXECUTED' });
  });

  it('ロックの解放に失敗しても、ジョブの結果（成功）を隠さず、警告を残す', async () => {
    const { runner, logger, warnings } = setup();
    const lock: JobLockPort = {
      tryAcquire: () =>
        Promise.resolve({ release: () => Promise.reject(new Error('解放できない')) }),
    };

    const outcome = await runJobExclusively('JB-04', { runner, lock, logger, leaseMs: LEASE_MS });

    expect(outcome).toEqual({ outcome: 'EXECUTED', result: DELIVERY });
    expect(warnings).toEqual(['ジョブのロックを解放できませんでした']);
  });

  it('ロックの解放に失敗しても、ジョブの失敗は、そのまま伝える（解放の失敗で、置き換えない）', async () => {
    const { runner, logger } = setup(() => Promise.reject(new Error('ジョブの失敗')));
    const lock: JobLockPort = {
      tryAcquire: () =>
        Promise.resolve({ release: () => Promise.reject(new Error('解放できない')) }),
    };

    await expect(
      runJobExclusively('JB-04', { runner, lock, logger, leaseMs: LEASE_MS }),
    ).rejects.toThrow('ジョブの失敗');
  });
});
