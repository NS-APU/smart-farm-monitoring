/**
 * シナリオ: ファイルサーバーと農業情報基盤が同時に止まった場合の、検知・通知・確認・復旧（複数の利用者。利用者A・Bのブラウザを切り替える）。
 *
 * 通るユースケース（use-cases.md）:
 *   UC-23 Aが、Web Push を有効にする（Bは有効にしない） → UC-09・UC-10 Aが、センサーのデータを取り込み、異常を検知 → UC-11 農業情報基盤の停止で、連携は保留
 *   → UC-24 ファイルサーバーの停止で、ロボットの取り込みが失敗し、通知 → UC-23 Web Push は、Aの端末にだけ配信
 *   → UC-22・UC-05 Bが、通知を確認 → UC-16 Bが、取り込みの失敗・連携の保留を確認 → UC-01 停止中も、ダッシュボードは動く（農業情報基盤に依存しない）
 *   → UC-15・UC-08 復旧後、Bが、接続テストと即時取得で取り込み → UC-11・UC-16 農業情報基盤の復旧後、保留がすべて送られる
 *   → UC-22 Aの既読は、Bとは独立
 *
 * 各ユースケースの値の同値分割は、UC-NN-*.ts が担う。ここでは、ユースケースの連なりと、利用者をまたぐ影響を確かめる。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  USER_B,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  apiOk,
  goToMenu,
  newUserSession,
  openAs,
  placeFile,
  prepareApp,
  robotJson,
  runJob,
  sensorCsv,
  setMock,
  unreadBadge,
} from './support/app.ts';
import { federationRows, logRows, runNow, testConnection } from './support/ingestion.ts';
import { listNotifications } from './support/notifications.ts';
import { deliveredPushes, stubPush } from './support/push.ts';
import { shot } from './support/viewpoint-scenarios.ts';

const queueCount = (page: Page, status: string) =>
  page.getByTestId(`queue-${status}`).locator('strong');
const unreadOf = async (page: Page): Promise<number> =>
  Number(await unreadBadge(page).textContent());

test.describe('シナリオ: ファイルサーバー・農業情報基盤の停止と復旧（UC-23 → UC-09・10 → UC-11 → UC-24 → UC-22・05 → UC-16 → UC-01 → UC-15・08 → UC-11・16 → UC-22）', () => {
  test('Aだけが Web Push を有効にし、センサーの異常と取り込みの失敗が、Aの端末にだけ配信される。Bが状況を確認して復旧させ、連携の保留がすべて送られる。既読は、利用者ごと', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);

    // UC-23: 利用者Aが、Web Push を有効にする
    await stubPush(page, { device: 'a-phone' });
    await alignBrowserClock(page);
    await openAs(page, '/settings/push');
    await page.getByRole('button', { name: '有効にする' }).click();
    await expect(page.getByTestId('push-state')).toContainText('有効');

    // UC-09・UC-10: Aが、異常な温度のセンサーデータを取り込む（異常を検知し、通知を作る）
    placeFile(
      'environment-sensor',
      'sensor.csv',
      sensorCsv([{ hoursAgo: 0.5, temperature: 40, humidity: 60, illuminance: 30000, co2: 900 }]),
    );
    await goToMenu(page, '取り込み');
    await expect(await runNow(page, 'environment-sensor')).toContainText('取得しました（成功）');

    // UC-11: 農業情報基盤が停止している間は、連携を保留する
    await setMock(request, 'federation', 'DOWN');
    await runJob(request, 'JB-03');
    await page.getByRole('button', { name: '最新の状況を読み込む' }).click();
    await expect(federationRows(page).first().locator('.log-result')).toHaveText('保留');
    await expect(queueCount(page, 'HELD')).not.toHaveText('0');

    // UC-24: ファイルサーバーも停止し、ロボットの取り込みが失敗する（失敗の通知を作る）
    await setMock(request, 'file-server', 'DOWN');
    await expect(await runNow(page, 'robot')).toContainText('取得しました（失敗）');
    await shot(page, testInfo, 'scenario-outage-a-failed');

    // UC-23: 通知（異常検知・取り込み失敗）は、有効にしたAの端末（購読の識別子が1つだけ）にだけ配信される（Bは有効にしていない）
    await runJob(request, 'JB-04');
    const created = await listNotifications(request);
    expect(created.length).toBeGreaterThanOrEqual(2);
    const delivered = await deliveredPushes(request);
    expect(delivered.map((item) => item.notificationId).sort()).toEqual(
      created.map((item) => item.notificationId).sort(),
    );
    expect(new Set(delivered.map((item) => item.subscriptionId)).size).toBe(1);

    // UC-22・UC-05: 利用者Bが、ログインして、未読の通知を確認し、取り込み失敗の通知から、状況を開く
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/', USER_B);
    await expect(unreadBadge(b.page)).toHaveText(String(created.length));
    await goToMenu(b.page, '通知');
    const failure = b.page
      .getByTestId('notification-row')
      .filter({ hasText: 'データ取得失敗' })
      .filter({ hasText: 'ロボットデータ' });
    await expect(failure).toContainText('ファイルサーバーに接続できませんでした');
    await shot(b.page, testInfo, 'scenario-outage-b-notifications');
    await failure.getByRole('link', { name: '取り込みの状況を確認' }).click();

    // UC-16: Bが、取り込みのログ（ロボットは失敗・センサーは成功）と、連携の状況（保留）を確認する
    await expect(logRows(b.page)).toHaveCount(2);
    await expect(logRows(b.page).filter({ hasText: 'ロボットデータ' })).toContainText('失敗');
    await expect(logRows(b.page).filter({ hasText: '環境センサーデータ' })).toContainText('成功');
    await expect(federationRows(b.page).first().locator('.log-result')).toHaveText('保留');
    const heldWhileDown = Number(await queueCount(b.page, 'HELD').textContent());
    expect(heldWhileDown).toBeGreaterThan(0);
    await expect(unreadBadge(b.page)).toHaveText(String(created.length - 1));
    await shot(b.page, testInfo, 'scenario-outage-b-status');

    // UC-01: 停止中も、ダッシュボードは動く（農業情報基盤・ファイルサーバーの状態に依存しない）
    await goToMenu(b.page, 'ダッシュボード');
    await expect(
      b.page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('異常');

    // 復旧（システム外）→ UC-15・UC-08: Bが、接続テストで復旧を確認し、即時取得で、ロボットのデータを取り込む
    await setMock(request, 'file-server', 'UP');
    placeFile('robot', 'robot.json', robotJson([{ hoursAgo: 0.25, fields: { harvestCount: 8 } }]));
    await goToMenu(b.page, '取り込み');
    await expect(await testConnection(b.page, 'robot')).toHaveText('接続できました');
    await expect(await runNow(b.page, 'robot')).toContainText('取得しました（成功）');
    await expect(logRows(b.page)).toHaveCount(3);
    await expect(logRows(b.page).first()).toContainText('成功');

    // UC-11・UC-16: 農業情報基盤の復旧後、保留していた項目が、すべて送られる（失われない。件数と、評価・観測値の種別で確認する）
    await setMock(request, 'federation', 'UP');
    await advanceMinutes(request, 6);
    await runJob(request, 'JB-03');
    await b.page.getByRole('button', { name: '最新の状況を読み込む' }).click();
    await expect(federationRows(b.page).first().locator('.log-result')).toHaveText('成功');
    await expect(queueCount(b.page, 'HELD')).toHaveText('0');
    await expect(queueCount(b.page, 'PENDING')).toHaveText('0');
    const received = await apiOk<{ items: { targetType: string }[] }>(
      request,
      'GET',
      '/dev/mocks/federation/received',
    );
    expect(received.items.length).toBeGreaterThanOrEqual(heldWhileDown);
    expect(received.items.some((item) => item.targetType === 'EVALUATION')).toBe(true);
    expect(received.items.some((item) => item.targetType === 'OBSERVATION')).toBe(true);
    await shot(b.page, testInfo, 'scenario-outage-b-recovered');

    // UC-23: 復旧後に作られた通知も、Aの端末にだけ配信される（1件につき1回）
    await runJob(request, 'JB-04');
    const all = await listNotifications(request);
    const deliveredAll = await deliveredPushes(request);
    expect(deliveredAll.map((item) => item.notificationId).sort()).toEqual(
      all.map((item) => item.notificationId).sort(),
    );

    // UC-22: Aの未読は、Bが読んだ通知の影響を受けない。Aが、すべて既読にしても、Bの未読は変わらない
    await page.goto('/notifications');
    await expect(
      page
        .getByTestId('notification-row')
        .filter({ hasText: 'データ取得失敗' })
        .filter({ hasText: 'ロボットデータ' }),
    ).toHaveAttribute('data-read-state', 'UNREAD');
    const unreadForB = await unreadOf(b.page);
    await page.getByRole('button', { name: 'すべての通知を既読にする' }).click();
    await expect(unreadBadge(page)).toHaveText('0');
    await b.page.reload();
    await expect(unreadBadge(b.page)).toHaveText(String(unreadForB));
    await b.context.close();
  });
});
