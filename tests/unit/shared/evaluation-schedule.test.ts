/**
 * 評価の更新の間隔と、「評価が更新されていない」の基準（Issue #158。SC-02-6。ADR-0014・ADR-0011）の単体テスト。
 */

import { describe, expect, it } from 'vitest';
import {
  EVALUATION_INTERVAL_MINUTES,
  EVALUATION_STALE_AFTER_INTERVALS,
  EVALUATION_STALE_MINUTES,
  isEvaluationStale,
} from '@smart-farm/shared/constants/evaluation-schedule';
import { DEFAULT_SCHEDULE } from '../../../src/backend/application/jobs/job-schedule.ts';

const MINUTE_MS = 60_000;
const EVALUATED_AT = '2026-10-09T03:00:00.000Z';
const evaluatedMs = Date.parse(EVALUATED_AT);

describe('評価の更新の間隔の定数', () => {
  it('評価の間隔は、評価のジョブ（JB-02）の実行間隔と同じ（ジョブの間隔を変えたら、ここも変える）', () => {
    const plan = DEFAULT_SCHEDULE.find((item) => item.jobId === 'JB-02');
    expect(plan?.intervalMinutes).toBe(EVALUATION_INTERVAL_MINUTES);
  });

  it('「更新されていない」の基準は、評価の間隔 × 3 回分（15 分）', () => {
    expect(EVALUATION_STALE_AFTER_INTERVALS).toBe(3);
    expect(EVALUATION_STALE_MINUTES).toBe(EVALUATION_INTERVAL_MINUTES * 3);
    expect(EVALUATION_STALE_MINUTES).toBe(15);
  });
});

describe('isEvaluationStale（評価が更新されていないか）', () => {
  it('基準（15 分）に満たなければ、更新されている（14 分 59 秒）', () => {
    expect(isEvaluationStale(EVALUATED_AT, new Date(evaluatedMs + 15 * MINUTE_MS - 1000))).toBe(
      false,
    );
  });

  it('ちょうど 15 分で、更新されていない（以上）', () => {
    expect(isEvaluationStale(EVALUATED_AT, new Date(evaluatedMs + 15 * MINUTE_MS))).toBe(true);
  });

  it('15 分を超えれば、更新されていない', () => {
    expect(isEvaluationStale(EVALUATED_AT, new Date(evaluatedMs + 16 * MINUTE_MS))).toBe(true);
  });

  it('評価の直後・評価の日時より前の時刻（端末の時計のずれ）は、更新されている', () => {
    expect(isEvaluationStale(EVALUATED_AT, new Date(evaluatedMs))).toBe(false);
    expect(isEvaluationStale(EVALUATED_AT, new Date(evaluatedMs - 5 * MINUTE_MS))).toBe(false);
  });

  it('評価がまだない（null）・日時として読めない値は、判定しない（警告を出さない）', () => {
    const now = new Date(evaluatedMs + 60 * MINUTE_MS);
    expect(isEvaluationStale(null, now)).toBe(false);
    expect(isEvaluationStale('not-a-date', now)).toBe(false);
  });
});
