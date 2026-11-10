/**
 * 画面の配信ヘッダーの確認（サーバーレス環境。Issue #127）。CloudFront が付ける応答ヘッダー（CSP・frame-ancestors・X-Frame-Options など）と、
 * S3 のオブジェクトの Cache-Control（Issue #323）を、実際の環境で確かめる。あわせて、実際の画面（ログイン・ダッシュボード）が、
 * CSP のもとで動き、ブラウザに、CSP の違反が出ないことを確かめる。
 *
 * 読み取りだけ（データを書き込まない）。API は、これまでのマネージドポリシーのまま（API の CSP は、バックエンドが付ける）。
 */

import { expect, test } from '@playwright/test';
import { STATIC_CONTENT_SECURITY_POLICY } from '../../infra/lib/content-security-policy.ts';
import { expectDashboardShown, fillLogin, loginButton, openLogin } from './support/smoke-ui.ts';

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

test('画面の応答: CSP・X-Frame-Options など。API の応答は、画面の CSP と別', async ({
  request,
}) => {
  const index = await request.get('/');
  expect(index.status()).toBe(200);
  const headers = index.headers();
  expect(headers['content-security-policy']).toBe(STATIC_CONTENT_SECURITY_POLICY);
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['strict-transport-security']).toContain('max-age=31536000');

  // API（/health）: 画面の CSP は付かない（API の応答は、バックエンドが付ける CSP）
  const health = await request.get('/health');
  expect(health.status()).toBe(200);
  expect(health.headers()['content-security-policy']).not.toBe(STATIC_CONTENT_SECURITY_POLICY);
});

test('画面の Cache-Control: index.html・sw.js・マニフェストは no-cache、assets/ は長期（immutable）', async ({
  request,
}) => {
  const index = await request.get('/');
  expect(index.headers()['cache-control']).toBe('no-cache');
  for (const path of ['/sw.js', '/manifest.webmanifest']) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['cache-control'], path).toBe('no-cache');
  }

  const asset = /\/assets\/[^"']+\.js/.exec(await index.text())?.[0];
  expect(asset, 'index.html に、assets/ のスクリプトがあること').toBeDefined();
  const assetResponse = await request.get(asset ?? '/assets/');
  expect(assetResponse.status()).toBe(200);
  expect(assetResponse.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
});

test('実際の画面（ログイン → ダッシュボード）が、CSP のもとで動き、CSP の違反が出ない', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(
        `${event.violatedDirective} ${event.blockedURI}（${event.sourceFile}:${String(event.lineNumber)}）`,
      );
    });
  });

  await openLogin(page);
  await fillLogin(page);
  await loginButton(page).click();
  await expectDashboardShown(page);
  await page.waitForLoadState('networkidle');

  expect(await page.evaluate(() => window.__cspViolations ?? [])).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
