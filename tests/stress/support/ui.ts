/**
 * 負荷テストの画面操作・API 呼び出しの補助。画面の文言・要素は、tests/e2e/support/ と同じもの（画面の仕様変更時は、同じ箇所を直す）。
 */

import { mkdirSync } from 'node:fs';
import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import { LoginResponseSchema } from '../../../src/shared/schemas/auth.ts';
import { STRESS_OUTPUT_DIR } from './recorder.ts';
import { createObservedAtSource, jstInput } from './observed-at.ts';
import { STRESS_USER_PASSWORD } from './scale.ts';

export const SCREENSHOT_DIR = `${STRESS_OUTPUT_DIR}/screenshots`;

export const mainArea = (page: Page): Locator => page.getByRole('main');

/** 読み込み中の表示（画面の本文）。 */
export const loadingView = (page: Page): Locator => page.locator('main [role="status"].state-view');

/** ダッシュボードの表示が完了している（読み込み中の表示がなく、観点の状態の集計と、観点のカードが表示されている）。 */
export async function expectDashboardShown(page: Page, equipmentName?: string): Promise<void> {
  if (equipmentName !== undefined) {
    await expect(page.locator('.page-meta strong').first()).toHaveText(equipmentName);
  }
  await expect(loadingView(page)).toHaveCount(0);
  await expect(page.getByTestId('summary-NORMAL')).toBeVisible();
  await expect(page.locator('.viewpoint-card').first()).toBeVisible();
}

/** 観点の詳細の表示が完了している（診断結果・根拠のメトリクス・推移・元データ）。 */
export async function expectDetailShown(page: Page): Promise<void> {
  await expect(loadingView(page)).toHaveCount(0);
  await expect(page.getByTestId('diagnosis')).toBeVisible();
  await expect(page.getByTestId('basis')).toBeVisible();
  await expect(page.getByTestId('trend')).toBeVisible();
  await expect(page.getByTestId('source-data')).toBeVisible();
}

export { jstInput };

const observedAtSource = createObservedAtSource(Date.now(), 20);

/** 手動入力の計測日時（現在より前）。呼ぶたびに、1分ずつ遡り、同じ設備・項目・日時の重複（409）を避ける。基準の時刻は、最初に固定する。 */
export function nextObservedAt(): string {
  return observedAtSource();
}

/** 画面の全体のスクリーンショット（大量データ表示時のレイアウトの目視確認用）。 */
export async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}

/** ログイン画面から、ユーザーIDとパスワードを入力する（送信は、計測の対象として、呼び出し側が行う）。 */
export async function fillLogin(page: Page, userId: string): Promise<void> {
  await page.getByLabel('ユーザーID').fill(userId);
  await page.getByLabel('パスワード').fill(STRESS_USER_PASSWORD);
}

// API（開発用 API・計測の対象でない前提の用意）

const TOKENS = new WeakMap<APIRequestContext, Map<string, string>>();

export async function accessToken(request: APIRequestContext, userId: string): Promise<string> {
  const cached = TOKENS.get(request)?.get(userId);
  if (cached !== undefined) {
    return cached;
  }
  const login = await request.post('/api/v1/auth/login', {
    data: { userId, password: STRESS_USER_PASSWORD },
    headers: { 'x-forwarded-for': `10.0.0.${String(Math.floor(Math.random() * 250) + 1)}` },
  });
  expect(login.ok(), 'API のログイン').toBe(true);
  const { accessToken: token } = LoginResponseSchema.parse(await login.json());
  const tokens = TOKENS.get(request) ?? new Map<string, string>();
  tokens.set(userId, token);
  TOKENS.set(request, tokens);
  return token;
}

export async function api(
  request: APIRequestContext,
  userId: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<APIResponse> {
  return request.fetch(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${await accessToken(request, userId)}` },
    ...(body === undefined ? {} : { data: body }),
  });
}

/** 開発用 API のジョブの起動。かかった時間（ミリ秒）を返す。 */
export async function runJob(
  request: APIRequestContext,
  userId: string,
  jobId: 'JB-01' | 'JB-02' | 'JB-03' | 'JB-04',
): Promise<number> {
  const started = performance.now();
  const response = await api(request, userId, 'POST', `/dev/jobs/${jobId}/run`, {});
  expect(response.ok(), `ジョブ ${jobId}: ${String(response.status())}`).toBe(true);
  return Math.round(performance.now() - started);
}

export async function setMock(
  request: APIRequestContext,
  userId: string,
  target: 'file-server' | 'federation' | 'web-push',
  mode: 'UP' | 'DOWN' | 'SLOW' | 'REJECT',
): Promise<void> {
  const response = await api(request, userId, 'PUT', `/dev/mocks/${target}`, { mode });
  expect(response.ok(), `モック ${target}: ${String(response.status())}`).toBe(true);
}
