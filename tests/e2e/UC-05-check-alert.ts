/**
 * UC-05 異常の通知を受けて状況を確認する（SC-05、ヘッダー、SC-03。FR-7.1、FR-7.4、FR-7.5、FR-7.6）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、異常の通知を受け取る
 *               2. 農作業者が、通知からダッシュボードを開く（未読の通知を確認できる）
 *               3. システムが、異常の対象（ハウス・ロボット・センサー）、内容、根拠のメトリクスを表示する（UC-02）
 *               4. 農作業者が、推奨アクションを確認する（UC-04）
 *               5. 農作業者が、現場でロボット・ハウスの状態を確認し、復旧・調整を行う（システム外）
 *               6. システムが、農作業者が確認した通知を既読にする
 *               7. 農作業者が、対応の結果を記録する（UC-06）
 *   代替フロー  ・通知に気づかなかった場合も、ダッシュボードで異常の状態を確認できる
 *               ・通知が取り込み失敗（UC-24）の場合は、取り込みの状況を確認し（UC-16）、設定や接続先を見直す
 *   事後条件    農作業者が、異常に対応している、または対応を判断している
 *
 * 値の同値分割: 通知の種類（異常検知・取り込み失敗）、ステータス（注意・異常）、対象（ハウス・センサー）、確認の経路（ヘッダー・通知の一覧・ダッシュボード）、
 * 既読の状態（未読・既読）、利用者（通知を受け取る人・確認する人。別のブラウザ）。
 * 関連するユースケース: UC-10（通知の発生）、UC-02・UC-04（根拠・推奨アクション）、UC-06・UC-07（記録）、UC-22（一覧・既読）、UC-24・UC-16・UC-15。
 */

import { expect, test } from '@playwright/test';
import {
  ROBOT_ID,
  SENSOR_ID,
  USER_B,
  addEntry,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  goToMenu,
  newUserSession,
  openAs,
  placeFile,
  prepareApp,
  robotJson,
  setMock,
  unreadBadge,
} from './support/app.ts';
import { fillEntryForm, saveEntry } from './support/entry.ts';
import { seedAbnormalEnvironment } from './support/notifications.ts';
import {
  environmentData,
  harvestAccuracyData,
  hoursAgo,
  seed,
  shot,
} from './support/viewpoint-scenarios.ts';
import { locatorOf } from './support/pages.ts';

const rows = locatorOf('notification-row');

test.describe('基本フロー: 異常の通知を受け取り、通知から対象・根拠・推奨アクションを確認し、既読にする', () => {
  test('通知を受け取ると、ヘッダーの未読の件数に表れる。通知から、異常の対象（設備）・内容・根拠のメトリクス・推奨アクションを開き、確認した通知は既読になる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await alignBrowserClock(page);
    await openAs(page, '/');
    await expect(unreadBadge(page)).toHaveText('0');

    // 1. 異常の通知を受け取る（データの入力・取り込みで、異常になる）
    await addEntry(request, {
      equipmentId: SENSOR_ID,
      category: 'ENVIRONMENT',
      observedAt: hoursAgo(1),
      items: { temperatureCelsius: 40, humidityPercent: 60, illuminanceLux: 30000, co2Ppm: 900 },
    });
    await expect(unreadBadge(page)).not.toHaveText('0', { timeout: 20_000 });

    // 2. 通知から、確認する画面を開く（未読の通知を確認できる）
    await page.getByRole('link', { name: /未読の通知/ }).click();
    const notification = rows(page)
      .filter({ hasText: '環境適応性' })
      .filter({ hasText: '環境センサー1' });
    await expect(notification).toHaveAttribute('data-read-state', 'UNREAD');
    await shot(page, testInfo, 'uc05-notifications');
    const unreadBefore = Number(await unreadBadge(page).textContent());
    await notification.getByRole('link', { name: '詳細を確認' }).click();

    // 3. 異常の対象・内容・根拠のメトリクス（UC-02）
    await expect(page.getByRole('heading', { level: 1 })).toContainText('環境適応性');
    await expect(page.locator('.page-meta')).toContainText('対象: 環境センサー1');
    await expect(
      page.getByTestId('diagnosis').locator('.diagnosis-head .status-badge'),
    ).toContainText('異常');
    await expect(page.getByTestId('diagnostic-message')).toContainText('温度 40.0℃（異常）');
    await expect(page.getByTestId('metric-temperatureCelsius').locator('td').first()).toHaveText(
      '40.0℃',
    );
    await expect(page.getByTestId('metric-temperatureCelsius').locator('td').nth(1)).toContainText(
      '異常',
    );
    // 4. 推奨アクション（UC-04）
    await expect(page.getByTestId('recommended-action')).toContainText('対応が必要な状態です');
    await shot(page, testInfo, 'uc05-detail');

    // 6. 確認した通知は、既読になる（ヘッダーの件数が、減る）
    await expect(unreadBadge(page)).toHaveText(String(unreadBefore - 1));
    await goToMenu(page, '通知');
    await expect(
      rows(page).filter({ hasText: '環境適応性' }).filter({ hasText: '環境センサー1' }),
    ).toHaveAttribute('data-read-state', 'READ');
  });

  test('ダッシュボードの異常のカードからも、同じ観点の詳細（根拠・推奨アクション）を開ける', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seedAbnormalEnvironment(request);
    await alignBrowserClock(page);
    await openAs(page, '/');

    await page
      .getByTestId('card-environmentalAdaptability')
      .locator('h3')
      .getByRole('link')
      .click();

    await expect(page.getByTestId('recommended-action')).toBeVisible();
    await expect(page.getByTestId('metric-temperatureCelsius')).toBeVisible();
  });

  test('注意の通知も、同じように確認でき、ステータス（注意）・推奨アクション（確認が望ましい）を示す', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, environmentData({ temperature: 27 }));
    await alignBrowserClock(page);
    await openAs(page, '/notifications');
    const notification = rows(page)
      .filter({ hasText: '環境適応性' })
      .filter({ hasText: 'ハウス1' });
    await expect(notification.locator('.status-badge')).toContainText('注意');

    await notification.getByRole('link', { name: '詳細を確認' }).click();

    await expect(page.getByTestId('recommended-action')).toContainText('確認が望ましい状態です');
  });

  test('ロボットが対象の異常の通知も、通知から、対象（ロボット）・内容・根拠のメトリクス・推奨アクションを確認でき、確認した通知は既読になる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, harvestAccuracyData('ERROR'));
    await alignBrowserClock(page);
    await openAs(page, '/');
    const unreadBefore = Number(await unreadBadge(page).textContent());
    expect(unreadBefore).toBeGreaterThanOrEqual(1);

    await page.getByRole('link', { name: /未読の通知/ }).click();
    const notification = rows(page)
      .filter({ hasText: '収穫精度' })
      .filter({ hasText: '収穫ロボット1' });
    await expect(notification).toHaveAttribute('data-read-state', 'UNREAD');
    await expect(notification.locator('.status-badge')).toContainText('異常');
    await shot(page, testInfo, 'uc05-notifications-robot');
    await notification.getByRole('link', { name: '詳細を確認' }).click();

    // 異常の対象（ロボット）・内容・根拠のメトリクス・推奨アクション
    await expect(page.getByRole('heading', { level: 1 })).toContainText('収穫精度');
    await expect(page.locator('.page-meta')).toContainText('対象: 収穫ロボット1');
    await expect(
      page.getByTestId('diagnosis').locator('.diagnosis-head .status-badge'),
    ).toContainText('異常');
    await expect(
      page.getByTestId('metric-marketableFruitRatePercent').locator('td').first(),
    ).toHaveText('78.3%');
    await expect(page.getByTestId('recommended-action')).toContainText('対応が必要な状態です');
    await shot(page, testInfo, 'uc05-detail-robot');

    await expect(unreadBadge(page)).toHaveText(String(unreadBefore - 1));
    await goToMenu(page, '通知');
    await expect(
      rows(page).filter({ hasText: '収穫精度' }).filter({ hasText: '収穫ロボット1' }),
    ).toHaveAttribute('data-read-state', 'READ');
  });
});

test.describe('代替フロー: 通知に気づかなかった場合も、ダッシュボードで、異常の状態を確認できる', () => {
  test('通知を一度も開かなくても、ダッシュボードに、異常のカード（診断メッセージ・推奨アクション）と、未読の件数が表示される', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seedAbnormalEnvironment(request);
    await alignBrowserClock(page);

    await openAs(page, '/');

    const card = page.getByTestId('card-environmentalAdaptability');
    await expect(card.locator('.status-badge')).toContainText('異常');
    await expect(card.locator('.diagnostic')).toContainText('温度 40.0℃（異常）');
    await expect(card.locator('.action')).toContainText('対応が必要な状態です');
    await expect(unreadBadge(page)).not.toHaveText('0');
    await expect(page.getByTestId('summary-ERROR').locator('.summary-count')).not.toHaveText('0');
  });
});

test.describe('代替フロー: 通知が取り込み失敗の場合は、取り込みの状況を確認し、設定や接続先を見直す（UC-24 → UC-16 → UC-15）', () => {
  test('取り込み失敗の通知から、取り込みの状況（ログ）を開き、接続先の設定を見直して、復旧後に取り込める', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await setMock(request, 'file-server', 'DOWN');
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');
    await page.getByTestId('source-robot').getByRole('button', { name: '即時取得' }).click();
    await expect(page.getByTestId('result-robot')).toContainText('取得しました（失敗）');
    await expect(unreadBadge(page)).toHaveText('1');

    await goToMenu(page, '通知');
    await rows(page)
      .filter({ hasText: 'データ取得失敗' })
      .getByRole('link', { name: '取り込みの状況を確認' })
      .click();

    await expect(page).toHaveURL(/\/settings\/ingestion$/);
    await expect(page.getByTestId('ingestion-log-row').first()).toContainText(
      'ファイルサーバーに接続できませんでした',
    );
    await expect(unreadBadge(page)).toHaveText('0');
    // 設定を見直す（接続先の参照名の変更）→ 復旧 → 取り込む
    await page
      .getByTestId('source-robot')
      .getByLabel('接続先（接続設定の参照名）')
      .fill('FILE_SERVER_NEW');
    await page.getByTestId('source-robot').getByRole('button', { name: '設定を保存' }).click();
    await expect(page.getByTestId('result-robot')).toHaveText('設定を保存しました');
    await setMock(request, 'file-server', 'UP');
    placeFile('robot', 'a.json', robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 10 } }]));
    await page.getByTestId('source-robot').getByRole('button', { name: '接続テスト' }).click();
    await expect(page.getByTestId('result-robot')).toHaveText('接続できました');
    // 復旧後は、即時取得で、取り込める
    await page.getByTestId('source-robot').getByRole('button', { name: '即時取得' }).click();
    await expect(page.getByTestId('result-robot')).toContainText('取得しました（成功）');
    await expect(page.getByTestId('result-robot')).toContainText('取り込み 1 件');
    await shot(page, testInfo, 'uc05-ingestion-recovered');
  });
});

test.describe('シナリオ: 異常の検知 → 通知 → 確認 → 復旧 → 記録 → 既読（UC-07 → UC-10 → UC-05 → UC-02/UC-04 → UC-06 → UC-01 → UC-22。利用者A・B）', () => {
  test('利用者Aの入力で異常になり、利用者Bが通知を確認して、根拠・推奨アクションを見て、復旧の結果を記録する。それぞれの既読は、利用者ごと', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    // 利用者A: センサーの値を手動で補完する（温度 40℃ = 異常）。UC-07 → UC-10
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');
    await fillEntryForm(page, {
      equipment: SENSOR_ID,
      category: 'ENVIRONMENT',
      observedAt: '2026-10-09T10:00',
      items: { 温度: '40', 湿度: '60', 照度: '30000', CO2濃度: '900' },
      note: '現場の温度計で、40℃を確認した',
    });
    await saveEntry(page);
    await expect(
      page.getByTestId('related-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('異常');

    // 利用者B: ログインし、未読の通知を確認する（UC-05 の 1・2）
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/', USER_B);
    const unreadForB = Number(await unreadBadge(b.page).textContent());
    expect(unreadForB).toBeGreaterThanOrEqual(2);
    await b.page.getByRole('link', { name: /未読の通知/ }).click();
    const target = rows(b.page).filter({ hasText: '環境適応性' }).filter({ hasText: 'ハウス1' });
    await expect(target).toHaveAttribute('data-read-state', 'UNREAD');

    // 利用者B: 異常の対象・内容・根拠・推奨アクションを確認する（UC-05 の 3・4。UC-02・UC-04）
    await target.getByRole('link', { name: '詳細を確認' }).click();
    await expect(b.page.getByTestId('diagnostic-message')).toContainText('温度 40.0℃（異常）');
    await expect(b.page.getByTestId('recommended-action')).toContainText('対応が必要な状態です');
    await expect(b.page.getByTestId('source-data')).toContainText('手動入力');
    await shot(b.page, testInfo, 'uc05-scenario-b-detail');
    // 6. 確認した通知が、既読になる（Bの未読が減る）
    await expect(unreadBadge(b.page)).toHaveText(String(unreadForB - 1));

    // 5. 現場で復旧する（システム外）。復旧後のセンサーのデータが届く → 状態が改善する
    await advanceMinutes(request, 120);
    await seed(request, {
      series: [
        {
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          from: '2026-10-09T03:30:00.000Z',
          to: '2026-10-09T04:50:00.000Z',
          intervalMinutes: 10,
          value: 20,
        },
      ],
    });

    // 7. 利用者B: 対応の結果を記録する（UC-06）
    await b.page.goto('/data-entry');
    await fillEntryForm(b.page, {
      equipment: ROBOT_ID,
      category: 'FAILURE',
      observedAt: '2026-10-09T11:30',
      items: { 故障回数: '1', 復旧に要した時間: '45' },
      note: '換気を調整し、温度が下がった',
    });
    await saveEntry(b.page);
    await expect(b.page.getByTestId('entry-result')).toContainText('保存しました');

    // ダッシュボード（UC-01）: 状態が改善している（長期の平均が下がり、環境適応性は、注意または正常）
    await b.page.goto('/');
    await expect(
      b.page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('正常');

    // 利用者A: 自分の未読は、Bの既読に影響されない。通知を確認して、すべて既読にする（UC-22）
    await page.goto('/notifications');
    await expect(
      rows(page).filter({ hasText: '環境適応性' }).filter({ hasText: 'ハウス1' }),
    ).toHaveAttribute('data-read-state', 'UNREAD');
    await page.getByRole('button', { name: 'すべての通知を既読にする' }).click();
    await expect(unreadBadge(page)).toHaveText('0');
    // 利用者B: 自分の既読は、そのまま（Aが全件を既読にしても、Bの既読・未読には影響しない）
    await b.page.goto('/notifications');
    await expect(
      rows(b.page).filter({ hasText: '環境適応性' }).filter({ hasText: 'ハウス1' }),
    ).toHaveAttribute('data-read-state', 'READ');
    await expect(
      rows(b.page).filter({ hasText: '環境適応性' }).filter({ hasText: '環境センサー1' }),
    ).toHaveAttribute('data-read-state', 'UNREAD');
    await b.context.close();
  });
});
