/**
 * スモークテストの終了後の処理: 操作ごとの記録から、結果ログ（test-result/smoketest.result.log）を作る。
 * テストが失敗しても（許容時間の超過を含む）、必ず出力する。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RECORDS_PATH, type ActionRecord } from '../../stress/support/recorder.ts';
import { ENVIRONMENT_PATH, JOB_DURATIONS_PATH } from './global-setup.ts';
import { buildSmokeReport, type JobDurations, type SmokeEnvironmentInfo } from './smoke-report.ts';

export const SMOKE_RESULT_LOG_PATH = 'test-result/smoketest.result.log';

function readJson(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

export default function globalTeardown(): void {
  const records = existsSync(RECORDS_PATH)
    ? readFileSync(RECORDS_PATH, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as ActionRecord)
    : [];
  const environment = readJson(ENVIRONMENT_PATH) as SmokeEnvironmentInfo | undefined;
  if (environment === undefined) {
    throw new Error('環境の記録（env.json）がありません');
  }
  writeFileSync(
    SMOKE_RESULT_LOG_PATH,
    buildSmokeReport({
      records,
      environment,
      jobDurations: (readJson(JOB_DURATIONS_PATH) as JobDurations[] | undefined) ?? [],
      finishedAt: new Date().toISOString(),
    }),
    'utf8',
  );
}
