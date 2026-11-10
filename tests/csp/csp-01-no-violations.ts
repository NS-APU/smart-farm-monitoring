/**
 * 画面の CSP の確認（Issue #127。`pnpm test:csp`）。本番と同じ成果物（vite build）の画面に、CloudFront の応答ヘッダーポリシーと同じ CSP
 * （infra/lib/content-security-policy.ts）を付けて、主な画面を一巡し、CSP の違反が出ないことを確かめる。
 *
 * - CSP は、画面（HTML）の応答に付ける（CloudFront が、静的配信の応答に付けるのと同じ）。API・画面のファイル・サービスワーカーも、通常どおり動く
 * - 違反は、ブラウザの `securitypolicyviolation` イベントと、コンソールのエラーで検出する
 * - CSP が実際に効いていること（インラインのスクリプトを、実行できない）も、確かめる（効いていないと、「違反なし」に意味がない）
 */

import { expect, test, type Page } from '@playwright/test';
import { STATIC_CONTENT_SECURITY_POLICY } from '../../infra/lib/content-security-policy.ts';
import { fillEntryForm, saveEntry } from '../e2e/support/entry.ts';
import { gotoAuthenticated } from '../e2e/support/helpers.ts';
import { environmentData, prepare, seed } from '../e2e/support/viewpoint-scenarios.ts';

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

/** 一巡する画面（機能仕様書 2.1。ログイン後の主な画面）。 */
const SCREEN_PATHS: readonly string[] = [
  '/',
  '/viewpoints/environmentalAdaptability',
  '/viewpoints/environmentalAdaptability/criteria',
  '/satisfaction',
  '/notifications',
  '/data-entry',
  '/data-entry/list',
  '/observations',
  '/settings/equipment',
  '/settings/ingestion',
  '/settings/status-codes',
  '/settings/users',
  '/settings/push',
  '/profile',
];

const violationsOf = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__cspViolations ?? []);

test.beforeEach(async ({ page }) => {
  // 違反を、ページの中で記録する（ページの移動のたびに、先に仕込む）
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(
        `${event.violatedDirective} ${event.blockedURI}（${event.sourceFile}:${String(event.lineNumber)}）`,
      );
    });
  });
  // 画面（HTML）の応答に、CSP を付ける（CloudFront の応答ヘッダーポリシーと同じ）
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'content-security-policy': STATIC_CONTENT_SECURITY_POLICY },
    });
  });
});

test('主な画面を一巡しても、CSP の違反が出ない（ダッシュボード・観点・推移・手動入力・通知・設備・取り込み・ユーザーなど）', async ({
  page,
  request,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  await prepare(request);
  // 推移・通知の画面にも、データがある状態にする（異常の通知も作る）
  await seed(request, environmentData({ temperature: 40 }));

  await gotoAuthenticated(page, '/');
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toBe(STATIC_CONTENT_SECURITY_POLICY);

  for (const path of SCREEN_PATHS) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first(), path).toBeVisible();
    // 通信（API・ポーリング）が落ち着くまで、少し待つ
    await page.waitForLoadState('networkidle');
    expect(await violationsOf(page), path).toEqual([]);
  }
  expect(consoleErrors).toEqual([]);
});

test('画面の中の移動（メニュー）と、API の呼び出し（手動入力の保存）でも、CSP の違反が出ない', async ({
  page,
  request,
}) => {
  await prepare(request);
  await gotoAuthenticated(page, '/');
  await expect(page.getByRole('banner')).toBeVisible();

  await page
    .getByRole('navigation', { name: 'メニュー' })
    .getByRole('link', { name: 'データ入力', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'データ入力', level: 1 })).toBeVisible();
  await fillEntryForm(page, {
    equipment: 'SENSOR-01',
    category: 'ENVIRONMENT',
    observedAt: '2026-10-09T10:00',
    items: { 温度: '23', 湿度: '60' },
  });
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/manual-entries') && response.status() === 201,
  );
  await saveEntry(page);
  await saved;

  expect(await violationsOf(page)).toEqual([]);
});

test('CSP が効いている: インラインのスクリプトは、実行されず、違反として検出される', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.getByLabel('ユーザーID')).toBeVisible();

  const executed = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__inlineScriptRan = true;';
    document.head.append(script);
    return (window as unknown as { __inlineScriptRan?: boolean }).__inlineScriptRan === true;
  });

  expect(executed).toBe(false);
  expect((await violationsOf(page)).some((entry) => entry.startsWith('script-src'))).toBe(true);
});
