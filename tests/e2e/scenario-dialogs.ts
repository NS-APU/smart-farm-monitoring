/**
 * シナリオ: 設定の登録・修正・割り当ては、ダイアログで行う（Issue #364〜#366。#261 の子）。
 *
 *   ハウス・設備（SC-10）・ユーザー（SC-14）・ステータスコード（SC-12）の、表の上の登録のボタンから、ダイアログが開く。
 *   ダイアログの操作（最初の入力欄へのフォーカス・Tab の循環・Esc・✕・キャンセル・背面を押しても閉じない・
 *   閉じたあとのフォーカスの戻り・背面のスクロールの停止）と、3 つの幅（1280・768・375px）での収まりを確認する。
 *   各画面の登録・修正の内容は、UC-12・14・17 が確認する。
 */

import { expect, test, type Page } from '@playwright/test';
import { alignBrowserClock, goToMenu, openAs, prepareApp } from './support/app.ts';
import { seed, shot } from './support/viewpoint-scenarios.ts';

const dialog = (page: Page) => page.getByRole('dialog');

async function openEquipment(page: Page): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/');
  await goToMenu(page, 'ハウス・設備');
  await expect(page.getByRole('heading', { name: 'ハウス・設備', level: 1 })).toBeVisible();
}

test.describe('ダイアログの操作（ハウス・設備の登録）', () => {
  test.beforeEach(async ({ request }) => {
    await prepareApp(request);
    await seed(request, {});
  });

  test('表の上のボタンで開く。最初の入力欄にフォーカスがある。Esc で閉じ、開いたボタンにフォーカスが戻る。開いている間は、背面のスクロールを止める', async ({
    page,
  }, testInfo) => {
    await openEquipment(page);
    const opener = page.getByRole('button', { name: 'ハウスの登録' });
    await opener.focus();
    await opener.click();

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAccessibleName('ハウスを登録');
    await expect(dialog(page).getByLabel('設備ID')).toBeFocused();
    await expect(page.locator('body')).toHaveClass(/modal-open/);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
    await shot(page, testInfo, 'dialogs-facility');

    await page.keyboard.press('Escape');

    await expect(dialog(page)).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.locator('body')).not.toHaveClass(/modal-open/);
  });

  test('背面（スクリーン）を押しても、閉じない。入力した内容は、残る。✕・キャンセルで閉じる', async ({
    page,
  }) => {
    await openEquipment(page);
    await page.getByRole('button', { name: 'ハウスの登録' }).click();
    await dialog(page).getByLabel('設備ID').fill('HOUSE-NEW');

    // ダイアログの外（背面の左上の隅）を押す
    await page.mouse.click(3, 3);

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByLabel('設備ID')).toHaveValue('HOUSE-NEW');
    await dialog(page).getByRole('button', { name: '閉じる' }).click();
    await expect(dialog(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'ハウスの登録' }).click();
    await dialog(page).getByRole('button', { name: 'キャンセル' }).click();
    await expect(dialog(page)).toHaveCount(0);
  });

  test('Tab の移動は、ダイアログの中で循環する（外の要素にフォーカスが出ない）', async ({
    page,
  }) => {
    await openEquipment(page);
    await page.getByRole('button', { name: 'ハウスの登録' }).click();

    for (let count = 0; count < 12; count += 1) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null),
        `Tab ${String(count + 1)} 回目`,
      ).toBe(true);
    }
    for (let count = 0; count < 12; count += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(
        await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null),
        `Shift+Tab ${String(count + 1)} 回目`,
      ).toBe(true);
    }
  });

  test('登録に成功すると、ダイアログは閉じて、「登録しました」を示す。ロボット・環境センサーの登録も、別のダイアログ', async ({
    page,
  }) => {
    await openEquipment(page);
    await page.getByRole('button', { name: 'ハウスの登録' }).click();
    await dialog(page).getByLabel('設備ID').fill('HOUSE-NEW');
    await dialog(page).getByLabel('名称').fill('新しいハウス');
    await dialog(page).getByRole('button', { name: '登録する' }).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId('equipment-notice')).toHaveText('登録しました');
    await expect(page.getByTestId('equipment-row').filter({ hasText: 'HOUSE-NEW' })).toBeVisible();

    await page.getByRole('button', { name: 'ロボット・環境センサーの登録' }).click();
    await expect(dialog(page)).toHaveAccessibleName('ロボット・環境センサーを登録');
    await expect(dialog(page).getByLabel('種別')).toBeFocused();
  });

  test('エラーのときは、ダイアログは閉じず、エラーを項目に示す（入力は、残る）', async ({
    page,
  }) => {
    await openEquipment(page);
    await page.getByRole('button', { name: 'ハウスの登録' }).click();
    await dialog(page).getByLabel('名称').fill('名前だけ');

    await dialog(page).getByRole('button', { name: '登録する' }).click();

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('[data-field="equipmentId"] .field-error')).toBeVisible();
    await expect(dialog(page).getByLabel('名称')).toHaveValue('名前だけ');
  });

  test('修正も、ダイアログ（名前は、種別と設備 ID を含む）。キャンセルで閉じる', async ({
    page,
  }) => {
    await openEquipment(page);

    await page
      .getByTestId('equipment-row')
      .filter({ hasText: 'ROBOT-01' })
      .getByRole('button', { name: '修正' })
      .click();

    await expect(dialog(page)).toHaveAccessibleName(/ロボット（ROBOT-01）を修正/);
    await dialog(page).getByRole('button', { name: 'キャンセル' }).click();
    await expect(dialog(page)).toHaveCount(0);
  });
});

test.describe('ユーザー・ステータスコードの登録も、ダイアログ', () => {
  test('「ユーザーの登録」「ステータスコードの登録」のボタンで開き、Esc で閉じる。開いたボタンにフォーカスが戻る', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await alignBrowserClock(page);
    await openAs(page, '/');

    await goToMenu(page, 'ユーザー');
    const addUser = page.getByRole('button', { name: 'ユーザーの登録' });
    await addUser.click();
    await expect(dialog(page)).toHaveAccessibleName('ユーザーを登録');
    await expect(dialog(page).getByLabel('ユーザーID')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(addUser).toBeFocused();

    await goToMenu(page, 'ステータスコード');
    const addCode = page.getByRole('button', { name: 'ステータスコードの登録' });
    await addCode.click();
    await expect(dialog(page)).toHaveAccessibleName('ステータスコードを登録');
    await expect(dialog(page).getByLabel('コード値')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(addCode).toBeFocused();
  });
});

for (const viewport of [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 800 },
  { name: 'タブレット幅（768px）', width: 768, height: 1024 },
  { name: 'スマートフォン幅（375px）', width: 375, height: 667 },
]) {
  test.describe(`${viewport.name}: ダイアログが、画面に収まる`, () => {
    test('ロボット・環境センサーの登録（項目が多いフォーム）は、画面の幅・高さの中に収まり、長い内容は、ダイアログの中でスクロールする。背面は、スクロールしない', async ({
      page,
      request,
    }, testInfo) => {
      await prepareApp(request);
      await seed(request, {});
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openEquipment(page);

      await page.getByRole('button', { name: 'ロボット・環境センサーの登録' }).click();

      const box = await dialog(page).boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height + 0.5);
      // 登録の操作は、ダイアログの中のスクロールで、届く
      await dialog(page).getByRole('button', { name: '登録する' }).scrollIntoViewIfNeeded();
      await expect(dialog(page).getByRole('button', { name: '登録する' })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await shot(page, testInfo, `dialogs-layout-${String(viewport.width)}`);
    });
  });
}
