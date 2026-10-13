/**
 * UC-24 データ取り込みの失敗を通知する（SC-05・SC-11。FR-1.9、FR-7.4、FR-7.7）。
 * UI を持たないユースケースのため、ファイルサーバーのモックを停止し（開発用 API）、SC-11 の即時取得（または定期の取り込み JB-01）を実行して、
 * 結果を SC-05（通知）・SC-11（ログ）で確認する（dev_spec.md 5.1）。再試行の待ち時間は、固定した時計で、待たずに進める。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. システムが、取り込みを再試行する
 *               2. 再試行しても失敗した場合、システムが農作業者へ通知する
 *               3. システムが、通知を未読として記録する
 *   代替フロー  通知に失敗した場合は、記録し、再送する（Web Push。UC-23）。同じ内容の通知を重複して出さない
 *   事後条件    取り込み失敗の通知が送られ、未読として記録されている。取り込みの失敗が、他の機能の動作を妨げていない
 *
 * 値の同値分割: 失敗の種類（接続できない・形式違いのファイル）、取り込み元（ロボット・環境センサー）、起動の経路（即時取得・定期）、
 * 同じ失敗の繰り返し（抑制の期間内・期間後（60分）・境界）、復旧の後、利用者（通知は全員が受け取り、既読は利用者ごと）。
 * 関連するユースケース: UC-08・UC-09（失敗の元）、UC-05・UC-22（通知の確認）、UC-16（ログの確認）、UC-15（設定の見直し）、UC-23。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  USER_B,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  apiOk,
  newUserSession,
  openAs,
  placeFile,
  placeFixture,
  prepareApp,
  robotJson,
  runJob,
  setMock,
  unreadBadge,
} from './support/app.ts';
import { logRows, runNow, sourceCard } from './support/ingestion.ts';
import { listNotifications } from './support/notifications.ts';
import { deliveredPushes } from './support/push.ts';
import { shot } from './support/viewpoint-scenarios.ts';
import { expectNoHorizontalScroll, locatorOf, openIngestion } from './support/pages.ts';

const rows = locatorOf('notification-row');
const failureRows = (page: Page) => rows(page).filter({ hasText: 'データ取得失敗' });

test.describe('基本フロー: 取り込みを再試行し、再試行しても失敗した場合は、通知し、未読として記録する', () => {
  test('ファイルサーバーに接続できないと、再試行（3回）して失敗し、取り込み失敗の通知を作る。通知は未読で、ヘッダーの件数に反映され、通知の一覧で確認できる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await openIngestion(page);
    await expect(unreadBadge(page)).toHaveText('0');

    // 1. 取り込みを再試行する（接続の確認・一覧の取得を、最大3回） → 2. 再試行しても失敗した場合は、通知する
    const result = await runNow(page, 'robot');
    await expect(result).toContainText('取得しました（失敗）');
    // 再試行（最大3回）して、失敗した
    const logs = await apiOk<{ items: { attempts: number }[] }>(request, 'GET', '/ingestion/logs');
    expect(logs.items[0]?.attempts).toBe(3);
    await shot(page, testInfo, 'uc24-failed');

    // 3. 通知を未読として記録する
    await expect(unreadBadge(page)).toHaveText('1');
    await page.getByRole('link', { name: '未読の通知: 1件' }).click();
    await expect(failureRows(page)).toHaveCount(1);
    const notification = failureRows(page).first();
    await expect(notification).toHaveAttribute('data-read-state', 'UNREAD');
    await expect(notification).toContainText('【データ取得失敗】ロボットデータ');
    await expect(notification).toContainText('ファイルサーバーに接続できませんでした');
    await expect(notification).toContainText('ロボットデータ');
    await shot(page, testInfo, 'uc24-notification');
  });

  test('再試行は最大3回（初回を含む）。待ち時間（基準の2倍ずつ。E2E の基準は 10 ミリ秒）は、固定した時計を進めるだけで、待たない', async ({
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    const before = await apiOk<{ now: string }>(request, 'GET', '/dev/clock');

    await apiOk(request, 'POST', '/ingestion/robot/run');

    const logs = await apiOk<{
      items: { attempts: number; result: string; errorMessage: string }[];
    }>(request, 'GET', '/ingestion/logs');
    expect(logs.items[0]).toMatchObject({
      attempts: 3,
      result: 'FAILURE',
      errorMessage: 'ファイルサーバーに接続できませんでした',
    });
    // 実行時の待ち時間の設定（10 ミリ秒の基準）: 10ms + 20ms = 30ms だけ、時計が進む
    const after = await apiOk<{ now: string }>(request, 'GET', '/dev/clock');
    expect(Date.parse(after.now) - Date.parse(before.now)).toBe(30);
  });

  test('通知の一覧から、取り込みの状況（ログ）を開いて、失敗を確認できる（UC-16）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await apiOk(request, 'POST', '/ingestion/robot/run');
    await alignBrowserClock(page);
    await openAs(page, '/notifications');

    await failureRows(page).first().getByRole('link', { name: '取り込みの状況を確認' }).click();

    await expect(page).toHaveURL(/\/settings\/ingestion$/);
    await expect(logRows(page).first()).toContainText('失敗');
    await expect(logRows(page).first()).toContainText('ファイルサーバーに接続できませんでした');
    await expect(unreadBadge(page)).toHaveText('0');
  });
});

test.describe('取り込み元ごとの通知（取り込み元ごとに独立）', () => {
  test('ロボットデータと環境センサーデータが、それぞれ失敗すると、取り込み元ごとに通知を作る', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await apiOk(request, 'POST', '/ingestion/robot/run');
    await apiOk(request, 'POST', '/ingestion/environment-sensor/run');
    await alignBrowserClock(page);
    await openAs(page, '/notifications');

    await expect(failureRows(page)).toHaveCount(2);
    await expect(failureRows(page).filter({ hasText: 'ロボットデータ' })).toHaveCount(1);
    await expect(failureRows(page).filter({ hasText: '環境センサーデータ' })).toHaveCount(1);
  });

  test('一方の取り込み元だけが失敗する場合（ロボットは接続でき、センサーは形式違いのファイル）、形式違いは通知しない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFixture('environment-sensor', 'environment-sensor/sensor-sample-003-bad-header.csv');
    // ロボットは、接続でき、ファイルがなくても成功する
    const robot = await apiOk<{ result: string }>(request, 'POST', '/ingestion/robot/run');
    expect(robot.result).toBe('SUCCESS');
    await apiOk(request, 'POST', '/ingestion/environment-sensor/run');
    await alignBrowserClock(page);
    await openAs(page, '/notifications');

    // 形式違い・不正な値は、取り込みのログに記録する（UC-08・UC-09）。接続の失敗とは、区別して、通知しない
    await expect(failureRows(page)).toHaveCount(0);
  });
});

test.describe('代替フロー: 同じ内容の通知を重複して出さない（抑制の期間 60分）', () => {
  test('抑制の期間（60分）の内に、同じ取り込み元が再び失敗しても、通知は増えない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await apiOk(request, 'POST', '/ingestion/robot/run');
    await advanceMinutes(request, 59);
    await apiOk(request, 'POST', '/ingestion/robot/run');
    await alignBrowserClock(page);
    await openAs(page, '/notifications');

    await expect(failureRows(page)).toHaveCount(1);
    // ログは、失敗のたびに記録する
    await page.goto('/settings/ingestion');
    await expect(logRows(page).filter({ hasText: 'ロボットデータ' })).toHaveCount(2);
  });

  test('抑制の期間（60分）が過ぎたあとの失敗は、新しい通知を作る（境界: 60分ちょうどは、抑制の期間の外）', async ({
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await apiOk(request, 'POST', '/ingestion/robot/run');
    await advanceMinutes(request, 60);

    await apiOk(request, 'POST', '/ingestion/robot/run');

    const failures = (await listNotifications(request)).filter(
      (item) => item.kind === 'INGESTION_FAILURE',
    );
    expect(failures).toHaveLength(2);
  });

  test('同じ取り込み元の失敗を、復旧後にもう一度失敗しても、60分の内は、通知を増やさない', async ({
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await apiOk(request, 'POST', '/ingestion/robot/run');
    await setMock(request, 'file-server', 'UP');
    placeFile('robot', 'a.json', robotJson([{ hoursAgo: 1, fields: { harvestCount: 1 } }]));
    await apiOk(request, 'POST', '/ingestion/robot/run');
    await advanceMinutes(request, 10);
    await setMock(request, 'file-server', 'DOWN');

    await apiOk(request, 'POST', '/ingestion/robot/run');

    expect(
      (await listNotifications(request)).filter((item) => item.kind === 'INGESTION_FAILURE'),
    ).toHaveLength(1);
  });
});

test.describe('起動の経路: 定期の取り込み（JB-01・スケジューラ）でも、失敗を通知する', () => {
  test('定期の取り込み（JB-01）で失敗しても、同じように通知する', async ({ page, request }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');

    await runJob(request, 'JB-01');

    await alignBrowserClock(page);
    await openAs(page, '/notifications');
    await expect(failureRows(page)).toHaveCount(2);
  });

  test('スケジューラの tick（取り込み → 通知の配信）でも、失敗を通知する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');

    await apiOk(request, 'POST', '/dev/scheduler/tick', {});

    await alignBrowserClock(page);
    await openAs(page, '/notifications');
    await expect(failureRows(page)).toHaveCount(2);
  });
});

test.describe('取り込みの失敗が、他の機能の動作を妨げない', () => {
  test('取り込みが失敗している間も、ダッシュボード・データ入力（評価）・通知の既読が、通常どおり使える', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await apiOk(request, 'POST', '/ingestion/robot/run');
    await alignBrowserClock(page);
    await openAs(page, '/');
    await expect(page.getByTestId('card-harvestSpeed')).toBeVisible();

    // 手動入力は、保存でき、評価が更新される
    await page.goto('/data-entry');
    await page.getByRole('main').getByLabel('対象の設備').selectOption('ROBOT-01');
    await page.getByRole('main').getByLabel('カテゴリ').selectOption('SAFETY');
    await page.getByTestId('entry-items').getByLabel('緊急停止回数').fill('0');
    await page.getByRole('main').getByRole('button', { name: '保存する' }).click();
    await expect(page.getByTestId('entry-result')).toBeVisible();
    // 評価が更新され、関連する観点（安全性）のステータスが、保存結果に示される
    await expect(page.getByTestId('related-safety')).toBeVisible();
    // 通知は、既読にできる
    await page.goto('/notifications');
    await failureRows(page).first().getByRole('button', { name: '既読にする' }).click();
    await expect(failureRows(page).first()).toHaveAttribute('data-read-state', 'READ');
  });
});

test.describe('シナリオ: 取り込みの失敗の通知を、別の利用者が確認し、設定を見直して、復旧を確認する（UC-08 → UC-24 → UC-22 → UC-16 → UC-15）', () => {
  test('利用者Aの即時取得が失敗し、利用者Bが通知を確認して、取り込みの状況を開き、ファイルサーバーの復旧後に、取り込みに成功する。Aの未読は、そのまま', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await setMock(request, 'file-server', 'DOWN');
    // 利用者A: 取り込みが失敗する
    await openIngestion(page);
    await expect(await runNow(page, 'robot')).toContainText('取得しました（失敗）');
    await expect(unreadBadge(page)).toHaveText('1');

    // 利用者B: 通知を受け取り、取り込みの状況を確認する
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/', USER_B);
    await expect(unreadBadge(b.page)).toHaveText('1');
    await b.page.getByRole('link', { name: '未読の通知: 1件' }).click();
    await expect(failureRows(b.page)).toHaveCount(1);
    await failureRows(b.page).first().getByRole('link', { name: '取り込みの状況を確認' }).click();
    await expect(logRows(b.page).first()).toContainText('失敗');
    await expect(unreadBadge(b.page)).toHaveText('0');

    // 復旧（システム外）→ 利用者B: 設定を確認し、即時取得で、取り込む
    await setMock(request, 'file-server', 'UP');
    placeFile('robot', 'a.json', robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 8 } }]));
    await expect(await runNow(b.page, 'robot')).toContainText('取得しました（成功）');
    await expect(logRows(b.page).first()).toContainText('成功');
    await shot(b.page, testInfo, 'uc24-recovered');

    // 利用者A: 自分の未読は、そのまま（既読は利用者ごと）
    await page.reload();
    const mine = await listNotifications(request);
    const failure = mine.find((item) => item.kind === 'INGESTION_FAILURE');
    expect(failure?.readState).toBe('UNREAD');
    // 取り込みの成功で、評価が更新され、状態変化の通知が増えることがある（それも含めて、Aの未読）
    await expect(unreadBadge(page)).toHaveText(
      String(mine.filter((item) => item.readState === 'UNREAD').length),
    );
    await b.context.close();
  });
});

test.describe('代替フロー: 通知（Web Push）の配信に失敗した場合は、再送する（FR-7.7）。画面内の通知は、未読で残る', () => {
  test('取り込み失敗の通知の Web Push の配信が失敗しても、画面内の通知は未読で残る。復旧後の再送（JB-04）で、購読している端末へ届き、二重には配信しない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await apiOk(request, 'PUT', '/push-subscription', {
      endpoint: 'https://push.example.invalid/e2e/uc24-retry',
    });
    await setMock(request, 'file-server', 'DOWN');
    await apiOk(request, 'POST', '/ingestion/robot/run');
    const [created] = (await listNotifications(request)).filter(
      (item) => item.kind === 'INGESTION_FAILURE',
    );
    expect(created?.readState).toBe('UNREAD');

    // 配信（JB-04）が失敗する: 記録され、画面内の通知は、そのまま残る
    await setMock(request, 'web-push', 'DOWN');
    await runJob(request, 'JB-04');
    expect(await deliveredPushes(request)).toHaveLength(0);
    await alignBrowserClock(page);
    await openAs(page, '/notifications');
    await expect(failureRows(page)).toHaveCount(1);
    await expect(failureRows(page).first()).toHaveAttribute('data-read-state', 'UNREAD');
    await shot(page, testInfo, 'uc24-push-failed');

    // 復旧後の再送で届く。再送を繰り返しても、二重には配信しない
    await setMock(request, 'web-push', 'UP');
    await runJob(request, 'JB-04');
    const delivered = await deliveredPushes(request);
    expect(delivered.map((item) => item.notificationId)).toEqual([created?.notificationId]);
    await runJob(request, 'JB-04');
    expect(await deliveredPushes(request)).toHaveLength(1);
  });

  test('再送は、最大3回（初回を含む）まで。3回失敗した取り込み失敗の通知は、復旧後も再送されないが、画面内の通知は残る', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await apiOk(request, 'PUT', '/push-subscription', {
      endpoint: 'https://push.example.invalid/e2e/uc24-limit',
    });
    await setMock(request, 'file-server', 'DOWN');
    await apiOk(request, 'POST', '/ingestion/robot/run');
    await setMock(request, 'web-push', 'DOWN');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runJob(request, 'JB-04');
    }

    await setMock(request, 'web-push', 'UP');
    await runJob(request, 'JB-04');

    expect(await deliveredPushes(request)).toHaveLength(0);
    await alignBrowserClock(page);
    await openAs(page, '/notifications');
    await expect(failureRows(page)).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------
// 画面の幅（1280px・768px・375px）でも、失敗の通知（SC-05）と、失敗の取り込みの状況（SC-11）が、潰れず、はみ出さない（NFR-7.3）。
// 取り込み元の名称・失敗の理由は、固定の短い文言（取り込み元は「ロボットデータ」「環境センサーデータ」の2つ。取り込み元の追加・名称の変更はない）。
// 長い値になりうるのは、接続先の参照名（100 文字。英数字・記号のみで、区切りがない）と、失敗のログの件数。
// ---------------------------------------------------------------------------

const LONG_CONNECTION_REF = `${'ConnectionRef-'.repeat(7)}XX`;
const VIEWPORTS = [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 720 },
  { name: 'タブレット幅（768px。NFR-7.3）', width: 768, height: 1024 },
  { name: 'スマートフォン幅（375px）', width: 375, height: 667 },
] as const;

/** ページが横にはみ出さず、ヘッダーの要素が収まる。 */
async function expectPageFits(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  await expectNoHorizontalScroll(page);
  const header = await page
    .locator('.app-header-row > *')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
  for (const [index, rect] of header.entries()) {
    expect(rect.left, `ヘッダーの要素 ${String(index)} の左端`).toBeGreaterThanOrEqual(0);
    expect(rect.right, `ヘッダーの要素 ${String(index)} の右端`).toBeLessThanOrEqual(width);
  }
}

/** 表の枠が画面内に収まり、見出し・日時・状態ラベルが折り返さず、長文の欄が読める幅を保つ。 */
async function expectTableIntact(
  page: Page,
  table: string,
  textColumn: string,
  singleLine: readonly (readonly [selector: string, label: string, limit: number])[],
): Promise<void> {
  const headerHeights = await page
    .locator(`${table} thead th`)
    .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().height));
  expect(Math.max(...headerHeights), `見出しの高さ ${String(headerHeights)}`).toBeLessThan(48);
  for (const [selector, label, limit] of singleLine) {
    const heights = await page
      .locator(`${table} ${selector}`)
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(Math.max(...heights), `${label}の高さ ${String(heights)}`).toBeLessThan(limit);
  }
  const widths = await page
    .locator(`${table} ${textColumn}`)
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
  expect(Math.min(...widths), `長文の欄の幅 ${String(widths)}`).toBeGreaterThan(110);
  const frame = await page.locator(table).first().locator('xpath=..').boundingBox();
  expect((frame?.x ?? 0) + (frame?.width ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );
  await expectPageFits(page);
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name}: 取り込みの失敗の通知（SC-05）・失敗の取り込みの状況（SC-11）が、潰れず、はみ出さない`, () => {
    test('SC-05: 2つの取り込み元の失敗の通知が、取り込み元の名称・失敗の理由とともに収まり、「取り込みの状況を確認」に届く', async ({
      page,
      request,
    }, testInfo) => {
      await prepareApp(request);
      await setMock(request, 'file-server', 'DOWN');
      await apiOk(request, 'POST', '/ingestion/robot/run');
      await apiOk(request, 'POST', '/ingestion/environment-sensor/run');
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await alignBrowserClock(page);

      await openAs(page, '/notifications');

      await expect(failureRows(page)).toHaveCount(2);
      for (const name of ['ロボットデータ', '環境センサーデータ']) {
        const row = failureRows(page).filter({ hasText: `【データ取得失敗】${name}` });
        await expect(row).toHaveCount(1);
        // 対象の列も、取り込み元の名称（識別子ではない。dev_spec.md 4.1 No.28）
        await expect(row.locator('td[data-label="対象"]')).toHaveText(name);
        await expect(row).toContainText('ファイルサーバーに接続できませんでした');
      }
      await expectTableIntact(page, '.notification-table', 'tbody td.notification-message', [
        ['tbody time', '日時', 30],
        ['tbody .read-state', '既読状態のラベル', 30],
        ['tbody .notification-state button', '「既読にする」ボタン', 48],
      ]);
      expect(
        await unreadBadge(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      ).toBe(true);
      const link = failureRows(page).first().getByRole('link', { name: '取り込みの状況を確認' });
      await link.scrollIntoViewIfNeeded();
      const box = await link.boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
      await page.locator('.table-scroll').evaluate((node) => {
        node.scrollLeft = 0;
      });
      await shot(page, testInfo, `uc24-notifications-${String(viewport.width)}`);
    });

    test('SC-11: 失敗の取り込み（長い接続先の参照名100文字・失敗のログ13件・2ページ）でも、取り込み元のカード・結果の表示・ログの表が崩れない', async ({
      page,
      request,
    }, testInfo) => {
      await prepareApp(request);
      expect(LONG_CONNECTION_REF).toHaveLength(100);
      await apiOk(request, 'PUT', '/ingestion/settings', {
        sources: ['robot', 'environment-sensor'].map((sourceId) => ({
          sourceId,
          connectionRef: LONG_CONNECTION_REF,
          intervalMinutes: 5,
          isEnabled: true,
        })),
      });
      await setMock(request, 'file-server', 'DOWN');
      for (let index = 0; index < 6; index += 1) {
        await apiOk(request, 'POST', '/ingestion/robot/run');
        await apiOk(request, 'POST', '/ingestion/environment-sensor/run');
        await advanceMinutes(request, 61);
      }
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openIngestion(page);
      await expect(sourceCard(page, 'robot').getByLabel('接続先（接続設定の参照名）')).toHaveValue(
        LONG_CONNECTION_REF,
      );

      const result = await runNow(page, 'robot');

      await expect(result).toContainText('取得しました（失敗）');
      await expect(logRows(page)).toHaveCount(10);
      await expect(logRows(page).first()).toContainText('ファイルサーバーに接続できませんでした');
      const tableChecks = [
        ['tbody time', '日時', 30],
        ['tbody .log-result', '結果のラベル', 30],
      ] as const;
      await expectTableIntact(page, '.log-table', 'tbody tr td:last-child', tableChecks);
      // 900px 以下は、ログ 1 件ごとのカードで表示し、横にスクロールしなくても、結果・エラー内容を読める
      if (viewport.width <= 900) {
        for (const cell of [
          logRows(page).first().getByText('失敗', { exact: true }),
          logRows(page).first().getByText('ファイルサーバーに接続できませんでした'),
        ]) {
          const box = await cell.boundingBox();
          expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
        }
      }
      // 取り込み元のカードの中身（参照名の入力欄・ボタン・結果の表示）が、カードの枠に収まる
      for (const sourceId of ['robot', 'environment-sensor'] as const) {
        const card = await page.getByTestId(`source-${sourceId}`).boundingBox();
        const left = card?.x ?? -1;
        const right = (card?.x ?? 0) + (card?.width ?? 0);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(right).toBeLessThanOrEqual(viewport.width);
        const inner = await page
          .getByTestId(`source-${sourceId}`)
          .locator('input, select, button, [role="status"], .tag')
          .evaluateAll((nodes) =>
            nodes
              .map((node) => node.getBoundingClientRect())
              .filter((rect) => rect.width > 0)
              .map((rect) => ({ left: rect.left, right: rect.right })),
          );
        for (const rect of inner) {
          expect(rect.left, `${sourceId} の内側の左端`).toBeGreaterThanOrEqual(left - 1);
          expect(rect.right, `${sourceId} の内側の右端`).toBeLessThanOrEqual(right + 1);
        }
      }
      // 2ページ目（失敗のログ 13 件のうちの残り）
      await page.getByTestId('ingestion-logs').getByRole('button', { name: '次へ' }).click();
      await expect(logRows(page)).toHaveCount(3);
      await expectTableIntact(page, '.log-table', 'tbody tr td:last-child', tableChecks);
      await page.getByTestId('ingestion-logs').getByRole('button', { name: '前へ' }).click();
      await shot(page, testInfo, `uc24-ingestion-${String(viewport.width)}`);
    });
  });
}
