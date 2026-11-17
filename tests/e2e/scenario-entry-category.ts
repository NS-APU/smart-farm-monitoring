/**
 * シナリオ: 手動入力のカテゴリは、対象の設備（ハウス・ロボット・環境センサー）の種別に合うものだけ選べる（Issue #360。#261 の子）。
 *
 *   ハウス: 満足度情報だけ／ロボット: 環境情報・満足度情報以外／環境センサー: 環境情報だけ
 *   対象を変えて、カテゴリが選べなくなるときは、カテゴリと入力値を空にして案内する。API も、合わない組み合わせを拒否する。
 *   既存の入力（合わない組み合わせ）を修正する場合は、結合テスト（manual-entry-category-by-equipment.test.ts）で確認する
 *   （E2E は、画面・API から、合わない組み合わせの入力を作れないため）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  HOUSE_ID,
  ROBOT_ID,
  SENSOR_ID,
  alignBrowserClock,
  api,
  openAs,
  prepareApp,
} from './support/app.ts';
import { fillEntryForm, mainArea, saveEntry } from './support/entry.ts';
import { seed, shot } from './support/viewpoint-scenarios.ts';

const categoryField = (page: Page) => mainArea(page).getByLabel('カテゴリ');

async function categoryOptions(page: Page): Promise<string[]> {
  const options = await categoryField(page).locator('option').allTextContents();
  return options.filter((text) => text !== '選択してください');
}

test.describe('画面: 対象の設備を選ぶと、その種別に合うカテゴリだけ選べる', () => {
  test.beforeEach(async ({ request }) => {
    await prepareApp(request);
    await seed(request, {});
  });

  test('ハウスは満足度情報だけ、ロボットは環境情報・満足度情報以外、環境センサーは環境情報だけ', async ({
    page,
  }, testInfo) => {
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');
    const equipment = mainArea(page).getByLabel('対象の設備');

    await equipment.selectOption(HOUSE_ID);
    expect(await categoryOptions(page)).toEqual(['満足度情報']);

    await equipment.selectOption(ROBOT_ID);
    expect(await categoryOptions(page)).toEqual([
      '操作情報',
      '収穫情報',
      '稼働情報',
      'ステータス',
      '安全情報',
      'コスト情報',
      '故障情報',
    ]);

    await equipment.selectOption(SENSOR_ID);
    expect(await categoryOptions(page)).toEqual(['環境情報']);
    await shot(page, testInfo, 'entry-category-sensor');
  });

  test('対象の設備を選ぶまでは、カテゴリを選べない。先に設備を選ぶ旨を案内する', async ({
    page,
  }) => {
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');

    await mainArea(page).getByLabel('対象の設備').selectOption('');

    await expect(categoryField(page)).toBeDisabled();
    await expect(mainArea(page)).toContainText('先に、対象の設備を選んでください');
    await mainArea(page).getByLabel('対象の設備').selectOption(ROBOT_ID);
    await expect(categoryField(page)).toBeEnabled();
  });

  test('対象を変えて、選んでいたカテゴリが選べなくなるときは、カテゴリと入力した値を空にして、案内する。選び直して入力できる', async ({
    page,
  }, testInfo) => {
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');
    await fillEntryForm(page, {
      equipment: ROBOT_ID,
      category: 'FAILURE',
      items: { 故障回数: '3' },
    });

    await mainArea(page).getByLabel('対象の設備').selectOption(SENSOR_ID);

    await expect(categoryField(page)).toHaveValue('');
    await expect(page.getByTestId('entry-items')).toHaveCount(0);
    await expect(mainArea(page)).toContainText('カテゴリと入力値を空にしました');
    await shot(page, testInfo, 'entry-category-cleared');

    // カテゴリを選び直して、入力できる（空にした値は戻らない）
    await fillEntryForm(page, { category: 'ENVIRONMENT', items: { 温度: '22' } });
    await expect(mainArea(page)).not.toContainText('カテゴリと入力値を空にしました');
    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toBeVisible();
  });

  test('各対象の、合うカテゴリで、保存できる（ハウス: 満足度、ロボット: 故障、センサー: 環境）', async ({
    page,
  }) => {
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');

    await fillEntryForm(page, {
      equipment: ROBOT_ID,
      category: 'FAILURE',
      items: { 故障回数: '1' },
    });
    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toBeVisible();

    await fillEntryForm(page, {
      equipment: SENSOR_ID,
      category: 'ENVIRONMENT',
      items: { 温度: '23' },
    });
    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toBeVisible();
  });
});

test.describe('API: 合わない組み合わせは、400（category）で拒否し、保存しない', () => {
  test.beforeEach(async ({ request }) => {
    await prepareApp(request);
  });

  const observedAt = '2026-10-09T02:00:00.000Z';
  const cases = [
    ['ハウス', HOUSE_ID, 'FAILURE', { failureCount: 1 }],
    ['ロボット', ROBOT_ID, 'ENVIRONMENT', { temperatureCelsius: 25 }],
    ['環境センサー', SENSOR_ID, 'FAILURE', { failureCount: 1 }],
  ] as const;

  for (const [name, equipmentId, category, items] of cases) {
    test(`${name} に ${category}`, async ({ request }) => {
      const response = await api(request, 'POST', '/manual-entries', {
        equipmentId,
        category,
        observedAt,
        items,
      });

      expect(response.status()).toBe(400);
      const body = (await response.json()) as { error: { fields?: { name: string }[] } };
      expect(body.error.fields?.map((field) => field.name)).toEqual(['category']);
      const list = (await (await api(request, 'GET', '/manual-entries')).json()) as {
        items: unknown[];
      };
      expect(list.items).toHaveLength(0);
    });
  }
});
