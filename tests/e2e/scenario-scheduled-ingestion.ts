/**
 * シナリオ: 取り込みの設定にもとづく定期の取り込みと、データの鮮度・異常の検知（複数の利用者。利用者A・Bのブラウザを切り替える）。
 *
 * 通るユースケース（use-cases.md）:
 *   UC-12 Aが、設備ごとの取得間隔（ロボット15分・環境センサー5分）を設定 → UC-08・UC-09 定期の取り込み（JB-01）でロボット・センサーのデータが入る → UC-01 Bが、最新のデータで評価を確認
 *   → UC-01 取得間隔 × 3 を超えて新しいデータがないと、Bの画面に「データが古い」旨が出る → UC-09・UC-10 新しいセンサーのデータ（異常な温度）が、定期の取り込みで入る
 *   → UC-01・UC-22 古い旨が消え、異常の通知がBに届く（取得間隔が来ていないロボットは取り込まない） → UC-15 Aが、ロボットの取り込みを無効にする
 *   → UC-16 Bが、取り込みのログで、無効にしたロボットの取り込みがないことを確認 → UC-11 連携の結果（成功）を確認
 *
 * 各ユースケースの値の同値分割は、UC-NN-*.ts が担う。ここでは、ユースケースの連なりと、利用者をまたぐ影響を確かめる。
 */

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  ROBOT_ID,
  SENSOR_ID,
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
  sensorJson,
  setEquipmentInterval,
  unreadBadge,
} from './support/app.ts';
import { federationRows, logRows, sourceCard } from './support/ingestion.ts';
import { shot } from './support/viewpoint-scenarios.ts';

const staleWarning = (page: Page) =>
  page.getByRole('alert').filter({ hasText: 'データが古くなっています' });
const environmentBadge = (page: Page) =>
  page.getByTestId('card-environmentalAdaptability').locator('.status-badge');

/** 取り込みのログ（API）の件数。取り込み元ごと。 */
async function logCount(
  request: APIRequestContext,
  sourceId: 'robot' | 'environment-sensor',
): Promise<number> {
  const body = await apiOk<{ items: unknown[] }>(
    request,
    'GET',
    `/ingestion/logs?sourceId=${sourceId}&limit=100`,
  );
  return body.items.length;
}

test.describe('シナリオ: 取り込みの設定にもとづく定期の取り込みと、データの鮮度・異常の検知（UC-15 → UC-08・09 → UC-01 → UC-09・10 → UC-01・22 → UC-15 → UC-16 → UC-11）', () => {
  test('Aが取得間隔・有効／無効を設定し、定期の取り込みが、その設定どおりに動く。Bは、データが古くなった旨と、新しいデータによる異常の通知を、画面で確認できる', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await alignBrowserClock(page);

    // UC-12: 利用者Aが、設備ごとの取得間隔を設定する（ロボット 15 分・環境センサー 5 分。#197）。取り込みの設定の画面には、取得間隔の入力欄がない
    await setEquipmentInterval(request, ROBOT_ID, 15);
    await setEquipmentInterval(request, SENSOR_ID, 5);
    await openAs(page, '/');
    await goToMenu(page, '取り込み');
    await expect(sourceCard(page, 'robot').getByLabel('取得間隔')).toHaveCount(0);

    // UC-08・UC-09: ファイルサーバーにファイルが置かれ、定期の取り込み（JB-01）で、取り込まれる
    placeFile('robot', 'robot-1.json', robotJson([{ hoursAgo: 1, fields: { harvestCount: 10 } }]));
    placeFile(
      'environment-sensor',
      'sensor-1.json',
      sensorJson([{ hoursAgo: 1, temperature: 20, humidity: 60, illuminance: 30000, co2: 900 }]),
    );
    await runJob(request, 'JB-01');
    expect(await logCount(request, 'robot')).toBe(1);
    expect(await logCount(request, 'environment-sensor')).toBe(1);

    // UC-01: 利用者Bが、最新のデータで、評価を確認する（環境適応性は正常。データは新しい）
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/', USER_B);
    await expect(environmentBadge(b.page)).toContainText('正常');
    await expect(b.page.locator('.header-data-status')).toContainText('最終のデータ取得');
    await expect(b.page.locator('.header-data-status')).not.toContainText('古い');
    await expect(staleWarning(b.page)).toHaveCount(0);
    await shot(b.page, testInfo, 'scenario-scheduled-b-fresh');

    // UC-01: 新しいデータがないまま、取得間隔（ロボット・センサーのうち最長の15分。#198 まで）× 3 = 45分を超えると、「データが古い」旨が表示される
    await advanceMinutes(request, 46);
    await b.page.reload();
    await expect(staleWarning(b.page)).toBeVisible();
    await expect(b.page.locator('.header-data-status')).toContainText('（古い）');
    await shot(b.page, testInfo, 'scenario-scheduled-b-stale');

    // 取得間隔が来たジョブ（JB-01）が、新しいファイルがないまま動いても、データは古いまま（取り込むデータがないため）
    await runJob(request, 'JB-01');
    await b.page.reload();
    await expect(staleWarning(b.page)).toBeVisible();

    // UC-09・UC-10: 新しいセンサーのデータ（異常な温度）が置かれ、センサーの取得間隔（5分）が来ると、取り込まれる
    const unreadBefore = Number(await unreadBadge(b.page).textContent());
    const robotLogsBefore = await logCount(request, 'robot');
    placeFile(
      'environment-sensor',
      'sensor-2.json',
      sensorJson([{ hoursAgo: 0.5, temperature: 40, humidity: 60, illuminance: 30000, co2: 900 }]),
    );
    await advanceMinutes(request, 6);
    await runJob(request, 'JB-01');

    // ロボットの取得間隔（15分）は、まだ来ていないので、取り込まない（UC-15 の設定が、定期の取り込みに使われる）
    expect(await logCount(request, 'robot')).toBe(robotLogsBefore);
    expect(await logCount(request, 'environment-sensor')).toBeGreaterThan(1);

    // UC-01・UC-22: Bの画面から、「古い」旨が消え、センサーの異常の通知が届く
    await b.page.reload();
    await expect(staleWarning(b.page)).toHaveCount(0);
    await expect(b.page.locator('.header-data-status')).not.toContainText('古い');
    await b.page.goto('/?horizon=SHORT');
    await expect(environmentBadge(b.page)).toContainText('異常');
    await goToMenu(b.page, '通知');
    await expect
      .poll(async () => Number(await unreadBadge(b.page).textContent()))
      .toBeGreaterThan(unreadBefore);
    await expect(
      b.page
        .getByTestId('notification-row')
        .filter({ hasText: '環境適応性' })
        .filter({ hasText: '【異常】' })
        .first(),
    ).toHaveAttribute('data-read-state', 'UNREAD');
    await shot(b.page, testInfo, 'scenario-scheduled-b-alert');

    // UC-15: Aが、ロボットの自動取り込みを、無効にする
    await page.reload();
    await sourceCard(page, 'robot').getByLabel('自動取り込みを有効にする').uncheck();
    await sourceCard(page, 'robot').getByRole('button', { name: '設定を保存' }).click();
    await expect(page.getByTestId('result-robot')).toHaveText('設定を保存しました');

    // ロボットの取得間隔を十分に過ぎても、無効なロボットは取り込まず、センサーは取り込まれる
    const sensorLogsBefore = await logCount(request, 'environment-sensor');
    placeFile(
      'robot',
      'robot-2.json',
      robotJson([{ hoursAgo: 0.25, fields: { harvestCount: 5 } }]),
    );
    placeFile(
      'environment-sensor',
      'sensor-3.json',
      sensorJson([{ hoursAgo: 0.25, temperature: 21, humidity: 60, illuminance: 30000, co2: 900 }]),
    );
    await advanceMinutes(request, 20);
    await runJob(request, 'JB-01');
    expect(await logCount(request, 'robot')).toBe(robotLogsBefore);
    expect(await logCount(request, 'environment-sensor')).toBeGreaterThan(sensorLogsBefore);

    // UC-16: Bが、取り込みのログで、ロボットの取り込みが増えていない（センサーは増えている）ことを確認する
    await goToMenu(b.page, '取り込み');
    await expect(logRows(b.page).filter({ hasText: 'ロボットデータ' })).toHaveCount(
      robotLogsBefore,
    );
    await expect(logRows(b.page).filter({ hasText: '環境センサーデータ' })).toHaveCount(
      sensorLogsBefore + 1,
    );
    await expect(
      sourceCard(b.page, 'robot').getByLabel('自動取り込みを有効にする'),
    ).not.toBeChecked();

    // UC-11・UC-16: 連携のジョブで、取り込んだデータ・評価結果が送られ、連携の結果（成功）をBが確認する
    await runJob(request, 'JB-03');
    await b.page.getByRole('button', { name: '最新の状況を読み込む' }).click();
    await expect(federationRows(b.page).first().locator('.log-result')).toHaveText('成功');
    await shot(b.page, testInfo, 'scenario-scheduled-b-status');
    await b.context.close();
  });
});
