/**
 * シナリオ: ヘッダーの ☰ とタイトルと、サイドメニューの開閉（Issue #354）。
 * - ヘッダーの左に、☰（メニューの開閉）と、タイトル「Greenhouse Monitor」（ダッシュボードへのリンク）を、画面の幅に関わらず置く
 * - 広い幅: サイドメニューは、既定で開いている。☰ で閉じる（本文が広がる。閉じている間は、見えず、キーボードの移動の対象にもならない）。
 *   閉じた状態は、保存しない（再読み込みで、開く）
 * - 狭い幅（900px 以下）: ☰ で、引き出しを開く。引き出しは、画面の高さまで届く（スマートフォンでも、メニューの下に、本文が見えない）
 * - サイドメニューの「設定」のアイコンは、歯車
 *
 * 確認できないこと（E2E の限界）: 実機のブラウザのアドレスバーの出入りに、引き出しの高さが追従すること（`100dvh`）。
 */

import { expect, test, type Page } from '@playwright/test';
import { openAs, prepareApp } from './support/app.ts';
import { shot } from './support/viewpoint-scenarios.ts';

function toggle(page: Page) {
  return page.getByRole('banner').getByRole('button', { name: 'メニューの開閉' });
}

function title(page: Page) {
  return page.getByRole('banner').getByRole('link', { name: 'Greenhouse Monitor' });
}

function sidebar(page: Page) {
  return page.getByRole('navigation', { name: 'メニュー' });
}

test.describe('広い幅（1280px）: サイドメニューの開閉', () => {
  test.beforeEach(async ({ page, request }) => {
    await prepareApp(request);
    await page.setViewportSize({ width: 1280, height: 720 });
    await openAs(page, '/');
  });

  test('既定では開いている。☰ で閉じると、本文が広がり、閉じている間は、メニューが見えず、移動の対象にもならない。もう一度押すと、開く', async ({
    page,
  }) => {
    // 本文（main）には、最大幅があるため、本文の外側（ヘッダーと本文を含む、サイドメニューの右の領域）の幅で、広がりを確かめる
    const body = page.locator('.app-body');
    await expect(sidebar(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    const openWidth = (await body.boundingBox())?.width ?? 0;

    await toggle(page).click();

    await expect(sidebar(page)).toBeHidden();
    await expect(page.getByRole('link', { name: '設備' })).toBeHidden();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect
      .poll(async () => (await body.boundingBox())?.width ?? 0)
      .toBeGreaterThan(openWidth + 200);
    // Tab で、閉じたメニューのリンクへ移らない（☰ の次は、タイトル）
    await toggle(page).focus();
    await page.keyboard.press('Tab');
    await expect(title(page)).toBeFocused();

    await toggle(page).click();

    await expect(sidebar(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(async () => (await body.boundingBox())?.width ?? 0)
      .toBeLessThan(openWidth + 5);
  });

  test('閉じた状態は、保存しない: 再読み込みすると、開いた状態に戻る。閉じたまま画面を移動しても、閉じたまま', async ({
    page,
  }) => {
    await toggle(page).click();
    await expect(sidebar(page)).toBeHidden();

    await page.getByRole('link', { name: /^未読の通知/ }).click();
    await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
    await expect(sidebar(page)).toBeHidden();

    await page.reload();

    await expect(page.getByRole('banner')).toBeVisible();
    await expect(sidebar(page)).toBeVisible();
  });

  test('タイトルは、ダッシュボードへのリンク（サイドメニューは、開閉しない）。サイドメニューの中には、タイトルがない', async ({
    page,
  }) => {
    await page.goto('/observations');
    await expect(page.getByRole('heading', { name: '計測データ', level: 1 })).toBeVisible();
    await expect(title(page)).toHaveAttribute('href', '/');
    await expect(page.locator('#app-sidebar').getByText('Greenhouse Monitor')).toHaveCount(0);

    await title(page).click();

    await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
    await expect(sidebar(page)).toBeVisible();
    await expect(page).toHaveTitle('ダッシュボード - Greenhouse Monitor');
  });

  test('サイドメニューの「設定」のアイコンは、歯車（太陽に似た絵柄ではない）', async ({ page }) => {
    const icon = sidebar(page).locator('summary svg').first();

    await expect(icon.locator('circle')).toHaveCount(1);
    expect(
      ((await icon.locator('path').getAttribute('d')) ?? '').split('L').length,
    ).toBeGreaterThan(24);
    await expect(icon).toBeVisible();
  });
});

for (const viewport of [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 720, narrow: false },
  { name: 'タブレット幅（768px）', width: 768, height: 1024, narrow: true },
  { name: 'スマートフォン幅（375px）', width: 375, height: 667, narrow: true },
  { name: '高さの低いスマートフォン（375×420）', width: 375, height: 420, narrow: true },
]) {
  test.describe(`ヘッダーの ☰ とタイトル・サイドメニュー: ${viewport.name}`, () => {
    test('ヘッダーの左に、☰ とタイトルが、この順に、1 行で並び、ページの幅に収まり、他の要素と重ならない', async ({
      page,
      request,
    }, testInfo) => {
      await prepareApp(request);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openAs(page, '/');

      const toggleBox = await toggle(page).boundingBox();
      const titleBox = await title(page).boundingBox();
      expect(toggleBox?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((titleBox?.x ?? 0) + (titleBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
      expect(titleBox?.x ?? 0).toBeGreaterThan((toggleBox?.x ?? 0) + (toggleBox?.width ?? 0) - 1);
      expect(
        Math.abs((titleBox?.y ?? 0) - (toggleBox?.y ?? 100)),
        '☰ とタイトルが、同じ行',
      ).toBeLessThan(20);
      await expect(title(page)).toContainText('Greenhouse Monitor');

      // ヘッダーの要素どうしが、重ならない
      const rects = await page
        .locator('.app-header-row > *')
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
      for (const [index, rect] of rects.entries()) {
        for (const other of rects.slice(index + 1)) {
          const overlapWidth = Math.min(rect.right, other.right) - Math.max(rect.left, other.left);
          const overlapHeight = Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top);
          expect(overlapWidth > 1 && overlapHeight > 1, 'ヘッダーの要素が重なる').toBe(false);
        }
      }

      await shot(
        page,
        testInfo,
        `sidebar-header-${String(viewport.width)}x${String(viewport.height)}`,
      );
    });

    if (viewport.narrow) {
      test('☰ で、引き出しを開くと、引き出しは、画面の高さまで届く（上端から下端まで）。閉じるボタン・Esc・外側で閉じる', async ({
        page,
        request,
      }, testInfo) => {
        await prepareApp(request);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openAs(page, '/');
        await expect(sidebar(page)).toBeHidden();

        await toggle(page).click();

        const drawer = page.locator('#app-sidebar');
        await expect(drawer).toBeVisible();
        await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
        await page.waitForTimeout(400); // 開く動き（0.2 秒）の終わりを待つ
        const box = await drawer.boundingBox();
        expect(box?.y ?? -1, '引き出しの上端').toBeCloseTo(0, 0);
        expect((box?.y ?? 0) + (box?.height ?? 0), '引き出しの下端が、画面の下端').toBeCloseTo(
          viewport.height,
          0,
        );
        expect(box?.x ?? -1, '引き出しの左端').toBeCloseTo(0, 0);
        await shot(
          page,
          testInfo,
          `sidebar-drawer-${String(viewport.width)}x${String(viewport.height)}`,
        );

        await page.getByRole('button', { name: 'メニューを閉じる' }).click();
        await expect(drawer).toBeHidden();
        await toggle(page).click();
        await expect(drawer).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
        await toggle(page).click();
        await expect(drawer).toBeVisible();
        await page.mouse.click(viewport.width - 5, viewport.height / 2);
        await expect(drawer).toBeHidden();
      });
    }
  });
}
