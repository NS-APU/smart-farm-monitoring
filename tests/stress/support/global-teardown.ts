/**
 * 負荷テストの終了後の処理: 操作ごとの記録から、結果ログ（test-result/stresstest.result.log）を作る。
 * テストが失敗しても（許容時間の超過を含む）、必ず出力する。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RECORDS_PATH, STRESS_OUTPUT_DIR, type ActionRecord } from './recorder.ts';
import { buildResultLog, type EnvironmentInfo } from './report-log.ts';
import type { SeedSummary } from './seed-data.ts';

export const RESULT_LOG_PATH = 'test-result/stresstest.result.log';

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
  const environment = readJson(`${STRESS_OUTPUT_DIR}/env.json`) as EnvironmentInfo | undefined;
  if (environment === undefined) {
    throw new Error('環境の記録（env.json）がありません');
  }
  const dataset = readJson(`${STRESS_OUTPUT_DIR}/dataset.json`) as SeedSummary | undefined;
  writeFileSync(
    RESULT_LOG_PATH,
    buildResultLog({ records, dataset, environment, finishedAt: new Date().toISOString() }),
    'utf8',
  );
}
