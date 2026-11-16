/**
 * シナリオ: アプリのアイコン（タブ・ホーム画面・通知。Issue #326）が、ブラウザから取得できる。
 * ブラウザのタブのアイコン（favicon）を、自動で取得するブラウザが、403 などの失敗にならないこと、
 * index.html の `<link>` とマニフェストの `icons` の参照先が、実際に取得できる画像であることを確認する。
 * 通知のアイコンの指定（sw.js の showNotification）は、UC-23 で確認する。
 *
 * 確認できないこと（E2E の限界）: OS・ブラウザの、タブ・ホーム画面・通知での、実際の表示。
 */

import { expect, test, type APIRequestContext } from '@playwright/test';

/** 同じ場所（オリジン）の URL を取得し、画像として返ることを確認する。 */
async function expectImage(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.get(path);
  expect(response.status(), path).toBe(200);
  expect(response.headers()['content-type'], path).toMatch(/^image\//);
}

test.describe('アプリのアイコン', () => {
  test('ブラウザが自動で取得する favicon.ico が、画像として取得できる（403 にならない）', async ({
    request,
  }) => {
    await expectImage(request, '/favicon.ico');
  });

  test('index.html の <link rel="icon">・apple-touch-icon の参照先が、すべて画像として取得できる', async ({
    page,
    request,
  }) => {
    await page.goto('/');

    const hrefs = await page
      .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));

    expect(hrefs).toEqual(['/icon.svg', '/favicon.ico', '/apple-touch-icon.png']);
    for (const href of hrefs) {
      await expectImage(request, href);
    }
  });

  test('マニフェストの icons の参照先が、すべて画像として取得できる（192×192・512×512 を含む）', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    const manifestPath = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestPath).toBe('/manifest.webmanifest');

    const response = await request.get(manifestPath ?? '');
    expect(response.status()).toBe(200);
    const manifest = (await response.json()) as { icons?: { src: string; sizes: string }[] };
    const icons = manifest.icons ?? [];

    expect(icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of icons) {
      await expectImage(request, icon.src);
    }
  });

  test('通知のアイコン・バッジ（sw.js が指定するファイル）が、画像として取得できる', async ({
    request,
  }) => {
    await expectImage(request, '/icon-192.png');
    await expectImage(request, '/badge-72.png');
  });
});
