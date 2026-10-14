/**
 * UC-20 取り込み済みデータを一覧で確認する（SC-09。FR-6.8）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、データの一覧を開く
 *               2. システムが、日時・設備・カテゴリ・項目・値・取得元（自動取り込み／手動入力）を一覧で表示する
 *               3. 農作業者が、カテゴリ・日時の期間で絞り込み、並べ替え、ページを移動する
 *   代替フロー  該当するデータがない場合は、その旨を表示する
 *   事後条件    農作業者が、取り込み済みのデータを把握している
 *
 * 値の同値分割: カテゴリ（9カテゴリ）、取得元（自動取り込み・手動入力）、設備（ハウス・ロボット・センサー）、データの状態
 * （有効・遅延・欠損・不正）、期間（日本時間の日付。境界を含む）、並べ替えのキー（日時・カテゴリ・値）と向き、
 * 値の表示（単位・桁区切り・ステータスコードの名称・欠損）、件数（0・1ページ・複数ページ）。
 * 関連するユースケース: UC-07・UC-08・UC-09（一覧に現れるデータの元）、UC-18（削除したデータは除外）、UC-02（観点ごとの元データ）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  HOUSE_ID,
  ROBOT_ID,
  SENSOR_ID,
  alignBrowserClock,
  api,
  apiOk,
  openAs,
  prepareApp,
} from './support/app.ts';
import { hoursAgo, seed, shot, type SeededObservation } from './support/viewpoint-scenarios.ts';
import { expectHeaderIntact, expectNoHorizontalScroll, locatorOf } from './support/pages.ts';

const rows = locatorOf('observation-row');

async function openObservations(page: Page, query = ''): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, `/observations${query}`);
  await expect(page.getByRole('heading', { name: '取り込み済みデータ', level: 1 })).toBeVisible();
}

async function column(page: Page, index: number): Promise<string[]> {
  return rows(page).evaluateAll(
    (nodes, position) =>
      nodes.map((node) => node.querySelectorAll('td').item(position).textContent.trim()),
    index,
  );
}

/** 9カテゴリそれぞれのデータ（自動取り込み・手動入力が混在）。 */
const NINE_CATEGORIES: readonly SeededObservation[] = [
  { equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 10, observedAt: hoursAgo(9) },
  { equipmentId: ROBOT_ID, itemKey: 'operatingHours', value: 0.5, observedAt: hoursAgo(8) },
  { equipmentId: ROBOT_ID, itemKey: 'statusCode', value: 'HARVESTING', observedAt: hoursAgo(7) },
  { equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 22, observedAt: hoursAgo(6) },
  {
    equipmentId: SENSOR_ID,
    itemKey: 'illuminanceLux',
    value: 30000,
    observedAt: hoursAgo(5.5),
    source: 'MANUAL',
  },
  {
    equipmentId: ROBOT_ID,
    itemKey: 'operationMinutes',
    value: 8,
    observedAt: hoursAgo(5),
    source: 'MANUAL',
  },
  {
    equipmentId: ROBOT_ID,
    itemKey: 'emergencyStopCount',
    value: 1,
    observedAt: hoursAgo(4),
    source: 'MANUAL',
  },
  {
    equipmentId: ROBOT_ID,
    itemKey: 'maintenanceCostYen',
    value: 1500,
    observedAt: hoursAgo(3),
    source: 'MANUAL',
  },
  {
    equipmentId: ROBOT_ID,
    itemKey: 'failureCount',
    value: 2,
    observedAt: hoursAgo(2),
    source: 'MANUAL',
  },
  {
    equipmentId: HOUSE_ID,
    itemKey: 'satisfaction.safety',
    value: 4,
    observedAt: hoursAgo(1),
    source: 'MANUAL',
  },
];

test.describe('基本フロー: データの一覧を開き、日時・設備・カテゴリ・項目・値・取得元・状態を確認する', () => {
  test('メニューの「取り込み済みデータ」から一覧を開き、日時の新しい順に、日時・設備・カテゴリ・項目・値（単位つき）・取得元・状態を表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, { observations: [...NINE_CATEGORIES] });
    await alignBrowserClock(page);
    await openAs(page, '/');

    await page
      .getByRole('navigation', { name: 'メニュー' })
      .getByRole('link', { name: '取り込み済みデータ' })
      .click();

    await expect(page.getByRole('heading', { name: '取り込み済みデータ', level: 1 })).toBeVisible();
    await expect(rows(page)).toHaveCount(10);
    await expect(page.getByRole('columnheader').allTextContents()).resolves.toEqual([
      '計測日時',
      '設備',
      'カテゴリ',
      '項目',
      '値',
      '取得元',
      '状態',
    ]);
    // 新しい順: 満足度（1時間前）→ 故障（2時間前）→ … → 収穫（9時間前）
    await expect
      .poll(() => column(page, 3))
      .toEqual([
        '満足度（安全性）',
        '故障回数',
        'メンテナンス費',
        '緊急停止回数',
        '操作時間',
        '照度',
        '温度',
        'ステータスコード',
        '稼働時間',
        '収穫数',
      ]);
    // 日時・状態の列: 新しい順の先頭は 1 時間前（2026/10/09 11:00:00）。すべて「有効」
    expect((await column(page, 0))[0]).toBe('2026/10/09 11:00:00');
    await expect.poll(() => column(page, 6)).toEqual(Array.from({ length: 10 }, () => '有効'));
    // 値の表示: 単位・桁区切り・ステータスコードの名称
    await expect
      .poll(() => column(page, 4))
      .toEqual([
        '4スター',
        '2回',
        '1,500円',
        '1回',
        '8分',
        '30,000lx',
        '22℃',
        '収穫中',
        '0.5時間',
        '10個',
      ]);
    // 取得元
    await expect
      .poll(() => column(page, 5))
      .toEqual([
        '手動入力',
        '手動入力',
        '手動入力',
        '手動入力',
        '手動入力',
        '手動入力',
        '自動取り込み',
        '自動取り込み',
        '自動取り込み',
        '自動取り込み',
      ]);
    // 設備・カテゴリ
    await expect(rows(page).nth(0)).toContainText('ハウス1');
    await expect(rows(page).nth(0)).toContainText('満足度情報');
    await expect(rows(page).nth(6)).toContainText('環境センサー1');
    await expect(rows(page).nth(6)).toContainText('環境情報');
    await shot(page, testInfo, 'uc20-list');
  });

  test('データがまだなければ、その旨と、取り込みの状況・データ入力への導線を表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);

    await openObservations(page);

    const empty = page.getByTestId('observations-empty');
    await expect(empty).toContainText('データがまだ取り込まれていません');
    await expect(empty.getByRole('link', { name: '取り込みの状況へ' })).toHaveAttribute(
      'href',
      '/settings/ingestion',
    );
    await expect(empty.getByRole('link', { name: 'データ入力へ' })).toHaveAttribute(
      'href',
      '/data-entry',
    );
  });
});

test.describe('基本フロー 3: カテゴリ・日時の期間・取得元・設備・キーワードで絞り込む', () => {
  const categories: readonly { value: string; label: string; items: string[] }[] = [
    { value: 'HARVEST', label: '収穫情報', items: ['収穫数'] },
    { value: 'OPERATION', label: '稼働情報', items: ['稼働時間'] },
    { value: 'STATUS', label: 'ステータス', items: ['ステータスコード'] },
    { value: 'ENVIRONMENT', label: '環境情報', items: ['照度', '温度'] },
    { value: 'OPERABILITY', label: '操作情報', items: ['操作時間'] },
    { value: 'SAFETY', label: '安全情報', items: ['緊急停止回数'] },
    { value: 'COST', label: 'コスト情報', items: ['メンテナンス費'] },
    { value: 'FAILURE', label: '故障情報', items: ['故障回数'] },
    { value: 'SATISFACTION', label: '満足度情報', items: ['満足度（安全性）'] },
  ];

  for (const category of categories) {
    test(`カテゴリ「${category.label}」で絞り込むと、そのカテゴリのデータだけを表示する`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await seed(request, { observations: [...NINE_CATEGORIES] });
      await openObservations(page);
      await expect(page.getByLabel('カテゴリ').locator('option')).toHaveCount(10);

      await page.getByLabel('カテゴリ').selectOption(category.value);

      await expect(rows(page)).toHaveCount(category.items.length);
      await expect.poll(() => column(page, 3)).toEqual(category.items);
      for (const text of await column(page, 2)) {
        expect(text).toBe(category.label);
      }
      await expect(page).toHaveURL(new RegExp(`category=${category.value}`));
    });
  }

  test('取得元（自動取り込み・手動入力）で絞り込める', async ({ page, request }) => {
    await prepareApp(request);
    await seed(request, { observations: [...NINE_CATEGORIES] });
    await openObservations(page);

    await page.getByLabel('取得元').selectOption('AUTO_IMPORT');
    await expect(rows(page)).toHaveCount(4);
    await page.getByLabel('取得元').selectOption('MANUAL');
    await expect(rows(page)).toHaveCount(6);
    await page.getByLabel('取得元').selectOption('');
    await expect(rows(page)).toHaveCount(10);
  });

  test('設備（ハウス・ロボット・センサー）で絞り込める。ハウスを選ぶと、配下のロボット・センサーのデータも含める', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, { observations: [...NINE_CATEGORIES] });
    await openObservations(page);

    await page.getByLabel('設備', { exact: true }).selectOption(SENSOR_ID);
    await expect(rows(page)).toHaveCount(2);
    await page.getByLabel('設備', { exact: true }).selectOption(ROBOT_ID);
    await expect(rows(page)).toHaveCount(7);
    // ハウスを選ぶと、ハウス自身と、配下のロボット・センサーのデータを、まとめて表示する
    await page.getByLabel('設備', { exact: true }).selectOption(HOUSE_ID);
    await expect(rows(page)).toHaveCount(10);
  });

  test('日時の期間（日本時間の日付。開始日・終了日を含む）で絞り込める', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    // 日本時間: 10/08 23:59、10/09 00:00、10/09 12:00（現在の1時間前）
    await seed(request, {
      observations: [
        {
          equipmentId: ROBOT_ID,
          itemKey: 'harvestCount',
          value: 1,
          observedAt: '2026-10-08T14:59:00.000Z',
        },
        {
          equipmentId: ROBOT_ID,
          itemKey: 'harvestCount',
          value: 2,
          observedAt: '2026-10-08T15:00:00.000Z',
        },
        {
          equipmentId: ROBOT_ID,
          itemKey: 'harvestCount',
          value: 3,
          observedAt: '2026-10-09T02:00:00.000Z',
        },
      ],
    });
    await openObservations(page);
    await expect(rows(page)).toHaveCount(3);

    await page.getByLabel('期間（開始日）').fill('2026-10-09');
    await expect.poll(() => column(page, 4)).toEqual(['3個', '2個']);
    await page.getByLabel('期間（終了日）').fill('2026-10-08');
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId('observations-empty')).toHaveText('該当するデータはありません');
    await page.getByLabel('期間（開始日）').fill('2026-10-08');
    await expect.poll(() => column(page, 4)).toEqual(['1個']);
    await page.getByLabel('期間（終了日）').fill('2026-10-09');
    await expect(rows(page)).toHaveCount(3);
    await page.getByLabel('期間（開始日）').fill('');
    await page.getByLabel('期間（終了日）').fill('2026-10-08');
    await expect(rows(page)).toHaveCount(1);
  });

  const keywords: readonly { name: string; keyword: string; expected: number; shown: string }[] = [
    { name: '項目名', keyword: '収穫数', expected: 1, shown: '収穫数' },
    { name: '設備名', keyword: 'センサー', expected: 2, shown: '環境センサー1' },
    { name: '取得元', keyword: '手動', expected: 6, shown: '手動入力' },
    { name: 'カテゴリ名', keyword: '環境', expected: 2, shown: '環境' },
    { name: '値', keyword: '30000', expected: 1, shown: '照度' },
    { name: '該当なし', keyword: 'zzzz', expected: 0, shown: '' },
  ];

  for (const item of keywords) {
    test(`キーワード: ${item.name}（${item.keyword}）は ${String(item.expected)} 件`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await seed(request, { observations: [...NINE_CATEGORIES] });
      await openObservations(page);

      await page.getByLabel('キーワード').fill(item.keyword);

      await expect(rows(page)).toHaveCount(item.expected);
      // 残った行が、キーワードに一致する行である
      for (const row of await rows(page).all()) {
        await expect(row).toContainText(item.shown);
      }
    });
  }

  test('複数の条件（カテゴリ × 取得元）を組み合わせて絞り込める。条件は URL に反映され、再読み込みで保持される', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, { observations: [...NINE_CATEGORIES] });
    await openObservations(page, '?category=ENVIRONMENT&source=MANUAL');

    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('照度');
    await page.reload();
    await expect(page.getByLabel('カテゴリ')).toHaveValue('ENVIRONMENT');
    await expect(page.getByLabel('取得元')).toHaveValue('MANUAL');
    await expect(rows(page)).toHaveCount(1);
    // 画面で条件を変えると、URL に反映される
    await page.getByLabel('カテゴリ').selectOption('HARVEST');
    await expect(page).toHaveURL(/category=HARVEST/);
  });
});

test.describe('基本フロー 3: 並べ替え（日時・カテゴリ・値）とページの移動', () => {
  const sorts: readonly {
    name: string;
    sort: string;
    direction: string;
    first: string;
    last: string;
  }[] = [
    {
      name: '日時の新しい順（既定）',
      sort: 'observedAt',
      direction: 'desc',
      first: '満足度（安全性）',
      last: '収穫数',
    },
    {
      name: '日時の古い順',
      sort: 'observedAt',
      direction: 'asc',
      first: '収穫数',
      last: '満足度（安全性）',
    },
    { name: '値の降順', sort: 'value', direction: 'desc', first: '照度', last: 'ステータスコード' },
    {
      name: '値の昇順（数値でない値は、最も小さい扱い）',
      sort: 'value',
      direction: 'asc',
      first: 'ステータスコード',
      last: '照度',
    },
  ];

  for (const item of sorts) {
    test(`並べ替え: ${item.name}`, async ({ page, request }) => {
      await prepareApp(request);
      await seed(request, { observations: [...NINE_CATEGORIES] });
      await openObservations(page);

      await page.getByLabel('並べ替え', { exact: true }).selectOption(item.sort);
      await page.getByLabel('並べ替えの向き').selectOption(item.direction);

      const items = await column(page, 3);
      expect(items[0]).toBe(item.first);
      expect(items.at(-1)).toBe(item.last);
    });
  }

  test('並べ替え: カテゴリ（カテゴリのコードの昇順・降順。同じカテゴリは、日時の新しい順）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, { observations: [...NINE_CATEGORIES] });
    await openObservations(page);

    await page.getByLabel('並べ替え', { exact: true }).selectOption('category');
    await page.getByLabel('並べ替えの向き').selectOption('asc');
    await expect
      .poll(() => column(page, 2))
      .toEqual([
        'コスト情報',
        '環境情報',
        '環境情報',
        '故障情報',
        '収穫情報',
        '操作情報',
        '稼働情報',
        '安全情報',
        '満足度情報',
        'ステータス',
      ]);
    await page.getByLabel('並べ替えの向き').selectOption('desc');
    await expect
      .poll(() => column(page, 2))
      .toEqual([
        'ステータス',
        '満足度情報',
        '安全情報',
        '稼働情報',
        '操作情報',
        '収穫情報',
        '故障情報',
        '環境情報',
        '環境情報',
        'コスト情報',
      ]);
    // 同じカテゴリ（環境情報）は、どちらの向きでも、日時の新しい順（照度 → 温度）
    expect((await column(page, 3)).slice(7, 9)).toEqual(['照度', '温度']);
  });

  test('21件のデータは、1ページ目に20件、2ページ目に1件を表示し、前後のページへ移動できる。条件を変えると、先頭のページへ戻る', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, {
      observations: Array.from({ length: 21 }, (_, index) => ({
        equipmentId: ROBOT_ID,
        itemKey: 'harvestCount',
        value: index,
        observedAt: hoursAgo(22 - index),
      })),
    });
    await openObservations(page);
    await expect(rows(page)).toHaveCount(20);
    await expect(page.getByRole('button', { name: '前へ' })).toBeDisabled();
    await shot(page, testInfo, 'uc20-page-1');

    await page.getByRole('button', { name: '次へ' }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId('pager-page')).toHaveText('2');
    await expect(page.getByRole('button', { name: '次へ' })).toBeDisabled();
    await expect(rows(page).first()).toContainText('0個');
    await page.getByRole('button', { name: '前へ' }).click();
    await expect(rows(page)).toHaveCount(20);
    await page.getByRole('button', { name: '次へ' }).click();
    await page.getByLabel('並べ替えの向き').selectOption('asc');

    await expect(page.getByTestId('pager-page')).toHaveText('1');
    await expect(rows(page)).toHaveCount(20);
  });
});

test.describe('データの状態（有効・遅延・欠損・不正）の表示', () => {
  test('状態を、有効・遅延・欠損・不正として表示し、欠損の値は「—」にする。不正な値も、値を表示する（桁区切り・単位つき）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, {
      observations: [
        {
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: 22,
          observedAt: hoursAgo(1),
        },
        {
          equipmentId: SENSOR_ID,
          itemKey: 'humidityPercent',
          value: 60,
          observedAt: hoursAgo(5),
          receivedAt: hoursAgo(1),
          quality: 'LATE',
        },
        {
          equipmentId: SENSOR_ID,
          itemKey: 'illuminanceLux',
          value: null,
          observedAt: hoursAgo(2),
          quality: 'MISSING',
        },
        {
          equipmentId: SENSOR_ID,
          itemKey: 'co2Ppm',
          value: 99999,
          observedAt: hoursAgo(3),
          quality: 'INVALID',
        },
      ],
    });

    await openObservations(page);

    await expect.poll(() => column(page, 6)).toEqual(['有効', '欠損', '不正', '遅延']);
    await expect.poll(() => column(page, 4)).toEqual(['22℃', '—', '99,999ppm', '60%']);
    await expect(rows(page).nth(1).locator('.quality-missing')).toBeVisible();
    await expect(rows(page).nth(2).locator('.quality-invalid')).toBeVisible();
    await shot(page, testInfo, 'uc20-quality');
  });
});

test.describe('他のユースケースとの関連: 入力・取り込み・削除が、一覧に反映される', () => {
  test('手動入力（UC-07）で保存したデータは、手動入力として一覧に現れ、入力の削除（UC-18）で、一覧から外れる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    const response = await api(request, 'POST', '/manual-entries', {
      equipmentId: ROBOT_ID,
      category: 'SAFETY',
      observedAt: hoursAgo(1),
      items: { emergencyStopCount: 1, nearMissCount: 2 },
    });
    const { entry } = (await response.json()) as { entry: { entryId: string } };
    await openObservations(page);
    await expect(rows(page)).toHaveCount(2);
    for (const text of await column(page, 5)) {
      expect(text).toBe('手動入力');
    }

    await api(request, 'DELETE', `/manual-entries/${entry.entryId}`);
    await page.reload();

    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId('observations-empty')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 長い値（設備名 200 文字・ステータスコードの名称 100 文字・桁の多い値）・大量の件数・画面の幅でも、表が潰れず、はみ出さない（NFR-7.3）
// ---------------------------------------------------------------------------

const LONG_NAME_JAPANESE = '長い設備名'.repeat(40);
const LONG_NAME_ASCII = 'E'.repeat(200);
const LONG_STATUS_NAME = '稼働中の長いステータス名'.repeat(8).slice(0, 100);
const LONG_STATUS_CODE = `LONG_${'S'.repeat(95)}`;

/** 表が、列ごとに1文字幅へ潰れず（見出し・日時・カテゴリ・項目が1〜2行）、ページが横にはみ出さないことを確認する。 */
async function expectObservationTableNotCrushed(page: Page): Promise<void> {
  const headerHeights = await page
    .locator('.source-table thead th')
    .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().height));
  expect(Math.max(...headerHeights), `見出しの高さ ${String(headerHeights)}`).toBeLessThan(48);
  // 日時は 1 行。カテゴリ・項目・取得元・状態の列は、1 文字幅へ潰れず、最低限の幅を保つ（行の高さは、長い設備名の折り返しで伸びてよい）
  const timeHeights = await page
    .locator('.source-table tbody time')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  expect(Math.max(...timeHeights), `日時の高さ ${String(timeHeights)}`).toBeLessThan(30);
  for (const [index, name, minimum] of [
    [2, 'カテゴリ', 60],
    [3, '項目', 100],
    [4, '値', 100],
    [5, '取得元', 70],
    [6, '状態', 40],
  ] as const) {
    const widths = await rows(page).evaluateAll(
      (nodes, position) =>
        nodes.map(
          (node) => node.querySelectorAll('td').item(position).getBoundingClientRect().width,
        ),
      index,
    );
    expect(Math.min(...widths), `${name}の幅 ${String(widths)}`).toBeGreaterThanOrEqual(minimum);
  }
  await expectNoHorizontalScroll(page);
}

/** 絞り込みの欄が、ページの幅の中に収まる（長い設備名の選択肢で、欄がはみ出さない）。 */
async function expectFiltersInside(page: Page): Promise<void> {
  const frame = await page.locator('.filter-bar').boundingBox();
  const right = (frame?.x ?? 0) + (frame?.width ?? 0);
  const fields = await page
    .locator('.filter-bar .field')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
  expect(Math.max(...fields)).toBeLessThanOrEqual(right + 1);
  expect(right).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
}

const OBSERVATION_VIEWPORTS = [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 720 },
  { name: 'タブレット幅（768px。NFR-7.3）', width: 768, height: 1024 },
  { name: 'スマートフォン幅（375px）', width: 375, height: 667 },
] as const;

for (const viewport of OBSERVATION_VIEWPORTS) {
  test.describe(`${viewport.name}: 長い値・大量の件数でも、一覧の表が潰れず、はみ出さない`, () => {
    for (const [name, equipmentName] of [
      ['日本語の設備名200文字（上限）', LONG_NAME_JAPANESE],
      ['区切りのない英字の設備名200文字（上限）', LONG_NAME_ASCII],
    ] as const) {
      test(`${name}・ステータスコードの名称100文字・桁の多い値`, async ({
        page,
        request,
      }, testInfo) => {
        await prepareApp(request);
        for (const id of [HOUSE_ID, ROBOT_ID, SENSOR_ID]) {
          await apiOk(request, 'PUT', `/equipment/${id}`, { name: equipmentName });
        }
        await apiOk(request, 'POST', '/status-codes', {
          code: LONG_STATUS_CODE,
          name: LONG_STATUS_NAME,
          category: 'NORMAL',
        });
        await seed(request, {
          observations: [
            {
              equipmentId: ROBOT_ID,
              itemKey: 'statusCode',
              value: LONG_STATUS_CODE,
              observedAt: hoursAgo(1),
            },
            {
              equipmentId: ROBOT_ID,
              itemKey: 'statusCode',
              value: 'U'.repeat(100),
              observedAt: hoursAgo(2),
              quality: 'INVALID',
            },
            {
              equipmentId: SENSOR_ID,
              itemKey: 'illuminanceLux',
              value: 123456789012.5,
              observedAt: hoursAgo(3),
              source: 'MANUAL',
              quality: 'LATE',
            },
            {
              equipmentId: HOUSE_ID,
              itemKey: 'satisfaction.safety',
              value: 4,
              observedAt: hoursAgo(4),
              source: 'MANUAL',
            },
          ],
        });
        await page.setViewportSize({ width: viewport.width, height: viewport.height });

        await openObservations(page);

        await expect(rows(page)).toHaveCount(4);
        await expectObservationTableNotCrushed(page);
        await expectHeaderIntact(page);
        await expectFiltersInside(page);
        const kind = equipmentName === LONG_NAME_ASCII ? 'ascii' : 'ja';
        await shot(page, testInfo, `uc20-long-${String(viewport.width)}-${kind}`);
      });
    }

    test('大量の件数（65件・4ページ）でも、ページを移動しながら、表が潰れず、ページの操作が見える', async ({
      page,
      request,
    }, testInfo) => {
      await prepareApp(request);
      await seed(request, {
        observations: Array.from({ length: 65 }, (_, index) => ({
          equipmentId: index % 2 === 0 ? ROBOT_ID : SENSOR_ID,
          itemKey: index % 2 === 0 ? 'harvestCount' : 'temperatureCelsius',
          value: 1000 + index,
          observedAt: hoursAgo(1 + index * 0.25),
          source: index % 3 === 0 ? ('MANUAL' as const) : ('AUTO_IMPORT' as const),
        })),
      });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openObservations(page);
      await expect(rows(page)).toHaveCount(20);

      for (const expected of [20, 20, 5]) {
        await expectObservationTableNotCrushed(page);
        await page.getByRole('button', { name: '次へ' }).click();
        await expect(rows(page)).toHaveCount(expected);
      }
      await expect(page.getByTestId('pager-page')).toHaveText('4');
      await expect(page.getByRole('button', { name: '次へ' })).toBeDisabled();
      await expectObservationTableNotCrushed(page);
      await page.getByRole('button', { name: '前へ' }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: '前へ' })).toBeInViewport();
      await shot(page, testInfo, `uc20-many-${String(viewport.width)}`);
    });
  });
}
