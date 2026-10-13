/**
 * E2E の補助（画面の操作・検査の共通部分）: 画面を開く、一覧の行・通知・カードの取得、レイアウトの共通の検査。
 * UC ごとのテストファイルに同じ関数を複製せず、ここにまとめる（画面の文言・クラス名が変わったときの修正を1か所にする）。
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { alignBrowserClock, openAs } from './app.ts';
import { gotoAuthenticated } from './helpers.ts';

/** テスト ID から、要素を引く関数を作る（例: `const rows = locatorOf('user-row')` → `rows(page)`）。 */
export function locatorOf(testId: string): (page: Page) => Locator {
  return (page) => page.getByTestId(testId);
}

/** 一覧の行のうち、属性（例: `data-user-id`）の値が一致する行を引く関数を作る。 */
export function rowBy(testId: string, attribute: string): (page: Page, value: string) => Locator {
  return (page, value) => page.locator(`[data-testid="${testId}"][${attribute}="${value}"]`);
}

/** ダッシュボードの観点のカード。 */
export function dashboardCard(page: Page, viewpointId: string): Locator {
  return page.getByTestId(`card-${viewpointId}`);
}

/** ダッシュボードを開く（ログインしていなければ、ログインする）。 */
export async function openDashboard(page: Page, query = ''): Promise<void> {
  await gotoAuthenticated(page, `/${query}`);
  await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
}

/** 取り込み設定・状況の画面を開く（ブラウザの時計を揃える。ユーザーを指定すれば、そのユーザーで開く）。 */
export async function openIngestion(
  page: Page,
  user?: Parameters<typeof openAs>[2],
): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/settings/ingestion', user);
  await expect(page.getByRole('heading', { name: '取り込み設定・状況', level: 1 })).toBeVisible();
}

/** 取り込み済みデータの画面を開く（クエリは、`?category=...` のように、先頭の `?` つきで指定する）。 */
export async function openObservationsPage(page: Page, query = ''): Promise<void> {
  await page.goto(`/observations${query}`);
  await expect(page.getByRole('heading', { name: '取り込み済みデータ', level: 1 })).toBeVisible();
}

/** ページが横にはみ出していない（横スクロールが出ない）。 */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

/** ヘッダーの「対象の設備」（長い設備名の選択肢を持つ）が、ラベルを潰さず、ページの幅の中に収まる。 */
export async function expectHeaderIntact(page: Page): Promise<void> {
  const label = await page.locator('.header-field > span').boundingBox();
  expect(label?.height ?? 0, '「対象の設備」のラベルの高さ').toBeLessThan(30);
  const select = await page.locator('.header-field select').boundingBox();
  expect((select?.x ?? 0) + (select?.width ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );
}

/**
 * 画面の文言の中から、指定した利用者ID だけに一致する正規表現（`e2e-user` が、`e2e-user-b` に一致しない）。
 * 表の行の文言は、セルの間に空白がないため、直後にハイフンが続かないことだけで判定する（別の列の文言が、直後に続くことがある）。
 */
export function userIdText(userId: string): RegExp {
  return new RegExp(`${userId}(?!-)`);
}
