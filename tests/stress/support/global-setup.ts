/**
 * 負荷テストの開始前の処理: 前回の記録を消し、環境（OS・Node・CPU・メモリ・ブラウザ）を記録する。
 * 結果ログの組み立ては、終了後（global-teardown.ts）。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem, type } from 'node:os';
import { chromium } from '@playwright/test';
import type { EnvironmentInfo } from './report-log.ts';
import { RECORDS_PATH, STRESS_OUTPUT_DIR } from './recorder.ts';

const BYTES_PER_GIB = 1024 ** 3;

export default async function globalSetup(): Promise<void> {
  mkdirSync(STRESS_OUTPUT_DIR, { recursive: true });
  rmSync(RECORDS_PATH, { force: true });
  rmSync(`${STRESS_OUTPUT_DIR}/screenshots`, { recursive: true, force: true });
  const browser = await chromium.launch();
  const browserVersion = browser.version();
  await browser.close();
  const processors = cpus();
  const environment: EnvironmentInfo = {
    startedAt: new Date().toISOString(),
    os: `${type()} ${release()}（${process.platform} ${process.arch}）`,
    node: process.version,
    cpu: processors[0]?.model.trim() ?? '不明',
    cpuCores: processors.length,
    memoryGiB: totalmem() / BYTES_PER_GIB,
    browser: `Chromium ${browserVersion}`,
    playwright: '1.64',
    frontend: 'Vite の本番ビルド（vite build）を vite preview で配信',
    backend: 'Node + Hono（本番と同じアプリ。メモリ上のデータ・モックの外部サービス。1プロセス）',
  };
  writeFileSync(`${STRESS_OUTPUT_DIR}/env.json`, JSON.stringify(environment, null, 2), 'utf8');
}
