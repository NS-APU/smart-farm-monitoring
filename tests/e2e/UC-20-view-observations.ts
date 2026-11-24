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
  addEntry,
  alignBrowserClock,
  api,
  apiOk,
  openAs,
  prepareApp,
} from './support/app.ts';
import { hoursAgo, seed, shot, type SeededObservation } from './support/viewpoint-scenarios.ts';
import {
  expectHeaderIntact,
  expectNoHorizontalScroll,
  itemListQuery,
  locatorOf,
} from './support/pages.ts';

/** 項目ごとの一覧の行（並べ替えを「カテゴリ」「値」にしたとき）。 */
const rows = locatorOf('observation-row');
/** 1 回の計測ごとの一覧の行（日時順。既定。Issue #363）。 */
const measurementRows = locatorOf('measurement-row');

/**
 * 計測データの画面を、**項目ごとの一覧**（並べ替え「カテゴリ」）で開く。日時順（既定）は、1 回の計測ごとの一覧になるため（#363）、
 * 項目ごとの内容を確認するテストは、この指定で開く（並べ替え・期間は、条件になければ足す）。
 */
async function openObservations(page: Page, query = ''): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, `/observations${itemListQuery(query)}`);
  await expect(page.getByRole('heading', { name: '計測データ', level: 1 })).toBeVisible();
}

/** 計測データの画面を、1 回の計測ごとの一覧（日時順。既定）で開く。 */
async function openMeasurements(page: Page, query = ''): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, `/observations${query}`);
  await expect(page.getByRole('heading', { name: '計測データ', level: 1 })).toBeVisible();
}

/** 計測ごとの一覧の、各行の、項目の名称（行ごとに、項目の名称の配列）。 */
async function measurementLabels(page: Page): Promise<string[][]> {
  return measurementRows(page).evaluateAll((nodes) =>
    nodes.map((node) =>
      [...node.querySelectorAll('.measurement-item-label')].map((label) =>
        label.textContent.trim(),
      ),
    ),
  );
}

/** 計測ごとの一覧の、各行の、項目の値（行ごとに、値の配列）。 */
async function measurementValues(page: Page): Promise<string[][]> {
  return measurementRows(page).evaluateAll((nodes) =>
    nodes.map((node) =>
      [...node.querySelectorAll('.measurement-item-value')].map((value) =>
        value.textContent.trim(),
      ),
    ),
  );
}

async function column(page: Page, index: number): Promise<string[]> {
  return rows(page).evaluateAll(
    (nodes, position) =>
      nodes.map((node) => node.querySelectorAll('td').item(position).textContent.trim()),
    index,
  );
}

/** キーワード・値・カテゴリの順の並べ替えで必須の期間（31 日以内。日本時間の日付）。データ（9 時間前まで）を含む（#91）。 */
const PERIOD = '?from=2026-10-08&to=2026-10-09';

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
  test('メニューの「計測データ」から一覧を開くと、日時の新しい順に、1 回の計測ごとに、日時・設備・カテゴリ・項目と値（単位つき）・取得元・状態を表示する（#363）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, { observations: [...NINE_CATEGORIES] });
    await alignBrowserClock(page);
    await openAs(page, '/');

    await page
      .getByRole('navigation', { name: 'メニュー' })
      .getByRole('link', { name: '計測データ' })
      .click();

    await expect(page.getByRole('heading', { name: '計測データ', level: 1 })).toBeVisible();
    // メニューの現在地: 「計測データ」だけを強調する（Issue #155 の SC-COM-4）
    await expect(
      page.getByRole('navigation', { name: 'メニュー' }).locator('[aria-current="page"]'),
    ).toHaveText(['計測データ']);
    await expect(page.getByTestId('observations-mode-note')).toContainText('1 行にまとめて');
    // この例は、どの計測も 1 項目（計測の日時がすべて違う）。項目ごとの行（observation-row）は、出さない
    await expect(measurementRows(page)).toHaveCount(10);
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByRole('columnheader').allTextContents()).resolves.toEqual([
      '計測日時',
      '設備',
      'カテゴリ',
      '項目と値',
      '取得元',
      '状態',
    ]);
    // 新しい順: 満足度（1時間前）→ 故障（2時間前）→ … → 収穫（9時間前）
    await expect
      .poll(() => measurementLabels(page))
      .toEqual([
        ['満足度（安全性）'],
        ['故障回数'],
        ['メンテナンス費'],
        ['緊急停止回数'],
        ['操作時間'],
        ['照度'],
        ['温度'],
        ['ステータスコード'],
        ['稼働時間'],
        ['収穫数'],
      ]);
    // 日時の列: 新しい順の先頭は 1 時間前（2026/10/09 11:00:00）。状態は、すべて「すべて有効」
    await expect(measurementRows(page).first().locator('td').first()).toHaveText(
      '2026/10/09 11:00:00',
    );
    await expect(measurementRows(page).locator('td:last-child')).toHaveText(
      Array.from({ length: 10 }, () => 'すべて有効'),
    );
    // 値の表示: 単位・桁区切り・ステータスコードの名称
    await expect
      .poll(() => measurementValues(page))
      .toEqual([
        ['4スター'],
        ['2回'],
        ['1,500円'],
        ['1回'],
        ['8分'],
        ['30,000lx'],
        ['22℃'],
        ['収穫中'],
        ['0.5時間'],
        ['10個'],
      ]);
    // 取得元
    await expect(measurementRows(page).locator('td:nth-child(5)')).toHaveText([
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
    await expect(measurementRows(page).nth(0)).toContainText('ハウス1');
    await expect(measurementRows(page).nth(0)).toContainText('満足度情報');
    await expect(measurementRows(page).nth(6)).toContainText('環境センサー1');
    await expect(measurementRows(page).nth(6)).toContainText('環境情報');
    await shot(page, testInfo, 'uc20-list');
  });

  test('同じ設備・計測日時・取得元の項目は、1 回の計測として、1 行にまとめる。設備・日時・取得元が違えば、別の行（#363）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    const at = hoursAgo(3);
    await seed(request, {
      observations: [
        // ロボットの 1 回の計測（3 項目。同じ日時）
        { equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 10, observedAt: at },
        { equipmentId: ROBOT_ID, itemKey: 'operatingHours', value: 0.5, observedAt: at },
        { equipmentId: ROBOT_ID, itemKey: 'standbyHours', value: 0.25, observedAt: at },
        // 同じ日時でも、設備が違えば、別の計測
        { equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 22, observedAt: at },
        { equipmentId: SENSOR_ID, itemKey: 'humidityPercent', value: 60, observedAt: at },
        // 同じ設備・日時でも、取得元が違えば、別の計測
        {
          equipmentId: ROBOT_ID,
          itemKey: 'failureCount',
          value: 1,
          observedAt: at,
          source: 'MANUAL',
        },
      ],
    });

    await openMeasurements(page);

    await expect(measurementRows(page)).toHaveCount(3);
    const byEquipment = (name: string) => measurementRows(page).filter({ hasText: name });
    const robotAuto = byEquipment('収穫ロボット1').filter({ hasText: '自動取り込み' });
    await expect(robotAuto.getByTestId('measurement-item')).toHaveCount(3);
    await expect(robotAuto).toContainText('収穫数');
    await expect(robotAuto).toContainText('10個');
    await expect(robotAuto).toContainText('稼働時間');
    await expect(robotAuto).toContainText('待機時間');
    // カテゴリは、計測の項目のカテゴリを、「・」でつなぐ
    await expect(robotAuto).toContainText('収穫情報・稼働情報');
    const sensor = byEquipment('環境センサー1');
    await expect(sensor.getByTestId('measurement-item')).toHaveCount(2);
    const robotManual = byEquipment('収穫ロボット1').filter({ hasText: '手動入力' });
    await expect(robotManual.getByTestId('measurement-item')).toHaveCount(1);
    await shot(page, testInfo, 'uc20-measurements');

    // 並べ替えを「カテゴリ」にすると、項目ごとの一覧（6 行）になる
    await page.getByLabel('並べ替え', { exact: true }).selectOption('category');
    await page.getByLabel('期間（開始日）').fill('2026-10-08');
    await page.getByLabel('期間（終了日）').fill('2026-10-09');
    await expect(rows(page)).toHaveCount(6);
    await expect(measurementRows(page)).toHaveCount(0);
    await expect(page.getByTestId('observations-mode-note')).toContainText('項目ごとに 1 行');
  });

  test('キーワード・カテゴリで絞ると、一致した項目を含む計測を、全項目で表示する（計測の一部の項目だけにしない）（#363）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    const at = hoursAgo(3);
    await seed(request, {
      observations: [
        { equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 10, observedAt: at },
        { equipmentId: ROBOT_ID, itemKey: 'operatingHours', value: 0.5, observedAt: at },
        { equipmentId: ROBOT_ID, itemKey: 'standbyHours', value: 0.25, observedAt: at },
        {
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: 22,
          observedAt: hoursAgo(4),
        },
      ],
    });

    await openMeasurements(page, PERIOD);
    await page.getByLabel('キーワード').fill('待機');

    await expect(measurementRows(page)).toHaveCount(1);
    await expect(measurementRows(page).getByTestId('measurement-item')).toHaveCount(3);

    await page.getByLabel('キーワード').fill('');
    await page.getByLabel('カテゴリ').selectOption('OPERATION');
    await expect(measurementRows(page)).toHaveCount(1);
    await expect(measurementRows(page).getByTestId('measurement-item')).toHaveCount(3);
  });

  test('データがまだなければ、その旨と、取り込みの状況・データ入力への導線を表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);

    await openMeasurements(page);

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
    // 日時順（既定。1 回の計測ごと）は、期間の片方だけでも、指定できる（この例は、どの計測も 1 項目）
    await openMeasurements(page);
    await expect(measurementRows(page)).toHaveCount(3);

    await page.getByLabel('期間（開始日）').fill('2026-10-09');
    await expect.poll(() => measurementValues(page)).toEqual([['3個'], ['2個']]);
    await page.getByLabel('期間（終了日）').fill('2026-10-08');
    await expect(measurementRows(page)).toHaveCount(0);
    await expect(page.getByTestId('observations-empty')).toHaveText('該当するデータはありません');
    await page.getByLabel('期間（開始日）').fill('2026-10-08');
    await expect.poll(() => measurementValues(page)).toEqual([['1個']]);
    await page.getByLabel('期間（終了日）').fill('2026-10-09');
    await expect(measurementRows(page)).toHaveCount(3);
    await page.getByLabel('期間（開始日）').fill('');
    await page.getByLabel('期間（終了日）').fill('2026-10-08');
    await expect(measurementRows(page)).toHaveCount(1);
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
      await openObservations(page, PERIOD);

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

  test('適用中の条件の数を示し、条件のクリアで、絞り込み・並べ替えをすべて初期値（日時順）に戻す（SC-07-3）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, { observations: [...NINE_CATEGORIES] });
    await openMeasurements(page, '?category=ENVIRONMENT&source=MANUAL');
    await expect(page.getByTestId('filter-active-count')).toHaveText('適用中の条件 2 件');
    await expect(measurementRows(page).first()).toBeVisible();
    const filtered = await measurementRows(page).count();

    await page.getByRole('button', { name: '条件のクリア' }).click();

    await expect(page.getByLabel('カテゴリ')).toHaveValue('');
    await expect(page.getByLabel('取得元')).toHaveValue('');
    await expect.poll(() => measurementRows(page).count()).toBeGreaterThan(filtered);
    await expect(page.getByTestId('filter-active-count')).toHaveCount(0);
    await expect(page).not.toHaveURL(/category=|source=/);
  });
});

test.describe('代替フロー: 並べ替え（値・カテゴリ）・キーワード検索は、期間（31 日以内）が必須（#91）', () => {
  const GUIDANCE = '並べ替え・検索は、期間（31 日以内）を指定してください';

  test('期間なしで、値の順・カテゴリの順・キーワードを選ぶと、案内を表示し、期間（31 日以内）を指定すると、一覧に戻る。日時順は、期間がなくても全期間を表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, { observations: [...NINE_CATEGORIES] });
    await openMeasurements(page);
    await expect(measurementRows(page)).toHaveCount(10);

    await page.getByLabel('並べ替え', { exact: true }).selectOption('value');
    await expect(page.getByTestId('observations-period-guidance')).toHaveText(GUIDANCE);
    await expect(rows(page)).toHaveCount(0);
    await shot(page, testInfo, 'uc20-period-guidance');
    await page.getByLabel('並べ替え', { exact: true }).selectOption('category');
    await expect(page.getByTestId('observations-period-guidance')).toBeVisible();
    await page.getByLabel('並べ替え', { exact: true }).selectOption('observedAt');
    await expect(measurementRows(page)).toHaveCount(10);
    await expect(page.getByTestId('observations-period-guidance')).toHaveCount(0);

    await page.getByLabel('キーワード').fill('手動');
    await expect(page.getByTestId('observations-period-guidance')).toHaveText(GUIDANCE);
    await page.getByLabel('期間（開始日）').fill('2026-10-08');
    await page.getByLabel('期間（終了日）').fill('2026-10-09');
    await expect(measurementRows(page)).toHaveCount(6);
    await expect(page.getByTestId('observations-period-guidance')).toHaveCount(0);
  });

  test('期間が 31 日を超えると、案内を表示する（ちょうど 31 日は、一覧を表示する）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, { observations: [...NINE_CATEGORIES] });
    await openObservations(page, '?sort=value&from=2026-09-08&to=2026-10-09');
    await expect(page.getByTestId('observations-period-guidance')).toHaveText(GUIDANCE);

    await page.getByLabel('期間（開始日）').fill('2026-09-09');

    await expect(rows(page)).toHaveCount(10);
  });

  test('API は、期間のない・31 日を超える、値・カテゴリの順・キーワードを、400（項目ごとのエラーつき）で拒否する。日時順は、期間なしで受け付ける', async ({
    request,
  }) => {
    await prepareApp(request);
    await seed(request, { observations: [...NINE_CATEGORIES] });

    const noPeriod = await api(request, 'GET', '/observations?sort=value');
    const keyword = await api(request, 'GET', '/observations?q=%E6%89%8B%E5%8B%95');
    const tooLong = await api(
      request,
      'GET',
      '/observations?sort=category&from=2026-09-01T00:00:00.000Z&to=2026-10-09T00:00:00.000Z',
    );
    const byTime = await api(request, 'GET', '/observations');
    // 計測ごとの API も、キーワードは、期間が必須。日時順だけなので、並べ替えの指定はない（#363）
    const measurementsKeyword = await api(
      request,
      'GET',
      '/observations/measurements?q=%E6%89%8B%E5%8B%95',
    );
    const measurementsByTime = await api(request, 'GET', '/observations/measurements');

    for (const response of [noPeriod, keyword, tooLong]) {
      expect(response.status()).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; fields: { name: string }[] };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.fields.map((field) => field.name).sort()).toEqual(['from', 'to']);
    }
    expect(byTime.status()).toBe(200);
    expect(measurementsKeyword.status()).toBe(400);
    expect(measurementsByTime.status()).toBe(200);
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
      await openObservations(page, PERIOD);

      await page.getByLabel('並べ替え', { exact: true }).selectOption(item.sort);
      await page.getByLabel('並べ替えの向き').selectOption(item.direction);

      if (item.sort === 'observedAt') {
        // 日時順は、1 回の計測ごとの一覧（この例は、どの計測も 1 項目）
        await expect(measurementRows(page)).toHaveCount(10);
        const labels = (await measurementLabels(page)).flat();
        expect(labels[0]).toBe(item.first);
        expect(labels.at(-1)).toBe(item.last);
        return;
      }
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
    await openObservations(page, PERIOD);

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
    // 計測の日時がすべて違うため、21 回の計測（1 ページに 20 回の計測。計測ごとの一覧のページ分割。#363）
    await openMeasurements(page);
    await expect(measurementRows(page)).toHaveCount(20);
    await expect(page.getByRole('button', { name: '前へ' })).toBeDisabled();
    await expect(page.getByTestId('pager-range')).toHaveText('1〜20 件目');
    await shot(page, testInfo, 'uc20-page-1');

    await page.getByRole('button', { name: '次へ' }).click();
    await expect(measurementRows(page)).toHaveCount(1);
    await expect(page.getByTestId('pager-page')).toHaveText('2');
    await expect(page.getByTestId('pager-range')).toHaveText('21〜21 件目');
    await expect(page.getByRole('button', { name: '次へ' })).toBeDisabled();
    await expect(measurementRows(page).first()).toContainText('0個');
    await page.getByRole('button', { name: '前へ' }).click();
    await expect(measurementRows(page)).toHaveCount(20);
    await page.getByRole('button', { name: '次へ' }).click();
    await page.getByLabel('並べ替えの向き').selectOption('asc');

    await expect(page.getByTestId('pager-page')).toHaveText('1');
    await expect(measurementRows(page)).toHaveCount(20);
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

test.describe('代替フロー: 「問題あり（欠損・遅延・不正を含む）」だけに絞り込む（SC-09-3）', () => {
  const PROBLEM_GUIDANCE =
    '「問題あり」の絞り込みは、期間（31 日以内）を指定してください。多いときは、期間を狭めてください';
  const problemCheckbox = (page: Page) =>
    page.getByRole('checkbox', { name: '問題あり（欠損・遅延・不正を含む）' });

  /** 有効 1・遅延 1・欠損 1・不正 1（センサー。計測ごとに別の日時）と、ロボットの 1 回の計測（収穫数は有効・稼働時間は欠損）。 */
  const PROBLEM_DATA: readonly SeededObservation[] = [
    { equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 22, observedAt: hoursAgo(1) },
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
    { equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 10, observedAt: hoursAgo(4) },
    {
      equipmentId: ROBOT_ID,
      itemKey: 'operatingHours',
      value: null,
      observedAt: hoursAgo(4),
      quality: 'MISSING',
    },
  ];

  test('計測ごとの一覧は、有効でない項目を含む計測だけを、全項目で示す。選んでいる間は、手動の「更新」で取り直し、外すと、すべてに戻る', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, { observations: [...PROBLEM_DATA] });
    await openMeasurements(page, PERIOD);
    await expect(measurementRows(page)).toHaveCount(5);
    // 選んでいないときは、自動で更新する（手動の「更新」は、ない）
    await expect(page.getByRole('button', { name: '更新' })).toHaveCount(0);

    await problemCheckbox(page).check();

    await expect(measurementRows(page)).toHaveCount(4);
    await expect(page).toHaveURL(/problemOnly=true/);
    await expect(page.getByTestId('filter-active-count')).toHaveText('適用中の条件 3 件');
    await expect(page.getByTestId('observations-problem-note')).toHaveText(
      '期間は 31 日以内。多いときは、期間を狭めてください',
    );
    await expect(page.getByTestId('observations-manual-refresh-note')).toContainText(
      '自動では更新しません',
    );
    // 有効だけの計測（温度）は出ない。ロボットの計測は、有効な項目（収穫数）も含めて、全項目を示す
    await expect(measurementRows(page).filter({ hasText: '温度' })).toHaveCount(0);
    const robot = measurementRows(page).filter({ hasText: '収穫ロボット1' });
    await expect(robot).toHaveCount(1);
    await expect(robot.getByTestId('measurement-item')).toHaveCount(2);
    await expect(robot.locator('.quality-missing').first()).toBeVisible();
    const states = await measurementRows(page).evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector('td:last-child')?.textContent.trim()),
    );
    expect(states).toEqual(['欠損 1', '不正 1', '欠損 1', '遅延 1']);
    await shot(page, testInfo, 'uc20-problem-filter');

    // 新しい問題ありのデータが増えても、自動では更新せず、「更新」を押すと取り直す
    await seed(request, {
      observations: [
        {
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: null,
          observedAt: hoursAgo(6),
          quality: 'MISSING',
        },
      ],
    });
    await expect(measurementRows(page)).toHaveCount(4);
    await page.getByRole('button', { name: '更新' }).click();
    await expect(measurementRows(page)).toHaveCount(5);

    // 外すと、すべての計測に戻り、手動の「更新」は消える
    await problemCheckbox(page).uncheck();
    await expect(measurementRows(page)).toHaveCount(6);
    await expect(page.getByRole('button', { name: '更新' })).toHaveCount(0);
    await expect(page).not.toHaveURL(/problemOnly=/);
  });

  test('項目ごとの一覧（日時以外の並べ替え）では、有効でない項目だけを示す。条件のクリアで、「問題あり」も外れる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, { observations: [...PROBLEM_DATA] });
    await openObservations(page, '?problemOnly=true');

    await expect(rows(page)).toHaveCount(4);
    await expect.poll(() => column(page, 6)).toEqual(['欠損', '欠損', '不正', '遅延']);

    await page.getByRole('button', { name: '条件のクリア' }).click();

    await expect(problemCheckbox(page)).not.toBeChecked();
    await expect(page.getByTestId('filter-active-count')).toHaveCount(0);
    await expect(page).not.toHaveURL(/problemOnly=/);
    // 並べ替えも初期値（日時順）に戻り、計測ごとの一覧になる
    await expect(measurementRows(page)).toHaveCount(5);
  });

  test('期間がなければ、案内を示す。期間（31 日以内）を指定すると、一覧に戻る。31 日を超えると、案内を示す', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, { observations: [...PROBLEM_DATA] });
    await openMeasurements(page);
    await expect(measurementRows(page)).toHaveCount(5);

    await problemCheckbox(page).check();
    await expect(page.getByTestId('observations-period-guidance')).toHaveText(PROBLEM_GUIDANCE);
    await expect(measurementRows(page)).toHaveCount(0);

    await page.getByLabel('期間（開始日）').fill('2026-10-08');
    await page.getByLabel('期間（終了日）').fill('2026-10-09');
    await expect(measurementRows(page)).toHaveCount(4);
    await expect(page.getByTestId('observations-period-guidance')).toHaveCount(0);

    await page.getByLabel('期間（開始日）').fill('2026-09-08');
    await expect(page.getByTestId('observations-period-guidance')).toHaveText(PROBLEM_GUIDANCE);
  });

  test('該当するデータがなければ、その旨を示す（有効なデータだけのとき）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {
      observations: [
        {
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: 22,
          observedAt: hoursAgo(1),
        },
      ],
    });

    await openMeasurements(page, `${PERIOD}&problemOnly=true`);

    await expect(page.getByTestId('observations-empty')).toHaveText('該当するデータはありません');
  });

  test('API: 「問題あり」は、期間（31 日以内）が必須（400。項目ごとのエラーつき）。期間があれば、有効でない観測値・計測だけを返す。true・false 以外は 400', async ({
    request,
  }) => {
    await prepareApp(request);
    await seed(request, { observations: [...PROBLEM_DATA] });
    const period = 'from=2026-10-08T00:00:00.000Z&to=2026-10-09T23:59:59.999Z';

    const noPeriod = await api(request, 'GET', '/observations?problemOnly=true');
    const measurementsNoPeriod = await api(
      request,
      'GET',
      '/observations/measurements?problemOnly=true',
    );
    const tooLong = await api(
      request,
      'GET',
      '/observations?problemOnly=true&from=2026-09-01T00:00:00.000Z&to=2026-10-09T00:00:00.000Z',
    );
    const items = await api(request, 'GET', `/observations?problemOnly=true&${period}`);
    const measurements = await api(
      request,
      'GET',
      `/observations/measurements?problemOnly=true&${period}`,
    );
    const invalid = await api(request, 'GET', `/observations?problemOnly=yes&${period}`);
    const off = await api(request, 'GET', '/observations?problemOnly=false');

    for (const response of [noPeriod, measurementsNoPeriod, tooLong]) {
      expect(response.status()).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; fields: { name: string }[] };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.fields.map((field) => field.name).sort()).toEqual(['from', 'to']);
    }
    expect(invalid.status()).toBe(400);
    expect(off.status()).toBe(200);
    expect(items.status()).toBe(200);
    const itemBody = (await items.json()) as { items: { quality: string }[] };
    expect(itemBody.items.map((item) => item.quality).sort()).toEqual([
      'INVALID',
      'LATE',
      'MISSING',
      'MISSING',
    ]);
    const measurementBody = (await measurements.json()) as { items: { items: unknown[] }[] };
    expect(measurementBody.items).toHaveLength(4);
    expect(measurementBody.items.map((item) => item.items.length).sort()).toEqual([1, 1, 1, 2]);
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
    // 手動入力の行は、取得元の下に、入力データ一覧・変更履歴への導線を持つ（#155。SC-09-5。管理者は、変更履歴も参照できる）
    for (const text of await column(page, 5)) {
      expect(text).toBe('手動入力入力データを開く履歴');
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
  // 狭い幅では、絞り込みの項目が折りたたまれる。開いてから、項目が幅の中に収まることを確認する
  const toggle = page.getByRole('button', { name: '絞り込みを開く' });
  if (await toggle.isVisible()) {
    await toggle.click();
  }
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

test.describe('データの状態の凡例（SC-09-2。Issue #154）', () => {
  test('「データの状態の見かた」を開くと、有効・欠損・遅延・不正の意味と、評価での扱いが出る。はじめは閉じている', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {
      observations: [
        { equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 10, observedAt: hoursAgo(1) },
      ],
    });
    await openMeasurements(page);
    const toggle = page.getByRole('button', { name: 'データの状態の見かた' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('quality-legend-body')).toHaveCount(0);

    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const body = page.getByTestId('quality-legend-body');
    await expect(body.getByTestId('quality-legend-VALID')).toContainText('評価に使います');
    await expect(body.getByTestId('quality-legend-MISSING')).toContainText('評価に使いません');
    await expect(body.getByTestId('quality-legend-LATE')).toContainText('評価に使います');
    await expect(body.getByTestId('quality-legend-INVALID')).toContainText('評価に使いません');
    await expectNoHorizontalScroll(page);

    await toggle.click();
    await expect(page.getByTestId('quality-legend-body')).toHaveCount(0);
  });
});

test.describe('手動入力の行からの導線（#155。SC-09-5）', () => {
  test('手動入力の行の「入力データを開く」で、設備・計測日で絞った入力データ一覧へ、「履歴」で、その入力の変更履歴へ移る。自動取り込みの行には、導線がない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    const created = await addEntry(request, {
      category: 'FAILURE',
      observedAt: hoursAgo(3),
      items: { failureCount: 2, recoveryMinutes: 90 },
    });
    await seed(request, {
      observations: [
        {
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: 22,
          observedAt: hoursAgo(2),
        },
      ],
    });
    await openMeasurements(page);

    const manual = measurementRows(page).filter({ hasText: '故障回数' });
    const auto = measurementRows(page).filter({ hasText: '温度' });
    await expect(manual).toHaveCount(1);
    await expect(auto).toHaveCount(1);
    await expect(auto.getByRole('link')).toHaveCount(0);
    await shot(page, testInfo, 'uc20-manual-row-links');

    await manual.getByRole('link', { name: '入力データを開く' }).click();
    await expect(page.getByRole('heading', { name: '入力済みデータ', level: 1 })).toBeVisible();
    await expect.poll(() => page.url()).toContain('/data-entry/list?equipmentId=ROBOT-01&from=');
    await expect(page.getByTestId('entry-row')).toHaveCount(1);
    await expect(page.getByTestId('entry-row')).toContainText('故障回数: 2回');

    await page.goBack();
    await manual.getByRole('link', { name: '履歴', exact: true }).click();
    await expect
      .poll(() => page.url())
      .toContain(`/data-entry/history?targetType=manual-entry&targetId=${created.entry.entryId}`);
    await expect(page.getByTestId('audit-row')).toHaveCount(1);
    await expect(page.getByTestId('audit-target-chip')).toContainText('故障回数');
  });
});

test.describe('評価に使われていない手動入力の印（SC-09-4。Issue #162）', () => {
  test('自動取り込みの値がある期間の、合計の項目の手動入力の行に、「評価に使われていません」を付け、ヘルプヒントで理由を示す。自動取り込みの行・合計でない項目・自動のない項目の手動入力には付けない（計測ごと・項目ごとの両方）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, {
      observations: [
        { equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 1800, observedAt: hoursAgo(3) },
        {
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: 22,
          observedAt: hoursAgo(3),
        },
      ],
    });
    // 収穫数は、自動の値がある（使われない）。稼働時間は、自動がない（使われる）。温度は、合計の項目ではない（自動があっても使われる）
    await addEntry(request, {
      category: 'HARVEST',
      observedAt: hoursAgo(2),
      items: { harvestCount: 1700 },
    });
    await addEntry(request, {
      category: 'OPERATION',
      observedAt: hoursAgo(2),
      items: { operatingHours: 5 },
    });
    await addEntry(request, {
      category: 'ENVIRONMENT',
      observedAt: hoursAgo(2),
      items: { temperatureCelsius: 25 },
    });

    // 計測ごとの一覧
    await openMeasurements(page);
    const harvestItem = measurementRows(page)
      .filter({ hasText: '手動入力' })
      .getByTestId('measurement-item')
      .filter({ hasText: '収穫数' });
    const hoursItem = measurementRows(page)
      .filter({ hasText: '手動入力' })
      .getByTestId('measurement-item')
      .filter({ hasText: '稼働時間' });
    await expect(harvestItem.getByTestId('usage-tag')).toContainText('評価に使われていません');
    await expect(hoursItem.getByTestId('usage-tag')).toHaveCount(0);
    await expect(page.getByTestId('usage-tag')).toHaveCount(1);
    await harvestItem.getByRole('button', { name: '評価での扱いの説明' }).click();
    await expect(harvestItem.getByRole('note')).toHaveText(
      'この期間は自動取り込みの値を使うため、この入力は評価に使われません',
    );
    await expectNoHorizontalScroll(page);
    await shot(page, testInfo, 'uc20-unused-manual-tag');

    // 項目ごとの一覧
    await openObservations(page);
    const harvestRows = rows(page).filter({ hasText: '収穫数' });
    await expect(harvestRows).toHaveCount(2);
    await expect(harvestRows.filter({ hasText: '手動入力' }).getByTestId('usage-tag')).toHaveCount(
      1,
    );
    await expect(
      harvestRows.filter({ hasText: '自動取り込み' }).getByTestId('usage-tag'),
    ).toHaveCount(0);
    await expect(page.getByTestId('usage-tag')).toHaveCount(1);
  });
});
