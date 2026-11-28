/**
 * シナリオ: 画面の明るさ（テーマ: システム・ライト・ダーク。Issue #352）を、ヘッダーのユーザーメニュー（Issue #353）から選べる。
 * - 既定は「システム」で、ブラウザ（OS）の設定に従う（設定を変えると、すぐ追従する）
 * - 「ライト」「ダーク」を選ぶと、ブラウザの設定によらず、すぐ切り替わり、画面を再読み込みしても保たれる
 * - 「システム」へ戻すと、再びブラウザの設定に従う
 * 色は、背景の実際の色（computed style）で確認する。ブラウザの設定は、Playwright の `emulateMedia`（colorScheme）で再現する。
 *
 * 確認できないこと（E2E の限界）: 実際の OS・端末でのダークの設定の切り替わり、描画の前の最初の適用で、色のちらつきがないこと
 * （初期の適用スクリプトの動作は、単体テスト theme.test.ts で確認する）。
 */

import { expect, test, type Page } from '@playwright/test';
import { openAs, openUserMenu, prepareApp } from './support/app.ts';
import { shot } from './support/viewpoint-scenarios.ts';

/** ページの背景の色（computed style）。ライト #f3f6f4・ダーク #12171c（styles/app.css）。 */
const LIGHT_BACKGROUND = 'rgb(243, 246, 244)';
const DARK_BACKGROUND = 'rgb(18, 23, 28)';

function background(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

function dataTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

function userButton(page: Page) {
  return page.getByRole('banner').getByRole('button', { name: /^ログイン中のユーザー/ });
}

/** ユーザーメニューを開いて、テーマの項目を選ぶ（選ぶと、メニューは閉じる）。 */
async function choose(page: Page, item: string): Promise<void> {
  const menu = await openUserMenu(page);
  await menu.getByRole('menuitemradio', { name: item, exact: true }).click();
  await expect(menu).toHaveCount(0);
}

/** 現在のテーマ（チェックが付いている項目）を、ユーザーメニューを開いて確かめ、閉じる。 */
async function expectCurrentTheme(page: Page, item: string): Promise<void> {
  const menu = await openUserMenu(page);
  await expect(menu.getByRole('menuitemradio', { checked: true })).toHaveText(item);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}

test.describe('テーマの切り替え', () => {
  test.beforeEach(async ({ page, request }) => {
    await prepareApp(request);
    await openAs(page, '/');
  });

  test('既定は「システム」: data-theme はなく、ブラウザの設定（ライト・ダーク）に従い、設定を変えると、すぐ追従する', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => background(page)).toBe(LIGHT_BACKGROUND);
    expect(await dataTheme(page)).toBeNull();
    await expectCurrentTheme(page, 'システム（既定）');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => background(page)).toBe(DARK_BACKGROUND);
    expect(await dataTheme(page)).toBeNull();
  });

  test('ユーザーメニューの「テーマ」は、システム（既定）・ライト・ダークの 3 項目で、現在の設定にチェックが付く', async ({
    page,
  }) => {
    const menu = await openUserMenu(page);

    const group = menu.getByRole('group', { name: 'テーマ' });
    const items = group.getByRole('menuitemradio');
    await expect(items).toHaveText(['システム（既定）', 'ライト', 'ダーク']);
    await expect(items.nth(0)).toHaveAttribute('aria-checked', 'true');
    await expect(items.nth(1)).toHaveAttribute('aria-checked', 'false');
    await expect(items.nth(2)).toHaveAttribute('aria-checked', 'false');
    // ヘッダーに、テーマだけのボタンはない
    await expect(page.getByRole('banner').getByRole('button', { name: /^テーマ/ })).toHaveCount(0);
  });

  test('「ダーク」を選ぶと、ブラウザの設定がライトでも、すぐダークになる。再読み込みしても保たれ、「システム」へ戻すと、ブラウザの設定に従う', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => background(page)).toBe(LIGHT_BACKGROUND);

    await choose(page, 'ダーク');

    await expect.poll(() => background(page)).toBe(DARK_BACKGROUND);
    expect(await dataTheme(page)).toBe('dark');
    await expectCurrentTheme(page, 'ダーク');

    await page.reload();
    await expect(page.getByRole('banner')).toBeVisible();
    expect(await dataTheme(page)).toBe('dark');
    await expect.poll(() => background(page)).toBe(DARK_BACKGROUND);
    await expectCurrentTheme(page, 'ダーク');

    await choose(page, 'システム（既定）');

    expect(await dataTheme(page)).toBeNull();
    await expect.poll(() => background(page)).toBe(LIGHT_BACKGROUND);
    await page.reload();
    await expectCurrentTheme(page, 'システム（既定）');
    expect(await dataTheme(page)).toBeNull();
  });

  test('「ライト」を選ぶと、ブラウザの設定がダークでも、ライトになる。再読み込みしても保たれる', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => background(page)).toBe(DARK_BACKGROUND);

    await choose(page, 'ライト');

    await expect.poll(() => background(page)).toBe(LIGHT_BACKGROUND);
    expect(await dataTheme(page)).toBe('light');
    await page.reload();
    await expectCurrentTheme(page, 'ライト');
    await expect.poll(() => background(page)).toBe(LIGHT_BACKGROUND);
  });

  test('保存された設定は、この端末（ブラウザ）のもの: 別のブラウザのコンテキストには、引き継がれない', async ({
    page,
    browser,
  }) => {
    await choose(page, 'ダーク');
    await expectCurrentTheme(page, 'ダーク');

    const other = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    try {
      const otherPage = await other.newPage();
      await openAs(otherPage, '/');
      await expectCurrentTheme(otherPage, 'システム（既定）');
      expect(await dataTheme(otherPage)).toBeNull();
    } finally {
      await other.close();
    }
  });

  test('保存された値が不正なときは、「システム」として動く', async ({ page }) => {
    await page.evaluate(() => {
      window.localStorage.setItem('smart-farm.theme', 'blue');
    });

    await page.reload();

    await expectCurrentTheme(page, 'システム（既定）');
    expect(await dataTheme(page)).toBeNull();
  });

  test('キーボードで操作できる: Enter で開き、↓ で項目を移り、Enter で選ぶ。Esc で閉じ、ユーザーのボタンにフォーカスが戻る', async ({
    page,
  }) => {
    await userButton(page).focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'ユーザー' });
    await expect(menu.getByRole('menuitem', { name: 'ユーザー名の変更' })).toBeFocused();

    // ユーザー名の変更 → パスワードの変更 → 通知の設定 → システム（既定） → ライト
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('ArrowDown');
    }
    await expect(menu.getByRole('menuitemradio', { name: 'ライト' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(userButton(page)).toBeFocused();
    expect(await dataTheme(page)).toBe('light');

    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(userButton(page)).toBeFocused();
  });

  test('メニューの外を押すと、設定を変えずに閉じる', async ({ page }) => {
    await openUserMenu(page);

    await page.getByRole('main').click({ position: { x: 5, y: 5 } });

    await expect(page.getByRole('menu', { name: 'ユーザー' })).toHaveCount(0);
    expect(await dataTheme(page)).toBeNull();
  });

  test('初期の適用スクリプト（/theme-init.js）は、画面と同じオリジンの JavaScript として、配信される（CSP のもとで動く）', async ({
    request,
  }) => {
    const response = await request.get('/theme-init.js');

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/javascript/);
  });
});

for (const viewport of [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 720 },
  { name: 'タブレット幅（768px）', width: 768, height: 1024 },
  { name: 'スマートフォン幅（375px）', width: 375, height: 800 },
]) {
  test.describe(`テーマの切り替え: ${viewport.name}`, () => {
    for (const [item, theme] of [
      ['ライト', 'light'],
      ['ダーク', 'dark'],
    ] as const) {
      test(`${item}で、ヘッダー・ユーザーメニューが、はみ出さず、他の要素と重ならない`, async ({
        page,
        request,
      }, testInfo) => {
        await prepareApp(request);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openAs(page, '/');
        await choose(page, item);
        await expectCurrentTheme(page, item);
        expect(await dataTheme(page)).toBe(theme);

        // ユーザーメニューを開いたとき、ページの幅の中に収まる
        const list = await openUserMenu(page);
        const box = await list.boundingBox();
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
        await page.keyboard.press('Escape');

        // ヘッダーの 1 行目（通知のアイコン・ユーザーのボタン）が、ページの幅の中に収まり、重ならない
        const rects = await page
          .locator('.app-header-row > .header-unread, .app-header-row > .user-menu')
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
        expect(rects).toHaveLength(2);
        for (const rect of rects) {
          expect(rect.left).toBeGreaterThanOrEqual(0);
          expect(rect.right).toBeLessThanOrEqual(viewport.width);
        }
        const [first, second] = rects;
        const overlapWidth =
          Math.min(first?.right ?? 0, second?.right ?? 0) -
          Math.max(first?.left ?? 0, second?.left ?? 0);
        const overlapHeight =
          Math.min(first?.bottom ?? 0, second?.bottom ?? 0) -
          Math.max(first?.top ?? 0, second?.top ?? 0);
        expect(
          overlapWidth > 1 && overlapHeight > 1,
          '通知のアイコンとユーザーのボタンが重なる',
        ).toBe(false);

        await shot(page, testInfo, `theme-${theme}-${String(viewport.width)}`);
      });
    }
  });
}
