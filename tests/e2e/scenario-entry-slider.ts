/**
 * シナリオ: データ入力（SC-06）の数値の項目は、数値の欄とスライダーで入力できる。満足度の 9 観点は、広い幅で 3 つずつ並べる（Issue #361。#261 の子）。
 *
 *   スライダーと数値の欄の連動、範囲の目安・単位の表示、目安を超える値の入力（保存できる上限まで）、保存できる値として送ること、
 *   満足度の 3 列（広い幅）・1 列（狭い幅）、3 つの幅でのレイアウト。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  HOUSE_ID,
  ROBOT_ID,
  SENSOR_ID,
  alignBrowserClock,
  openAs,
  prepareApp,
} from './support/app.ts';
import { fillEntryForm, mainArea, saveEntry } from './support/entry.ts';
import { seed, shot } from './support/viewpoint-scenarios.ts';

const items = (page: Page) => mainArea(page).getByTestId('entry-items');
const slider = (page: Page, name: string) => items(page).getByRole('slider', { name });
const field = (page: Page, name: string) => items(page).getByRole('textbox', { name });

test.describe('数値の項目の、スライダー', () => {
  test.beforeEach(async ({ request }) => {
    await prepareApp(request);
    await seed(request, {});
  });

  test('数値の欄とスライダーが連動し、範囲の目安・単位を示す。スライダーで選んだ値を、保存できる', async ({
    page,
  }, testInfo) => {
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');
    await fillEntryForm(page, { equipment: ROBOT_ID, category: 'FAILURE' });

    // 範囲の目安（単位つき）と、入力できる値の説明（ヒント）
    await expect(items(page).getByTestId('entry-slider-meta').first()).toHaveText(
      '目安の範囲: 0〜20回',
    );
    await expect(items(page)).toContainText('0以上の整数');
    await expect(slider(page, '故障回数のスライダー')).toHaveAttribute('max', '20');

    // スライダー → 数値の欄
    await slider(page, '故障回数のスライダー').fill('7');
    await expect(field(page, '故障回数')).toHaveValue('7');
    // 数値の欄 → スライダー
    await field(page, '復旧に要した時間').fill('90');
    await expect(slider(page, '復旧に要した時間のスライダー')).toHaveValue('90');
    // キーボード（矢印キー）でも、目盛りごとに動く
    await slider(page, '故障回数のスライダー').focus();
    await page.keyboard.press('ArrowRight');
    await expect(field(page, '故障回数')).toHaveValue('8');
    await shot(page, testInfo, 'entry-slider-failure');

    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toBeVisible();
    // 保存した値（取り込み済みデータの 1 回の計測として、項目と値が並ぶ）
    await page.goto('/observations?source=MANUAL');
    const row = page.getByTestId('measurement-row').first();
    await expect(row).toContainText('故障回数');
    await expect(row).toContainText('8回');
    await expect(row).toContainText('90分');
  });

  test('目安の範囲を超える値は、数値の欄に入力でき、スライダーの範囲が広がる。保存できる上限（湿度 100）は、超えない', async ({
    page,
  }) => {
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');
    await fillEntryForm(page, { equipment: SENSOR_ID, category: 'ENVIRONMENT' });

    await field(page, '温度').fill('70');
    await field(page, '湿度').fill('150');

    await expect(slider(page, '温度のスライダー')).toHaveAttribute('max', '70');
    await expect(slider(page, '湿度のスライダー')).toHaveAttribute('max', '100');
    // 保存できない値は、保存の検証で、エラーになる（スライダーは、検証を代わりにしない）
    await saveEntry(page);
    await expect(
      mainArea(page).locator('[data-field="items.humidityPercent"] .field-error'),
    ).toBeVisible();
  });

  test('ステータスコード（選択）と、満足度（スター）には、スライダーを出さない', async ({
    page,
  }) => {
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');

    await fillEntryForm(page, { equipment: ROBOT_ID, category: 'STATUS' });
    await expect(items(page)).toBeVisible();
    await expect(items(page).getByRole('slider')).toHaveCount(0);

    await fillEntryForm(page, { equipment: HOUSE_ID, category: 'SATISFACTION' });
    await expect(items(page).getByRole('radiogroup')).toHaveCount(9);
    await expect(items(page).getByRole('slider')).toHaveCount(0);
  });
});

test.describe('満足度の 9 観点の並べ方（広い幅で 3 つずつ。狭い幅で 1 列）', () => {
  test.beforeEach(async ({ request }) => {
    await prepareApp(request);
    await seed(request, {});
  });

  /** 9 観点のスターの組の、行の数（上端が同じ組を、同じ行とする）と、1 行の組の数。 */
  async function columnsOf(page: Page): Promise<number[]> {
    return items(page)
      .getByRole('radiogroup')
      .evaluateAll((groups) => {
        const tops = groups.map((group) => Math.round(group.getBoundingClientRect().top));
        const rows = [...new Set(tops)];
        return rows.map((top) => tops.filter((value) => value === top).length);
      });
  }

  test('広い幅（1280px）は、3 つずつ（3 行）。スターの組は、枠からはみ出さない', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');

    await fillEntryForm(page, { equipment: HOUSE_ID, category: 'SATISFACTION' });

    await expect(items(page).getByRole('radiogroup')).toHaveCount(9);
    expect(await columnsOf(page)).toEqual([3, 3, 3]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await shot(page, testInfo, 'entry-satisfaction-1280');
  });

  test('スマートフォン幅（375px）は、1 列（9 行）。横にはみ出さず、スターは、押せる大きさ', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');

    await fillEntryForm(page, { equipment: HOUSE_ID, category: 'SATISFACTION' });

    expect(await columnsOf(page)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const star = await items(page).locator('label.star').first().boundingBox();
    expect(star?.height ?? 0).toBeGreaterThanOrEqual(44);
    await shot(page, testInfo, 'entry-satisfaction-375');
  });
});

for (const viewport of [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 900 },
  { name: 'タブレット幅（768px）', width: 768, height: 1024 },
  { name: 'スマートフォン幅（375px）', width: 375, height: 800 },
]) {
  test(`${viewport.name}: 数値の項目の、スライダー・数値の欄・目安が、はみ出さず、押せる大きさで並ぶ`, async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, {});
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');

    await fillEntryForm(page, { equipment: SENSOR_ID, category: 'ENVIRONMENT' });
    await slider(page, '温度のスライダー').fill('30');

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const box = await slider(page, '温度のスライダー').boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThan(80);
    const input = await field(page, '温度').boundingBox();
    expect(input?.width ?? 0).toBeGreaterThan(60);
    await shot(page, testInfo, `entry-slider-layout-${String(viewport.width)}`);
  });
}
