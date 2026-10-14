/**
 * UC-22 通知を一覧で確認し、既読にする（SC-05。FR-7.5、FR-7.6）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、ヘッダーの未読件数から、通知の一覧を開く
 *               2. システムが、日時・種別（異常検知／データ取得失敗）・対象の観点・メッセージ・既読状態を一覧で表示する
 *               3. 農作業者が、種別、既読／未読で絞り込む
 *               4. 農作業者が、通知を個別に、または一括で既読にする
 *   代替フロー  通知がない場合は、その旨を表示する
 *   事後条件    既読の状態が更新され、未読の件数に反映される
 *
 * 値の同値分割: 種別（すべて・異常検知・データ取得失敗）× 既読状態（すべて・未読・既読）の9通り、既読にする範囲
 * （個別・絞り込みの範囲・すべて）、件数（0件・1ページ・複数ページ）、利用者（既読は利用者ごと）。
 * 関連するユースケース: UC-05（通知から対象の確認へ）、UC-10・UC-24（通知の発生）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  HOUSE_ID,
  ROBOT_ID,
  SENSOR_ID,
  USER_B,
  addUser,
  alignBrowserClock,
  apiOk,
  newUserSession,
  openAs,
  prepareApp,
  unreadBadge,
} from './support/app.ts';
import {
  failIngestion,
  failIngestionRepeatedly,
  listNotifications,
  markReadViaApi,
  seedAbnormalEnvironment,
} from './support/notifications.ts';
import { shot } from './support/viewpoint-scenarios.ts';
import { expectHeaderIntact, locatorOf } from './support/pages.ts';

const rows = locatorOf('notification-row');
const kindFilter = (page: Page) => page.getByLabel('種別');
const stateFilter = (page: Page) => page.getByLabel('既読状態');

/** 通知を5件作る（異常検知3件・データ取得失敗2件）。 */
async function prepareFiveNotifications(request: Parameters<typeof prepareApp>[0]): Promise<void> {
  await prepareApp(request);
  await seedAbnormalEnvironment(request);
  await failIngestion(request, ['robot', 'environment-sensor']);
}

async function openNotifications(page: Page, query = ''): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, `/notifications${query}`);
  await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
}

test.describe('基本フロー: ヘッダーの未読件数から、通知の一覧を開く', () => {
  test('未読件数のリンクから通知の一覧を開き、日時・種別・観点・対象・ステータス・メッセージ・既読状態を、新しい順に表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareFiveNotifications(request);
    await alignBrowserClock(page);
    await openAs(page, '/');
    await expect(unreadBadge(page)).toHaveText('5');

    // 1. ヘッダーの未読件数から、通知の一覧を開く
    await page.getByRole('link', { name: '未読の通知: 5件' }).click();

    // 2. 一覧を表示する
    await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
    await expect(rows(page)).toHaveCount(5);
    await expect(page.getByRole('columnheader').allTextContents()).resolves.toEqual([
      '日時',
      '種別',
      '観点',
      '対象',
      'ステータス',
      'メッセージ',
      '状態',
    ]);
    const environmentOfHouse = rows(page)
      .filter({ hasText: '環境適応性' })
      .filter({ hasText: 'ハウス1' });
    await expect(environmentOfHouse).toContainText('異常検知');
    await expect(environmentOfHouse).toContainText('異常');
    await expect(environmentOfHouse).toContainText('未読');
    const failure = rows(page)
      .filter({ hasText: 'データ取得失敗' })
      .filter({ hasText: 'ロボットデータ' });
    await expect(failure).toHaveCount(1);
    await expect(failure).toContainText('ファイルサーバーに接続できませんでした');
    // 新しい順（日時が、新しいものから並ぶ）
    const times = await rows(page)
      .locator('time')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('datetime') ?? ''));
    expect([...times].sort().reverse()).toEqual(times);
    await shot(page, testInfo, 'uc22-list');
  });

  test('通知がない場合は、その旨を表示する', async ({ page, request }) => {
    await prepareApp(request);

    await openNotifications(page);

    await expect(page.getByTestId('notifications-empty')).toHaveText('通知はありません');
    await expect(unreadBadge(page)).toHaveText('0');
  });
});

test.describe('絞り込み: 種別 × 既読状態（9通り）', () => {
  const combinations: readonly { kind: string; state: string; expected: number }[] = [
    { kind: '', state: '', expected: 5 },
    { kind: 'STATUS_CHANGE', state: '', expected: 3 },
    { kind: 'INGESTION_FAILURE', state: '', expected: 2 },
    { kind: '', state: 'UNREAD', expected: 3 },
    { kind: '', state: 'READ', expected: 2 },
    { kind: 'STATUS_CHANGE', state: 'UNREAD', expected: 2 },
    { kind: 'STATUS_CHANGE', state: 'READ', expected: 1 },
    { kind: 'INGESTION_FAILURE', state: 'UNREAD', expected: 1 },
    { kind: 'INGESTION_FAILURE', state: 'READ', expected: 1 },
  ];

  for (const item of combinations) {
    test(`種別「${item.kind === '' ? 'すべて' : item.kind === 'STATUS_CHANGE' ? '異常検知' : 'データ取得失敗'}」× 既読状態「${item.state === '' ? 'すべて' : item.state === 'UNREAD' ? '未読' : '既読'}」は ${String(item.expected)} 件`, async ({
      page,
      request,
    }) => {
      await prepareFiveNotifications(request);
      // 異常検知（ハウスの環境適応性）と、データ取得失敗（ロボットデータ）を、既読にしておく
      const all = await listNotifications(request);
      for (const notification of all) {
        const isHouseEnvironment =
          notification.viewpointId === 'environmentalAdaptability' &&
          notification.equipmentId === 'HOUSE-01';
        const isRobotFailure = notification.sourceId === 'robot';
        if (isHouseEnvironment || isRobotFailure) {
          await markReadViaApi(request, notification.notificationId);
        }
      }
      await openNotifications(page);
      await expect(rows(page)).toHaveCount(5);

      await kindFilter(page).selectOption(item.kind);
      await stateFilter(page).selectOption(item.state);

      await expect(rows(page)).toHaveCount(item.expected);
      if (item.kind !== '') {
        await expect(page).toHaveURL(new RegExp(`kind=${item.kind}`));
      }
      if (item.state !== '') {
        await expect(page).toHaveURL(new RegExp(`readState=${item.state}`));
      }
      for (const row of await rows(page).all()) {
        if (item.state !== '') {
          await expect(row).toHaveAttribute('data-read-state', item.state);
        }
      }
    });
  }

  test('絞り込みの条件は URL に反映され、再読み込みしても保持される。条件に合う通知がなければ、その旨を表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareFiveNotifications(request);
    await openNotifications(page, '?kind=INGESTION_FAILURE&readState=READ');
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId('notifications-empty')).toHaveText('条件に合う通知はありません');
    await expect(kindFilter(page)).toHaveValue('INGESTION_FAILURE');

    await page.reload();

    await expect(kindFilter(page)).toHaveValue('INGESTION_FAILURE');
    await expect(stateFilter(page)).toHaveValue('READ');
    await expect(page.getByTestId('notifications-empty')).toBeVisible();
    await shot(page, testInfo, 'uc22-filtered-empty');
  });

  test('不正なクエリの値（種別・既読状態）は、無視して、すべてを表示する', async ({
    page,
    request,
  }) => {
    await prepareFiveNotifications(request);

    await openNotifications(page, '?kind=UNKNOWN&readState=SOMETHING');

    await expect(kindFilter(page)).toHaveValue('');
    await expect(stateFilter(page)).toHaveValue('');
    await expect(rows(page)).toHaveCount(5);
  });
});

test.describe('基本フロー 4: 通知を個別に、または一括で既読にする', () => {
  test('通知を個別に既読にすると、その通知だけが既読になり、ヘッダーの未読件数に反映され、再読み込みしても保持される', async ({
    page,
    request,
  }) => {
    await prepareFiveNotifications(request);
    await openNotifications(page);
    await expect(unreadBadge(page)).toHaveText('5');
    const target = rows(page).filter({ hasText: 'ロボットデータ' });

    await target.getByRole('button', { name: '既読にする' }).click();

    await expect(target).toHaveAttribute('data-read-state', 'READ');
    await expect(target.getByRole('button', { name: '既読にする' })).toHaveCount(0);
    await expect(unreadBadge(page)).toHaveText('4');
    await expect(page.getByRole('link', { name: '未読の通知: 4件' })).toBeVisible();
    await page.reload();
    await expect(rows(page).filter({ hasText: 'ロボットデータ' })).toHaveAttribute(
      'data-read-state',
      'READ',
    );
    await expect(unreadBadge(page)).toHaveText('4');
  });

  test('絞り込みの範囲を既読にすると、範囲内の未読だけが既読になる（範囲外は未読のまま）', async ({
    page,
    request,
  }) => {
    await prepareFiveNotifications(request);
    await openNotifications(page, '?kind=INGESTION_FAILURE');
    await expect(rows(page)).toHaveCount(2);

    await page.getByRole('button', { name: '絞り込みの範囲を既読にする' }).click();

    await expect(rows(page).first()).toHaveAttribute('data-read-state', 'READ');
    await expect(rows(page).nth(1)).toHaveAttribute('data-read-state', 'READ');
    await expect(unreadBadge(page)).toHaveText('3');
    await kindFilter(page).selectOption('STATUS_CHANGE');
    for (const row of await rows(page).all()) {
      await expect(row).toHaveAttribute('data-read-state', 'UNREAD');
    }
  });

  test('絞り込みがないときは、「絞り込みの範囲を既読にする」を選べない。すべての通知を既読にできる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareFiveNotifications(request);
    await openNotifications(page);
    await expect(page.getByRole('button', { name: '絞り込みの範囲を既読にする' })).toBeDisabled();

    await page.getByRole('button', { name: 'すべての通知を既読にする' }).click();

    await expect(unreadBadge(page)).toHaveText('0');
    for (const row of await rows(page).all()) {
      await expect(row).toHaveAttribute('data-read-state', 'READ');
    }
    await shot(page, testInfo, 'uc22-all-read');
  });

  test('既読にした通知を、未読の絞り込みで探すと、表示されない', async ({ page, request }) => {
    await prepareFiveNotifications(request);
    await openNotifications(page, '?readState=UNREAD');
    await expect(rows(page)).toHaveCount(5);
    const message =
      (await rows(page).first().locator('.notification-message p').textContent()) ?? '';

    await rows(page).first().getByRole('button', { name: '既読にする' }).click();

    await expect(rows(page)).toHaveCount(4);
    await expect(rows(page).filter({ hasText: message })).toHaveCount(0);
    // 既読の絞り込みでは、その通知が表示される
    await openNotifications(page, '?readState=READ');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(message);
  });
});

test.describe('通知から対象を確認する（UC-05への連携）', () => {
  test('異常検知の通知から、対象の観点の詳細を開くと、対象の設備が選ばれ、通知が既読になる', async ({
    page,
    request,
  }) => {
    await prepareFiveNotifications(request);
    await openNotifications(page);
    const sensorRow = rows(page)
      .filter({ hasText: '環境適応性' })
      .filter({ hasText: '環境センサー1' });

    await sensorRow.getByRole('link', { name: '詳細を確認' }).click();

    await expect(page).toHaveURL(/\/viewpoints\/environmentalAdaptability/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('環境適応性');
    await expect(page.locator('.page-meta')).toContainText('対象: 環境センサー1');
    await expect(page.getByRole('banner').getByLabel('対象の設備')).toHaveValue('SENSOR-01');
    await expect(unreadBadge(page)).toHaveText('4');
  });

  test('データ取得失敗の通知から、取り込みの状況を開くと、通知が既読になる', async ({
    page,
    request,
  }) => {
    await prepareFiveNotifications(request);
    await openNotifications(page);

    await rows(page)
      .filter({ hasText: 'ロボットデータ' })
      .getByRole('link', { name: '取り込みの状況を確認' })
      .click();

    await expect(page).toHaveURL(/\/settings\/ingestion/);
    await expect(page.getByRole('heading', { name: '取り込み設定・状況', level: 1 })).toBeVisible();
    await expect(unreadBadge(page)).toHaveText('4');
  });

  test('すでに既読の通知から開いても、件数は変わらない', async ({ page, request }) => {
    await prepareFiveNotifications(request);
    const all = await listNotifications(request);
    const robotFailure = all.find((item) => item.sourceId === 'robot');
    await markReadViaApi(request, robotFailure?.notificationId ?? '');
    await openNotifications(page);
    await expect(unreadBadge(page)).toHaveText('4');

    await rows(page)
      .filter({ hasText: 'ロボットデータ' })
      .getByRole('link', { name: '取り込みの状況を確認' })
      .click();

    await expect(page).toHaveURL(/\/settings\/ingestion/);
    await expect(unreadBadge(page)).toHaveText('4');
  });
});

test.describe('ページ分割（20件ごと）', () => {
  test('21件の通知は、1ページ目に20件、2ページ目に1件を表示し、前後のページへ移動できる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await failIngestionRepeatedly(request, 21);
    await openNotifications(page);
    await expect(rows(page)).toHaveCount(20);
    await expect(page.getByTestId('pager-page')).toHaveText('1');
    await expect(page.getByRole('button', { name: '前へ' })).toBeDisabled();
    await shot(page, testInfo, 'uc22-page-1');

    await page.getByRole('button', { name: '次へ' }).click();

    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId('pager-page')).toHaveText('2');
    await expect(page.getByRole('button', { name: '次へ' })).toBeDisabled();
    await page.getByRole('button', { name: '前へ' }).click();
    await expect(rows(page)).toHaveCount(20);
    await expect(page.getByTestId('pager-page')).toHaveText('1');
  });

  test('絞り込みを変えると、先頭のページへ戻る', async ({ page, request }) => {
    await prepareApp(request);
    await failIngestionRepeatedly(request, 21);
    await openNotifications(page);
    await page.getByRole('button', { name: '次へ' }).click();
    await expect(page.getByTestId('pager-page')).toHaveText('2');

    await kindFilter(page).selectOption('INGESTION_FAILURE');

    await expect(page.getByTestId('pager-page')).toHaveText('1');
    await expect(rows(page)).toHaveCount(20);
  });
});

test.describe('シナリオ: 複数の利用者（A・B）が、同じ通知を、それぞれ既読にする（既読は利用者ごと）', () => {
  test('利用者Aが既読にしても、利用者Bの未読は変わらない。Bが既読にしても、Aの既読は変わらない', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareFiveNotifications(request);
    await addUser(request, USER_B);
    // 利用者A: 2件を既読にする
    await openNotifications(page);
    await expect(unreadBadge(page)).toHaveText('5');
    await rows(page).nth(0).getByRole('button', { name: '既読にする' }).click();
    await rows(page).nth(1).getByRole('button', { name: '既読にする' }).click();
    await expect(unreadBadge(page)).toHaveText('3');

    // 利用者B: 別のブラウザで、ログインする。未読は、5件のまま
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/notifications', USER_B);
    await expect(unreadBadge(b.page)).toHaveText('5');
    await expect(rows(b.page)).toHaveCount(5);
    for (const row of await rows(b.page).all()) {
      await expect(row).toHaveAttribute('data-read-state', 'UNREAD');
    }
    // 利用者B: 全件を既読にする
    await b.page.getByRole('button', { name: 'すべての通知を既読にする' }).click();
    await expect(unreadBadge(b.page)).toHaveText('0');
    await shot(b.page, testInfo, 'uc22-user-b-all-read');

    // 利用者A: 再読み込みしても、既読は 2 件のまま（3件は未読）
    await page.reload();
    await expect(unreadBadge(page)).toHaveText('3');
    await expect(rows(page).and(page.locator('[data-read-state="READ"]'))).toHaveCount(2);
    await b.context.close();
  });
});

// ---------------------------------------------------------------------------
// 長い値（設備名 200 文字を含むメッセージ）・大量の通知・未読件数の桁数・画面の幅でも、表・ヘッダーが潰れず、はみ出さない（NFR-7.3）
// ---------------------------------------------------------------------------

const LONG_NAME_JAPANESE = '長い設備名'.repeat(40);
const LONG_NAME_ASCII = 'E'.repeat(200);

/** 通知の表が、列ごとに 1 文字幅へ潰れず、ページが横にはみ出さないことを確認する。 */
async function expectNotificationTableNotCrushed(page: Page): Promise<void> {
  const headerHeights = await page
    .locator('.notification-table thead th')
    .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().height));
  expect(Math.max(...headerHeights), `見出しの高さ ${String(headerHeights)}`).toBeLessThan(48);
  // 日時・ステータス・既読状態のラベル・「既読にする」ボタンは、折り返さず 1 行
  for (const [selector, name, limit] of [
    ['.notification-table tbody time', '日時', 30],
    ['.notification-table tbody .status-badge', 'ステータス', 36],
    ['.notification-table tbody .read-state', '既読状態のラベル', 30],
    ['.notification-table tbody .notification-state button', '「既読にする」ボタン', 48],
  ] as const) {
    const heights = await page
      .locator(selector)
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(Math.max(...heights), `${name}の高さ ${String(heights)}`).toBeLessThan(limit);
  }
  // メッセージの欄は、1 文字幅へ潰れず、読める幅を保つ
  const messageWidths = await page
    .locator('.notification-table tbody td.notification-message')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
  expect(Math.min(...messageWidths), `メッセージの幅 ${String(messageWidths)}`).toBeGreaterThan(
    150,
  );
  // ページ全体が、横にはみ出さない（表が枠より広い場合は、表の枠の中で横にスクロールする）
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const frame = await page.locator('.notification-table').locator('xpath=..').boundingBox();
  expect((frame?.x ?? 0) + (frame?.width ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );
}

/** ヘッダーの未読件数（ベルと件数）が、1 行で、ページの幅の中に収まり、他の要素と重ならない。 */
async function expectUnreadBadgeIntact(page: Page, expectedText: string): Promise<void> {
  await expect(unreadBadge(page)).toHaveText(expectedText);
  const link = page.locator('.header-unread');
  const box = await link.boundingBox();
  const own = {
    x: box?.x ?? -1,
    y: box?.y ?? -1,
    width: box?.width ?? 0,
    height: box?.height ?? 0,
  };
  expect(own.x).toBeGreaterThanOrEqual(0);
  expect(own.x + own.width, '未読件数の右端').toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  expect(own.height, '未読件数の高さ（1行）').toBeLessThan(44);
  const bell = await link.locator('span').first().boundingBox();
  const count = await unreadBadge(page).boundingBox();
  expect(Math.abs((bell?.y ?? 0) - (count?.y ?? 100)), 'ベルと件数が同じ行').toBeLessThan(12);
  // 件数の文字が、枠からあふれない
  expect(await unreadBadge(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(
    true,
  );
  // ヘッダー内の他の要素（タイトル・設備の選択・ユーザー）と重ならない
  const siblings = await page
    .locator('.app-header-row > *')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
  for (const other of siblings) {
    if (Math.abs(other.x - own.x) < 1 && Math.abs(other.y - own.y) < 1) {
      continue;
    }
    const overlapWidth = Math.min(other.right, own.x + own.width) - Math.max(other.left, own.x);
    const overlapHeight = Math.min(other.bottom, own.y + own.height) - Math.max(other.top, own.y);
    expect(overlapWidth > 1 && overlapHeight > 1, 'ヘッダーの要素が重なる').toBe(false);
  }
}

/** 絞り込みの欄・ボタンが、ページの幅の中に収まり、重ならない。 */
async function expectFilterBarIntact(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  const rects = await page
    .locator('.filter-bar .field, .filter-actions button')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
  for (const [index, rect] of rects.entries()) {
    expect(rect.left, `絞り込みの要素 ${String(index)} の左端`).toBeGreaterThanOrEqual(0);
    expect(rect.right, `絞り込みの要素 ${String(index)} の右端`).toBeLessThanOrEqual(width);
    for (const other of rects.slice(index + 1)) {
      const overlapWidth = Math.min(rect.right, other.right) - Math.max(rect.left, other.left);
      const overlapHeight = Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top);
      expect(overlapWidth > 1 && overlapHeight > 1, '絞り込みの要素が重なる').toBe(false);
    }
  }
}

const NOTIFICATION_VIEWPORTS = [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 720 },
  { name: 'タブレット幅（768px。NFR-7.3）', width: 768, height: 1024 },
  { name: 'スマートフォン幅（375px）', width: 375, height: 667 },
] as const;

for (const viewport of NOTIFICATION_VIEWPORTS) {
  test.describe(`${viewport.name}: 長い設備名・大量の通知でも、一覧の表とヘッダーが潰れず、はみ出さない`, () => {
    for (const [name, equipmentName] of [
      ['日本語の設備名200文字（上限）', LONG_NAME_JAPANESE],
      ['区切りのない英字の設備名200文字（上限）', LONG_NAME_ASCII],
    ] as const) {
      test(`${name}を含む通知（メッセージ・対象）`, async ({ page, request }, testInfo) => {
        await prepareApp(request);
        for (const id of [HOUSE_ID, ROBOT_ID, SENSOR_ID]) {
          await apiOk(request, 'PUT', `/equipment/${id}`, { name: equipmentName });
        }
        await seedAbnormalEnvironment(request);
        await failIngestion(request, ['robot', 'environment-sensor']);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });

        await openNotifications(page);

        await expect(rows(page)).toHaveCount(5);
        await expectNotificationTableNotCrushed(page);
        await expectHeaderIntact(page);
        await expectUnreadBadgeIntact(page, '5');
        await expectFilterBarIntact(page);
        // 長い名称の行でも、「既読にする」を、表示領域へ移して使える
        const longRow = rows(page).filter({ hasText: '環境適応性' }).first();
        await longRow.getByRole('button', { name: '既読にする' }).scrollIntoViewIfNeeded();
        await expect(longRow.getByRole('button', { name: '既読にする' })).toBeInViewport();
        // 900px 以下は、通知ごとのカードで表示し、横にスクロールしなくても、「既読にする」「詳細を確認」に届く
        if (viewport.width <= 900) {
          for (const target of [
            longRow.getByRole('button', { name: '既読にする' }),
            longRow.getByRole('link', { name: '詳細を確認' }),
          ]) {
            const box = await target.boundingBox();
            expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
            expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
          }
        }
        // 表の枠の中の横スクロールを、先頭へ戻して撮影する
        await page.locator('.table-scroll').evaluate((node) => {
          node.scrollLeft = 0;
        });
        const kind = equipmentName === LONG_NAME_ASCII ? 'ascii' : 'ja';
        await shot(page, testInfo, `uc22-long-${String(viewport.width)}-${kind}`);
      });
    }

    test('大量の通知（105件・6ページ）と、未読件数が3桁（105）でも、ページを移動しながら、表・ヘッダーが崩れない。既読にすると、件数が減る', async ({
      page,
      request,
    }, testInfo) => {
      await prepareApp(request);
      await failIngestionRepeatedly(request, 105);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openNotifications(page);
      await expect(rows(page)).toHaveCount(20);
      await expectUnreadBadgeIntact(page, '105');
      await expect(page.getByRole('link', { name: '未読の通知: 105件' })).toBeVisible();

      for (const expected of [20, 20, 20, 20, 20, 5]) {
        await expect(rows(page)).toHaveCount(expected);
        await expectNotificationTableNotCrushed(page);
        await expectHeaderIntact(page);
        await expectFilterBarIntact(page);
        if (expected !== 5) {
          await page.getByRole('button', { name: '次へ' }).click();
        }
      }
      await expect(page.getByTestId('pager-page')).toHaveText('6');
      await expect(page.getByRole('button', { name: '次へ' })).toBeDisabled();
      await page.getByRole('button', { name: '前へ' }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: '前へ' })).toBeInViewport();
      await shot(page, testInfo, `uc22-many-${String(viewport.width)}`);

      // 最後のページで 1 件を既読にすると、件数が 104 になる。すべてを既読にすると 0 になる
      await rows(page).first().getByRole('button', { name: '既読にする' }).click();
      await expectUnreadBadgeIntact(page, '104');
      await page.getByRole('button', { name: 'すべての通知を既読にする' }).scrollIntoViewIfNeeded();
      await page.getByRole('button', { name: 'すべての通知を既読にする' }).click();
      await expectUnreadBadgeIntact(page, '0');
      await expectNotificationTableNotCrushed(page);
    });
  });
}
