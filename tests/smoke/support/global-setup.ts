/**
 * スモークテストの開始前の処理: 前回の記録を消し、実行した端末の環境（OS・Node・ブラウザ）を記録する。
 * 接続先・認証情報の環境変数が足りなければ、ここで、分かりやすいエラーにする（パスワードは出力しない）。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { release, type } from 'node:os';
import { chromium } from '@playwright/test';
import { RECORDS_PATH, STRESS_OUTPUT_DIR } from '../../stress/support/recorder.ts';
import type { SmokeEnvironmentInfo } from './smoke-report.ts';
import { readSmokeEnv } from './smoke-env.ts';

export const JOB_DURATIONS_PATH = `${STRESS_OUTPUT_DIR}/job-durations.json`;
export const ENVIRONMENT_PATH = `${STRESS_OUTPUT_DIR}/env.json`;

export default async function globalSetup(): Promise<void> {
  readSmokeEnv();
  mkdirSync(STRESS_OUTPUT_DIR, { recursive: true });
  rmSync(RECORDS_PATH, { force: true });
  rmSync(JOB_DURATIONS_PATH, { force: true });
  const browser = await chromium.launch();
  const browserVersion = browser.version();
  await browser.close();
  const environment: SmokeEnvironmentInfo = {
    startedAt: new Date().toISOString(),
    os: `${type()} ${release()}（${process.platform} ${process.arch}）`,
    node: process.version,
    browser: `Chromium ${browserVersion}`,
    playwright: '1.64',
  };
  writeFileSync(ENVIRONMENT_PATH, JSON.stringify(environment, null, 2), 'utf8');
}
