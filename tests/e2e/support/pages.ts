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

/** 取り込みの画面を開く（ブラウザの時計を揃える。ユーザーを指定すれば、そのユーザーで開く）。 */
export async function openIngestion(
  page: Page,
  user?: Parameters<typeof openAs>[2],
): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/settings/ingestion', user);
  await expect(page.getByRole('heading', { name: '取り込み', level: 1 })).toBeVisible();
}

/**
 * 取り込み済みデータの一覧の条件に、「項目ごと」の一覧にする指定を足す（並べ替えを「カテゴリ」にする）。
 * 一覧は、日時順（既定）だと、1 回の計測ごとにまとめる（Issue #363）。項目ごとの内容を確認するテストは、この指定で、項目ごとの一覧にする。
 * 並べ替え・期間（31 日以内。日本時間の日付）の指定がなければ、足す（期間は、固定の現在時刻〔2026-10-09〕までの 30 日）。
 */
export function itemListQuery(query = ''): string {
  const params = new URLSearchParams(query.replace(/^[?]/, ''));
  if (!params.has('sort')) {
    params.set('sort', 'category');
  }
  if (!params.has('from')) {
    params.set('from', '2026-09-10');
  }
  if (!params.has('to')) {
    params.set('to', '2026-10-09');
  }
  return `?${params.toString()}`;
}

/**
 * 取り込み済みデータの画面を、項目ごとの一覧（並べ替え「カテゴリ」）で開く（クエリは、`?category=...` のように、先頭の `?` つきで指定する）。
 * 1 回の計測ごとの一覧（既定）は、`openMeasurementsPage` で開く。
 */
export async function openObservationsPage(page: Page, query = ''): Promise<void> {
  await page.goto(`/observations${itemListQuery(query)}`);
  await expect(page.getByRole('heading', { name: '取り込み済みデータ', level: 1 })).toBeVisible();
}

/** 取り込み済みデータの画面を、1 回の計測ごとの一覧（日時順。既定）で開く。 */
export async function openMeasurementsPage(page: Page, query = ''): Promise<void> {
  await page.goto(`/observations${query}`);
  await expect(page.getByRole('heading', { name: '取り込み済みデータ', level: 1 })).toBeVisible();
}

/** ページが横にはみ出していない（横スクロールが出ない）。 */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

/** ヘッダー（☰・タイトル・通知・ユーザー）の各要素が、ページの幅の中に収まる。 */
export async function expectHeaderIntact(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  const rects = await page
    .locator('.app-header-row > *')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
  expect(rects.length).toBeGreaterThan(0);
  for (const rect of rects) {
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(width);
  }
}

/**
 * 画面の中の「対象のハウス」「対象の設備」の選択（長い設備名の選択肢を持つ）が、ラベルを潰さず、ページの幅の中に収まる
 * （以前は、ヘッダーにあった。Issue #355）。
 */
export async function expectEquipmentFieldIntact(page: Page): Promise<void> {
  const label = await page.locator('.equipment-field > span').first().boundingBox();
  expect(label?.height ?? 0, '設備の選択のラベルの高さ').toBeLessThan(30);
  const select = await page.locator('.equipment-field select').first().boundingBox();
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
