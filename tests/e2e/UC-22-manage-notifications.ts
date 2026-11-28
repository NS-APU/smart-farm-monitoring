/**
 * UC-22 通知を一覧で確認し、既読にする（SC-05。FR-7.5、FR-7.6）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、ヘッダーの未読件数から、通知の一覧を開く
 *               2. システムが、日時・種別（状態の悪化／データ取得失敗）・対象の観点・メッセージ・既読状態を一覧で表示する
 *               3. 農作業者が、種別、既読／未読で絞り込む
 *               4. 農作業者が、通知を個別に、または一括で既読にする
 *   代替フロー  通知がない場合は、その旨を表示する
 *   事後条件    既読の状態が更新され、未読の件数に反映される
 *
 * 値の同値分割: 種別（すべて・状態の悪化・データ取得失敗）× 既読状態（すべて・未読・既読）の9通り、既読にする範囲
 * （個別・絞り込みの範囲・すべて）、件数（0件・1ページ・複数ページ）、利用者（既読は利用者ごと）。
 * 通知の経過・回復日時（Issue #238。D-42）: 通知一覧の API が、通知ごとに、次の通知までの経過と、最初に正常に戻った日時を返す。
 * 通知のメモ（Issue #239。D-42）: 利用者が、通知にメモを追記でき（共有・追記のみ）、入力者と日時が残る。通知一覧が、メモの件数を返す。
 * 通知から観点の詳細へ（#159 の SC-05-6）: ダッシュボード上のドロワーで開き、対象のハウスは通知のハウスになる。約 10 秒の再取得（SC-05-10）: 新着は自動では加えず、「新着あり（N 件）」を示す。
 * 通知一覧の画面（Issue #159 の SC-05-1）: 経過・回復日時（回復あり・未回復・経過なし）と、メモの表示・入力（共有・追記のみ。入力の権限がない場合は、単体テスト）を示す。
 * 関連するユースケース: UC-05（通知から対象の確認へ）、UC-10・UC-24（通知の発生）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  GENERAL,
  HOUSE_ID,
  ROBOT_ID,
  SENSOR_ID,
  USER_B,
  accessToken,
  addUser,
  alignBrowserClock,
  api,
  apiOk,
  confirmDialog,
  newUserSession,
  openAs,
  prepareApp,
  unreadBadge,
} from './support/app.ts';
import {
  type ApiNotification,
  failIngestion,
  failIngestionRepeatedly,
  listNotifications,
  markReadViaApi,
  seedAbnormalEnvironment,
} from './support/notifications.ts';
import { advanceMinutes } from './support/app.ts';
import {
  environmentData,
  harvestAccuracyData,
  hoursAgo,
  seed,
  shot,
} from './support/viewpoint-scenarios.ts';
import { E2E_USER } from './support/e2e-user.ts';
import { expectHeaderIntact, locatorOf, userLabelText } from './support/pages.ts';

const rows = locatorOf('notification-row');
const kindFilter = (page: Page) => page.getByLabel('種別');
const stateFilter = (page: Page) => page.getByLabel('既読状態');

/** 通知を4件作る（状態の悪化2件〔センサーの環境適応性・ハウスのデータ活用度合い〕・データ取得失敗2件）。 */
async function prepareFourNotifications(request: Parameters<typeof prepareApp>[0]): Promise<void> {
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
    await prepareFourNotifications(request);
    await alignBrowserClock(page);
    await openAs(page, '/');
    await expect(unreadBadge(page)).toHaveText('4');

    // 1. ヘッダーの未読件数から、通知の一覧を開く
    await page.getByRole('link', { name: '未読の通知: 4件' }).click();

    // 2. 一覧を表示する
    await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
    await expect(rows(page)).toHaveCount(4);
    await expect(page.getByRole('columnheader').allTextContents()).resolves.toEqual([
      '日時',
      '種別',
      '観点',
      '対象',
      '設備',
      'ステータス',
      'メッセージ',
      '状態',
    ]);
    // 対象は、ハウスの名称。設備の列は、ロボット・環境センサーの名称（ハウスの通知は「—」。Issue #362）
    const cell = (row: ReturnType<typeof rows>, column: number) => row.locator('td').nth(column);
    // ハウスの通知は、運用面の観点（データ活用度合い）だけ。環境適応性は、設備（センサー）の通知だけ
    const houseRow = rows(page).filter({ hasText: 'データ活用度合い' });
    await expect(cell(houseRow, 3)).toHaveText('ハウス1');
    await expect(cell(houseRow, 4)).toHaveText('—');
    const sensorRow = rows(page).filter({ hasText: '（環境センサー1）' });
    await expect(cell(sensorRow, 3)).toHaveText('ハウス1');
    await expect(cell(sensorRow, 4)).toHaveText('環境センサー1');
    const environment = rows(page).filter({ hasText: '環境適応性' });
    await expect(environment).toHaveCount(1);
    await expect(environment).toContainText('状態の悪化');
    await expect(environment).toContainText('異常');
    await expect(environment).toContainText('未読');
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
    { kind: '', state: '', expected: 4 },
    { kind: 'STATUS_CHANGE', state: '', expected: 2 },
    { kind: 'INGESTION_FAILURE', state: '', expected: 2 },
    { kind: '', state: 'UNREAD', expected: 2 },
    { kind: '', state: 'READ', expected: 2 },
    { kind: 'STATUS_CHANGE', state: 'UNREAD', expected: 1 },
    { kind: 'STATUS_CHANGE', state: 'READ', expected: 1 },
    { kind: 'INGESTION_FAILURE', state: 'UNREAD', expected: 1 },
    { kind: 'INGESTION_FAILURE', state: 'READ', expected: 1 },
  ];

  for (const item of combinations) {
    test(`種別「${item.kind === '' ? 'すべて' : item.kind === 'STATUS_CHANGE' ? '状態の悪化' : 'データ取得失敗'}」× 既読状態「${item.state === '' ? 'すべて' : item.state === 'UNREAD' ? '未読' : '既読'}」は ${String(item.expected)} 件`, async ({
      page,
      request,
    }) => {
      await prepareFourNotifications(request);
      // 状態の悪化（センサーの環境適応性）と、データ取得失敗（ロボットデータ）を、既読にしておく
      const all = await listNotifications(request);
      for (const notification of all) {
        const isSensorEnvironment =
          notification.viewpointId === 'environmentalAdaptability' &&
          notification.equipmentId === 'SENSOR-01';
        const isRobotFailure = notification.sourceId === 'robot';
        if (isSensorEnvironment || isRobotFailure) {
          await markReadViaApi(request, notification.notificationId);
        }
      }
      await openNotifications(page);
      await expect(rows(page)).toHaveCount(4);

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
    await prepareFourNotifications(request);
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

  test('適用中の条件の数を示し、条件のクリアで、種別・既読状態を初期値（すべて）に戻す（SC-07-3）', async ({
    page,
    request,
  }) => {
    await prepareFourNotifications(request);
    await openNotifications(page, '?kind=STATUS_CHANGE&readState=UNREAD');
    await expect(page.getByTestId('filter-active-count')).toHaveText('適用中の条件 2 件');
    await expect(rows(page)).toHaveCount(2);

    await page.getByRole('button', { name: '条件のクリア' }).click();

    await expect(kindFilter(page)).toHaveValue('');
    await expect(stateFilter(page)).toHaveValue('');
    await expect(rows(page)).toHaveCount(4);
    await expect(page.getByTestId('filter-active-count')).toHaveCount(0);
    await expect(page).not.toHaveURL(/kind=|readState=/);
  });

  test('不正なクエリの値（種別・既読状態）は、無視して、すべてを表示する', async ({
    page,
    request,
  }) => {
    await prepareFourNotifications(request);

    await openNotifications(page, '?kind=UNKNOWN&readState=SOMETHING');

    await expect(kindFilter(page)).toHaveValue('');
    await expect(stateFilter(page)).toHaveValue('');
    await expect(rows(page)).toHaveCount(4);
  });
});

test.describe('基本フロー 4: 通知を個別に、または一括で既読にする', () => {
  test('通知を個別に既読にすると、その通知だけが既読になり、ヘッダーの未読件数に反映され、再読み込みしても保持される', async ({
    page,
    request,
  }) => {
    await prepareFourNotifications(request);
    await openNotifications(page);
    await expect(unreadBadge(page)).toHaveText('4');
    const target = rows(page).filter({ hasText: 'ロボットデータ' });

    await target.getByRole('button', { name: '既読にする' }).click();

    await expect(target).toHaveAttribute('data-read-state', 'READ');
    await expect(target.getByRole('button', { name: '既読にする' })).toHaveCount(0);
    await expect(unreadBadge(page)).toHaveText('3');
    await expect(page.getByRole('link', { name: '未読の通知: 3件' })).toBeVisible();
    await page.reload();
    await expect(rows(page).filter({ hasText: 'ロボットデータ' })).toHaveAttribute(
      'data-read-state',
      'READ',
    );
    await expect(unreadBadge(page)).toHaveText('3');
  });

  test('絞り込みの範囲を既読にすると、範囲内の未読だけが既読になる（範囲外は未読のまま）', async ({
    page,
    request,
  }) => {
    await prepareFourNotifications(request);
    await openNotifications(page, '?kind=INGESTION_FAILURE');
    await expect(rows(page)).toHaveCount(2);

    await page.getByRole('button', { name: '絞り込みの範囲を既読にする' }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('未読の通知 2 件を既読にします');
    await confirmDialog(page, '既読にする');

    await expect(rows(page).first()).toHaveAttribute('data-read-state', 'READ');
    await expect(rows(page).nth(1)).toHaveAttribute('data-read-state', 'READ');
    await expect(unreadBadge(page)).toHaveText('2');
    await kindFilter(page).selectOption('STATUS_CHANGE');
    for (const row of await rows(page).all()) {
      await expect(row).toHaveAttribute('data-read-state', 'UNREAD');
    }
  });

  test('絞り込みがないときは、「絞り込みの範囲を既読にする」を選べない。すべての通知を既読にできる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareFourNotifications(request);
    await openNotifications(page);
    await expect(page.getByRole('button', { name: '絞り込みの範囲を既読にする' })).toBeDisabled();

    await page.getByRole('button', { name: 'すべての通知を既読にする' }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('未読の通知 4 件を既読にします');
    await confirmDialog(page, '既読にする');

    await expect(unreadBadge(page)).toHaveText('0');
    for (const row of await rows(page).all()) {
      await expect(row).toHaveAttribute('data-read-state', 'READ');
    }
    await shot(page, testInfo, 'uc22-all-read');
  });

  test('一括既読の確認で「キャンセル」を選ぶと、既読にならない。既読にする未読がないときは、確認せず、その旨を示す', async ({
    page,
    request,
  }) => {
    await prepareFourNotifications(request);
    await openNotifications(page);

    await page.getByRole('button', { name: 'すべての通知を既読にする' }).click();
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toContainText('未読の通知 4 件を既読にします');
    await expect(dialog).toContainText('読み込んだ時点より後に届いた通知は、既読にしません');
    await dialog.getByRole('button', { name: 'キャンセル' }).click();

    await expect(dialog).toBeHidden();
    await expect(unreadBadge(page)).toHaveText('4');
    // 既読にしたあとは、既読にする未読がない（確認は開かず、その旨を示す）
    await page.getByRole('button', { name: 'すべての通知を既読にする' }).click();
    await confirmDialog(page, '既読にする');
    await expect(page.getByTestId('notifications-notice')).toContainText(
      '4 件の通知を既読にしました',
    );
    await page.getByRole('button', { name: 'すべての通知を既読にする' }).click();
    await expect(page.getByTestId('notifications-notice')).toContainText(
      '既読にする未読の通知はありません',
    );
    await expect(dialog).toBeHidden();
    await expect(unreadBadge(page)).toHaveText('0');
  });

  test('既読にした通知を、未読の絞り込みで探すと、表示されない', async ({ page, request }) => {
    await prepareFourNotifications(request);
    await openNotifications(page, '?readState=UNREAD');
    await expect(rows(page)).toHaveCount(4);
    const message =
      (await rows(page).first().locator('.notification-message p').textContent()) ?? '';

    await rows(page).first().getByRole('button', { name: '既読にする' }).click();

    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).filter({ hasText: message })).toHaveCount(0);
    // 既読の絞り込みでは、その通知が表示される
    await openNotifications(page, '?readState=READ');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(message);
  });
});

test.describe('通知から対象を確認する（UC-05への連携）', () => {
  test('状態の悪化の通知から、対象の観点の詳細を、ダッシュボード上のドロワーで開くと、対象の設備が選ばれ、通知が既読になる（SC-05-6）', async ({
    page,
    request,
  }) => {
    await prepareFourNotifications(request);
    await openNotifications(page);
    const sensorRow = rows(page)
      .filter({ hasText: '環境適応性' })
      .filter({ hasText: '環境センサー1' });

    await sensorRow.getByRole('link', { name: '詳細を確認' }).click();

    // 全画面の観点のページ（/viewpoints/…）ではなく、ダッシュボード上のドロワー（/?viewpoint=観点）
    const drawer = page.getByRole('dialog', { name: '環境適応性の詳細' });
    await expect(page).toHaveURL(/\/\?viewpoint=environmentalAdaptability$/);
    await expect(drawer.getByRole('heading', { name: /環境適応性/, level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeAttached();
    await expect(drawer.getByLabel('対象の設備').locator('option:checked')).toContainText(
      '環境センサー1',
    );
    await expect(drawer.getByLabel('対象の設備')).toHaveValue('SENSOR-01');
    await expect(unreadBadge(page)).toHaveText('3');
  });

  test('データ取得失敗の通知から、取り込みの状況を開くと、通知が既読になる', async ({
    page,
    request,
  }) => {
    await prepareFourNotifications(request);
    await openNotifications(page);

    await rows(page)
      .filter({ hasText: 'ロボットデータ' })
      .getByRole('link', { name: '取り込みの状況を確認' })
      .click();

    await expect(page).toHaveURL(/\/settings\/ingestion/);
    await expect(page.getByRole('heading', { name: '取り込み', level: 1 })).toBeVisible();
    await expect(unreadBadge(page)).toHaveText('3');
  });

  test('すでに既読の通知から開いても、件数は変わらない', async ({ page, request }) => {
    await prepareFourNotifications(request);
    const all = await listNotifications(request);
    const robotFailure = all.find((item) => item.sourceId === 'robot');
    await markReadViaApi(request, robotFailure?.notificationId ?? '');
    await openNotifications(page);
    await expect(unreadBadge(page)).toHaveText('3');

    await rows(page)
      .filter({ hasText: 'ロボットデータ' })
      .getByRole('link', { name: '取り込みの状況を確認' })
      .click();

    await expect(page).toHaveURL(/\/settings\/ingestion/);
    await expect(unreadBadge(page)).toHaveText('3');
  });
});

test.describe('通知から観点のドロワーへ移る（#159 の SC-05-6）', () => {
  test('別のハウスの設備の通知から開くと、ダッシュボードの対象のハウスが、通知のハウスになり、ドロワーは通知の設備で開く', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    // 別のハウスと、そのハウスのセンサーを登録し、そのセンサーだけが異常になるデータを入れる（ハウス1 は、データなし）
    await apiOk(request, 'POST', '/equipment', {
      equipmentId: 'HOUSE-02',
      equipmentType: 'FACILITY',
      name: 'ハウス2',
    });
    await apiOk(request, 'POST', '/equipment', {
      equipmentId: 'SENSOR-02',
      equipmentType: 'SENSOR',
      name: '環境センサー2',
      facilityId: 'HOUSE-02',
    });
    await seed(request, {
      observations: [
        ['temperatureCelsius', 40],
        ['humidityPercent', 60],
        ['illuminanceLux', 30_000],
        ['co2Ppm', 900],
      ].map(([itemKey, value]) => ({
        equipmentId: 'SENSOR-02',
        itemKey: String(itemKey),
        observedAt: hoursAgo(1),
        value: Number(value),
      })),
    });
    await openNotifications(page);
    const sensorRow = rows(page)
      .filter({ hasText: '環境適応性' })
      .filter({ hasText: '環境センサー2' });
    await expect(sensorRow).toHaveCount(1);

    await sensorRow.getByRole('link', { name: '詳細を確認' }).click();

    const drawer = page.getByRole('dialog', { name: '環境適応性の詳細' });
    await expect(page).toHaveURL(/\/\?viewpoint=environmentalAdaptability$/);
    await expect(drawer.getByLabel('対象の設備')).toHaveValue('SENSOR-02');
    // ダッシュボード（背面）の対象のハウスは、ハウス2。ハウス2 の評価（40℃ の異常）を示す
    await expect(page.getByLabel('対象のハウス')).toHaveValue('HOUSE-02');
    await expect(
      page.getByTestId('period-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('異常');
    // 閉じても、対象のハウスは、ハウス2 のまま
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(page.getByLabel('対象のハウス')).toHaveValue('HOUSE-02');
  });
});

test.describe('約 10 秒の再取得で、新着が届いても、行がずれない（#159 の SC-05-10）', () => {
  test('新着の通知は、自動では加えず、「新着あり（N 件）」を示す。押すと、新着を加えて更新する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    // 先に、通知を 1 件作っておく（収穫精度の異常）
    await seed(request, harvestAccuracyData('ERROR'));
    await openNotifications(page);
    const before = await rows(page).count();
    expect(before).toBeGreaterThanOrEqual(1);
    const messagesBefore = await rows(page).locator('.notification-message p').allTextContents();

    // 画面を開いたまま、新しい通知を作る（環境適応性などの異常）
    await seedAbnormalEnvironment(request);

    // 再取得（約 10 秒）のあと、「新着あり」を示す。表示中の行は、動かない
    const banner = page.getByRole('button', { name: /^新着あり（\d+ 件）/ });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(rows(page)).toHaveCount(before);
    await expect(rows(page).locator('.notification-message p')).toHaveText(messagesBefore);

    await banner.click();

    await expect(banner).toHaveCount(0);
    await expect.poll(() => rows(page).count()).toBeGreaterThan(before);
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
    await expect(page.getByTestId('pager-range')).toHaveText('1〜20 件目');
    await expect(page.getByRole('button', { name: '前へ' })).toBeDisabled();
    await shot(page, testInfo, 'uc22-page-1');

    await page.getByRole('button', { name: '次へ' }).click();

    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId('pager-page')).toHaveText('2');
    await expect(page.getByTestId('pager-range')).toHaveText('21〜21 件目');
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
    await prepareFourNotifications(request);
    await addUser(request, USER_B);
    // 利用者A: 2件を既読にする
    await openNotifications(page);
    await expect(unreadBadge(page)).toHaveText('4');
    await rows(page).nth(0).getByRole('button', { name: '既読にする' }).click();
    await rows(page).nth(1).getByRole('button', { name: '既読にする' }).click();
    await expect(unreadBadge(page)).toHaveText('2');

    // 利用者B: 別のブラウザで、ログインする。未読は、4件のまま
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/notifications', USER_B);
    await expect(unreadBadge(b.page)).toHaveText('4');
    await expect(rows(b.page)).toHaveCount(4);
    for (const row of await rows(b.page).all()) {
      await expect(row).toHaveAttribute('data-read-state', 'UNREAD');
    }
    // 利用者B: 全件を既読にする
    await b.page.getByRole('button', { name: 'すべての通知を既読にする' }).click();
    await confirmDialog(b.page, '既読にする');
    await expect(unreadBadge(b.page)).toHaveText('0');
    await shot(b.page, testInfo, 'uc22-user-b-all-read');

    // 利用者A: 再読み込みしても、既読は 2 件のまま（2件は未読）
    await page.reload();
    await expect(unreadBadge(page)).toHaveText('2');
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

/**
 * ヘッダーの通知のアイコンと、未読の件数のバッジ（Issue #351）が、ページの幅の中に収まり、他の要素と重ならない。
 * expectedText は、バッジの表示（99 件までは件数、100 件以上は「99+」、0 件は、バッジを隠す。要素は残り、文字は「0」）。
 */
async function expectUnreadBadgeIntact(page: Page, expectedText: string): Promise<void> {
  const badge = unreadBadge(page);
  await expect(badge).toHaveText(expectedText);
  const link = page.locator('.header-unread');
  const linkBox = await link.boundingBox();
  const own = {
    left: linkBox?.x ?? -1,
    top: linkBox?.y ?? -1,
    right: (linkBox?.x ?? 0) + (linkBox?.width ?? 0),
    bottom: (linkBox?.y ?? 0) + (linkBox?.height ?? 0),
  };
  expect(own.left).toBeGreaterThanOrEqual(0);
  expect(linkBox?.height ?? 0, '通知のアイコンの高さ').toBeLessThan(44);
  if (expectedText === '0') {
    await expect(badge, '0 件のときは、バッジを隠す').toBeHidden();
  } else {
    await expect(badge).toBeVisible();
    // バッジは、アイコンの右上に重なり、1 行で、枠から文字があふれず、ページの幅の中に収まる
    const badgeBox = await badge.boundingBox();
    expect(badgeBox?.height ?? 0, 'バッジの高さ（1 行）').toBeLessThan(28);
    expect((badgeBox?.x ?? 0) + (badgeBox?.width ?? 0), 'バッジの右端').toBeLessThanOrEqual(
      page.viewportSize()?.width ?? 0,
    );
    expect(Math.abs((badgeBox?.y ?? 100) - own.top), 'バッジが、アイコンの上端にある').toBeLessThan(
      14,
    );
    expect(await badge.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    own.top = Math.min(own.top, badgeBox?.y ?? own.top);
    own.right = Math.max(own.right, (badgeBox?.x ?? 0) + (badgeBox?.width ?? 0));
  }
  // ヘッダー内の他の要素（タイトル・設備の選択・ユーザー）と、アイコン・バッジが重ならない
  const siblings = await page
    .locator('.app-header-row > *')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
  for (const other of siblings) {
    if (Math.abs(other.x - (linkBox?.x ?? 0)) < 1 && Math.abs(other.y - (linkBox?.y ?? 0)) < 1) {
      continue;
    }
    const overlapWidth = Math.min(other.right, own.right) - Math.max(other.left, own.left);
    const overlapHeight = Math.min(other.bottom, own.bottom) - Math.max(other.top, own.top);
    expect(overlapWidth > 1 && overlapHeight > 1, 'ヘッダーの要素が重なる').toBe(false);
  }
}

/** 絞り込みの欄・ボタンが、ページの幅の中に収まり、重ならない。 */
async function expectFilterBarIntact(page: Page): Promise<void> {
  // 狭い幅では、絞り込みの項目が折りたたまれる。開いてから、項目・ボタンが幅の中に収まり、重ならないことを確認する
  const toggle = page.getByRole('button', { name: '絞り込みを開く' });
  if (await toggle.isVisible()) {
    await toggle.click();
  }
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

        await expect(rows(page)).toHaveCount(4);
        await expectNotificationTableNotCrushed(page);
        await expectHeaderIntact(page);
        await expectUnreadBadgeIntact(page, '4');
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
      await expectUnreadBadgeIntact(page, '99+');
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
      await expectUnreadBadgeIntact(page, '99+');
      await page.getByRole('button', { name: 'すべての通知を既読にする' }).scrollIntoViewIfNeeded();
      await page.getByRole('button', { name: 'すべての通知を既読にする' }).click();
      await confirmDialog(page, '既読にする');
      await expectUnreadBadgeIntact(page, '0');
      await expectNotificationTableNotCrushed(page);
    });
  });
}

test.describe('通知の経過・回復日時（API。Issue #238。D-42）', () => {
  test('異常 → 正常（5 分後）→ 異常（25 分後）: 最初の通知は、経過（異常 → 正常 → 異常）と回復（5 分）を返し、最新の通知は、未回復', async ({
    request,
  }) => {
    await prepareApp(request);
    await seed(request, environmentData({ temperature: 40 }));
    await advanceMinutes(request, 5);
    await seed(request, environmentData({ temperature: 22 }));
    await advanceMinutes(request, 20);
    await seed(request, environmentData({ temperature: 40 }));

    const sensor = (await listNotifications(request)).filter(
      (item) => item.equipmentId === SENSOR_ID && item.viewpointId === 'environmentalAdaptability',
    );
    const [latest, oldest] = sensor;

    expect(sensor).toHaveLength(2);
    expect(oldest?.progress?.changes.map((change) => change.status)).toEqual([
      'ERROR',
      'NORMAL',
      'ERROR',
    ]);
    expect(oldest?.progress?.recovery?.elapsedSeconds).toBe(300);
    expect(latest?.progress?.changes.map((change) => change.status)).toEqual(['ERROR']);
    expect(latest?.progress?.recovery).toBeNull();
  });

  test('取り込み失敗の通知には、経過を付けない', async ({ request }) => {
    await prepareApp(request);
    await failIngestion(request, ['robot']);

    const [failure] = await listNotifications(request);

    expect(failure?.kind).toBe('INGESTION_FAILURE');
    expect(failure !== undefined && 'progress' in failure).toBe(false);
  });
});

test.describe('通知のメモ（API。Issue #239。D-42）', () => {
  test('通知にメモを追記すると、入力者と日時が残り、一覧は入力の古い順。通知一覧が、メモの件数を返す', async ({
    request,
  }) => {
    await prepareApp(request);
    await failIngestion(request, ['robot']);
    const [notification] = await listNotifications(request);
    expect(notification?.memoCount).toBe(0);
    const id = notification?.notificationId ?? '';

    const first = await apiOk<{
      memoId: string;
      enteredBy: string;
      enteredByName?: string;
      body: string;
    }>(request, 'POST', `/notifications/${id}/memos`, {
      body: '  ファイルサーバーを再起動して復旧した  ',
    });
    await advanceMinutes(request, 5);
    await apiOk(request, 'POST', `/notifications/${id}/memos`, { body: '復旧を確認した' });

    expect(first.body).toBe('ファイルサーバーを再起動して復旧した');
    expect(first.enteredBy).not.toBe('');
    // 入力者の表示名（現在のユーザー名）を、応答に含める（SC-07-7）
    expect(first.enteredByName).toBe(E2E_USER.userName);
    const memos = await apiOk<{
      items: { body: string; createdAt: string; enteredBy: string; enteredByName?: string }[];
    }>(request, 'GET', `/notifications/${id}/memos`);
    expect(memos.items.map((item) => item.body)).toEqual([
      'ファイルサーバーを再起動して復旧した',
      '復旧を確認した',
    ]);
    expect(memos.items.map((item) => item.enteredByName)).toEqual([
      E2E_USER.userName,
      E2E_USER.userName,
    ]);
    expect(
      Date.parse(memos.items[1]?.createdAt ?? '') - Date.parse(memos.items[0]?.createdAt ?? ''),
    ).toBe(5 * 60_000);
    expect((await listNotifications(request))[0]?.memoCount).toBe(2);
  });

  test('不正な本文（空・2001 文字）は 400。編集・削除はできない（追記のみ）。通知がなければ 404', async ({
    request,
  }) => {
    await prepareApp(request);
    await failIngestion(request, ['robot']);
    const id = (await listNotifications(request))[0]?.notificationId ?? '';
    const memo = await apiOk<{ memoId: string }>(request, 'POST', `/notifications/${id}/memos`, {
      body: 'メモ',
    });

    const empty = await api(request, 'POST', `/notifications/${id}/memos`, { body: '  ' });
    const tooLong = await api(request, 'POST', `/notifications/${id}/memos`, {
      body: 'あ'.repeat(2001),
    });
    const update = await api(request, 'PUT', `/notifications/${id}/memos/${memo.memoId}`, {
      body: '修正',
    });
    const remove = await api(request, 'DELETE', `/notifications/${id}/memos/${memo.memoId}`);
    const missing = await api(request, 'POST', '/notifications/none/memos', { body: 'メモ' });

    expect([empty.status(), tooLong.status()]).toEqual([400, 400]);
    expect([update.status(), remove.status()]).toEqual([404, 404]);
    expect(missing.status()).toBe(404);
    expect((await listNotifications(request))[0]?.memoCount).toBe(1);
  });
});

test.describe('通知の経過・回復日時・メモ（画面。Issue #159 の SC-05-1。D-42）', () => {
  test('異常 → 正常（5 分後）→ 異常（25 分後）: 最初の通知は、回復日時（5 分）と経過を示し、最新の通知は「未回復」。推奨アクションは、一覧に出さない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, environmentData({ temperature: 40 }));
    await advanceMinutes(request, 5);
    await seed(request, environmentData({ temperature: 22 }));
    await advanceMinutes(request, 20);
    await seed(request, environmentData({ temperature: 40 }));

    await openNotifications(page);

    const sensorRows = rows(page)
      .filter({ hasText: '環境適応性' })
      .filter({ hasText: '（環境センサー1）' });
    await expect(sensorRows).toHaveCount(2);
    const latest = sensorRows.first();
    const oldest = sensorRows.last();
    await expect(oldest.getByTestId('notification-recovery')).toHaveText(
      /^\d{2}:\d{2} に回復（5 分）$/,
    );
    await expect(latest.getByTestId('notification-recovery')).toHaveText('未回復');
    await oldest.getByTestId('notification-details').locator('summary').click();
    await expect(oldest.getByTestId('notification-progress')).toContainText(
      /\d{2}:\d{2} 異常 → \d{2}:\d{2} 正常 → \d{2}:\d{2} 異常/,
    );
    await expect(page.getByText('推奨アクション')).toHaveCount(0);
    await shot(page, testInfo, 'uc22-progress');
  });

  test('取り込み失敗の通知には、経過・回復日時を出さない。メモを追記すると、入力者と日時つきで残り、読み込み直しても、別の利用者にも見える。空のメモは追記できない。編集・削除の操作はない', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await failIngestion(request, ['robot']);
    await openNotifications(page);
    const row = rows(page).first();
    await expect(row.getByTestId('notification-recovery')).toHaveCount(0);
    await expect(row.getByTestId('notification-progress')).toHaveCount(0);
    const details = row.getByTestId('notification-details');
    await expect(details.locator('summary')).toHaveText('メモ（0 件）');

    await details.locator('summary').click();
    await expect(row.getByTestId('notification-memo-empty')).toHaveText('メモはありません');
    // 空のメモは、追記できない
    await row.getByRole('button', { name: 'メモを追加' }).click();
    await expect(row.getByText('メモを入力してください')).toBeVisible();
    await expect(row.getByTestId('notification-memo')).toHaveCount(0);
    await row.getByLabel('メモ').fill('ファイルサーバーを再起動して復旧した');
    await row.getByRole('button', { name: 'メモを追加' }).click();

    await expect(row.getByTestId('notification-memo-notice')).toContainText('メモを追加しました');
    await expect(row.getByTestId('notification-memo')).toHaveCount(1);
    await expect(row.getByTestId('notification-memo')).toContainText(
      'ファイルサーバーを再起動して復旧した',
    );
    await expect(row.getByTestId('notification-memo')).toContainText('2026/');
    // 入力者は、「ユーザー名（ID）」（SC-07-7）
    await expect(row.getByTestId('notification-memo')).toContainText(userLabelText(E2E_USER));
    await expect(details.locator('summary')).toHaveText('メモ（1 件）');
    await expect(row.getByRole('button', { name: /編集|削除/ })).toHaveCount(0);
    await shot(page, testInfo, 'uc22-memo');

    // 読み込み直しても残り、別の利用者にも見える（共有）
    await openNotifications(page);
    await expect(
      rows(page).first().getByTestId('notification-details').locator('summary'),
    ).toHaveText('メモ（1 件）');
    const other = await newUserSession(browser, testInfo, 'memo-other');
    try {
      await openAs(other.page, '/notifications', USER_B);
      const otherRow = rows(other.page).first();
      await otherRow.getByTestId('notification-details').locator('summary').click();
      await expect(otherRow.getByTestId('notification-memo')).toContainText(
        'ファイルサーバーを再起動して復旧した',
      );
      await expect(otherRow.getByTestId('notification-memo')).toContainText(
        userLabelText(E2E_USER),
      );
    } finally {
      await other.context.close();
    }
  });
});

test.describe('一括既読は、読み込んだ時点までに限る（API。Issue #240。D-39）', () => {
  test('一覧の読み込んだ時点（asOf）までの未読だけを既読にし、件数を返す。あとに届いた通知は、未読のまま', async ({
    request,
  }) => {
    await prepareApp(request);
    await failIngestion(request, ['robot']);
    const loaded = await apiOk<{ items: unknown[]; asOf: string }>(
      request,
      'GET',
      '/notifications?limit=100',
    );
    expect(loaded.items).toHaveLength(1);
    // 画面を読み込んだあとに、別の通知が届く
    await advanceMinutes(request, 1);
    await failIngestion(request, ['environment-sensor']);

    const counted = await apiOk<{ unreadCount: number }>(
      request,
      'GET',
      `/notifications/unread-count?until=${encodeURIComponent(loaded.asOf)}`,
    );
    const marked = await apiOk<{ markedCount: number }>(
      request,
      'POST',
      '/notifications/read-all',
      {
        until: loaded.asOf,
      },
    );

    expect(counted.unreadCount).toBe(1);
    expect(marked.markedCount).toBe(1);
    const rest = await listNotifications(request, '&readState=UNREAD');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.message).toContain('環境センサーデータ');
  });

  test('読み込んだ時点（until）がない一括既読は、400。何も既読にしない', async ({ request }) => {
    await prepareApp(request);
    await failIngestion(request, ['robot']);

    const withoutUntil = await api(request, 'POST', '/notifications/read-all', {});
    const invalid = await api(request, 'POST', '/notifications/read-all', { until: 'きのう' });

    expect([withoutUntil.status(), invalid.status()]).toEqual([400, 400]);
    expect(await listNotifications(request, '&readState=UNREAD')).toHaveLength(1);
  });
});

test.describe('通知の閲覧範囲（ハウスごと。Issue #331。ADR-0013・ADR-0019 の D-41。FR-9.8）', () => {
  /** ハウス 2（ハウス 2 の環境センサー）を登録し、ハウス 1・ハウス 2 の環境の温度を異常にして、通知を作る。取り込みの失敗の通知（ハウスに属さない）も作る。 */
  async function prepareTwoHouses(request: Parameters<typeof prepareApp>[0]): Promise<void> {
    await prepareApp(request);
    await apiOk(request, 'POST', '/equipment', {
      equipmentId: 'HOUSE-02',
      equipmentType: 'FACILITY',
      name: 'ハウス2',
    });
    await apiOk(request, 'POST', '/equipment', {
      equipmentId: 'SENSOR-02',
      equipmentType: 'SENSOR',
      name: '環境センサー2',
      facilityId: 'HOUSE-02',
    });
    await seedAbnormalEnvironment(request);
    await seed(request, {
      observations: [
        {
          equipmentId: 'SENSOR-02',
          itemKey: 'temperatureCelsius',
          observedAt: hoursAgo(1),
          value: 40,
        },
      ],
    });
    await failIngestion(request, ['robot']);
  }

  const generalApi = async (
    request: Parameters<typeof prepareApp>[0],
    method: 'GET' | 'POST',
    path: string,
  ) =>
    request.fetch(`/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${await accessToken(request, GENERAL)}` },
    });

  test('一般ユーザーには、割り当てられたハウスの通知だけが、一覧・未読の件数に出る。ハウスに属さない通知（取り込みの失敗）は、管理者のみ。範囲外の通知は、既読にもできない（404）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareTwoHouses(request);
    await addUser(request, GENERAL);
    await apiOk(request, 'PUT', '/facility-access/HOUSE-02', { userIds: [GENERAL.userId] });

    // 管理者: 両方のハウスと、取り込みの失敗の通知
    const all = await listNotifications(request);
    const houses = new Set(
      all.filter((item) => item.equipmentId !== undefined).map((item) => item.equipmentId),
    );
    expect(houses.has('SENSOR-01') || houses.has('HOUSE-01')).toBe(true);
    expect(houses.has('SENSOR-02') || houses.has('HOUSE-02')).toBe(true);
    expect(all.some((item) => item.kind === 'INGESTION_FAILURE')).toBe(true);

    // 一般ユーザー（API）: ハウス 2 の通知だけ
    const listed = (await (
      await generalApi(request, 'GET', '/notifications?limit=100')
    ).json()) as {
      items: ApiNotification[];
    };
    expect(listed.items.length).toBeGreaterThan(0);
    for (const item of listed.items) {
      expect(['HOUSE-02', 'SENSOR-02'], item.message).toContain(item.equipmentId);
    }
    const other = all.find((item) => item.equipmentId === 'SENSOR-01');
    expect(other).toBeDefined();
    expect(
      (
        await generalApi(request, 'POST', `/notifications/${other?.notificationId ?? ''}/read`)
      ).status(),
    ).toBe(404);
    expect(
      (
        await generalApi(request, 'GET', `/notifications/${other?.notificationId ?? ''}/memos`)
      ).status(),
    ).toBe(404);

    // 一般ユーザー（画面）: ヘッダーの未読の件数と、通知の一覧の行が、範囲の通知の数と一致する
    const count = listed.items.length;
    await alignBrowserClock(page);
    await openAs(page, '/', GENERAL);
    await expect(unreadBadge(page)).toHaveText(String(count));
    await page.goto('/notifications');
    await expect(rows(page)).toHaveCount(count);
    // ハウスに属さない通知（取り込みの失敗。種別「データ取得失敗」）は、一般ユーザーの一覧には出ない
    await expect(rows(page).filter({ hasText: 'データ取得失敗' })).toHaveCount(0);
    await shot(page, testInfo, 'uc22-scoped');
  });

  test('割り当てがない一般ユーザーには、通知が出ない（一覧は空・未読の件数は 0）。管理者が割り当てると、すぐに出る', async ({
    request,
  }) => {
    await prepareTwoHouses(request);
    await addUser(request, GENERAL);
    const unreadOf = async () =>
      (
        (await (await generalApi(request, 'GET', '/notifications/unread-count')).json()) as {
          unreadCount: number;
        }
      ).unreadCount;

    expect(await unreadOf()).toBe(0);
    await apiOk(request, 'PUT', '/facility-access/HOUSE-02', { userIds: [GENERAL.userId] });

    expect(await unreadOf()).toBeGreaterThan(0);
  });
});
