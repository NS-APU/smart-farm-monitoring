/**
 * シナリオ: ステータスコード・設備の構成の変更が、取り込み・評価・通知・一覧に反映される（複数の利用者。利用者A・Bのブラウザを切り替える）。
 *
 * 通るユースケース（use-cases.md）:
 *   UC-17 Aが、ステータスコード（充電待ち。注意）を登録 → UC-15・UC-08 Aが、そのコードを含むロボットデータを取り込み
 *   → UC-01・UC-04 Bが、ダッシュボードで、収穫速度の注意・コードの名称・推奨アクションを確認 → UC-20 Bが、一覧で、コードの名称を確認
 *   → UC-17 Aが、コードのカテゴリを異常へ変更 → UC-01・UC-10・UC-22 Bの画面は異常になり、通知が届く
 *   → UC-12 Aが、ロボットの名称を変更 → UC-20・UC-22 Bの一覧・通知・設備の選択に、新しい名称が現れる
 *   → UC-12 Aが、ロボットを削除 → UC-01・UC-20 評価の対象から外れ（不明）、過去のデータは残る → UC-18 Aが、変更履歴で、各操作を確認
 *
 * 各ユースケースの値の同値分割は、UC-NN-*.ts が担う。ここでは、ユースケースの連なりと、利用者をまたぐ影響を確かめる。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  USER_B,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  confirmDialog,
  goToMenu,
  newUserSession,
  openAs,
  placeFile,
  prepareApp,
  robotJson,
  unreadBadge,
} from './support/app.ts';
import { runNow } from './support/ingestion.ts';
import { shot } from './support/viewpoint-scenarios.ts';

const speedCard = (page: Page) => page.getByTestId('card-harvestSpeed');
const observationRows = (page: Page) => page.getByTestId('observation-row');
const notificationRows = (page: Page) => page.getByTestId('notification-row');
const auditRows = (page: Page) => page.getByTestId('audit-row');
const headerEquipment = (page: Page) => page.getByRole('banner').getByLabel('対象の設備');

test.describe('シナリオ: ステータスコード・設備の構成の変更の反映（UC-17 → UC-15・08 → UC-01・04 → UC-20 → UC-17 → UC-10・22 → UC-12 → UC-20 → UC-12 → UC-18）', () => {
  test('Aがコードを登録して取り込み、Bが評価・一覧で確認する。Aがカテゴリ・ロボットの名称・削除を変更すると、Bの評価・通知・一覧・設備の選択に反映される。変更は履歴に残る', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await alignBrowserClock(page);

    // UC-17: 利用者Aが、ステータスコード「充電待ち」（注意）を登録する
    await openAs(page, '/');
    await goToMenu(page, 'ステータスコード');
    const addForm = page.getByTestId('status-code-add');
    await addForm.getByLabel('コード値').fill('CHARGING_WAIT');
    await addForm.getByLabel('名称').fill('充電待ち');
    await addForm.getByLabel('カテゴリ').selectOption('CAUTION');
    await addForm.getByLabel('説明').fill('充電のため、収穫を待っている');
    await addForm.getByRole('button', { name: '登録する' }).click();
    await expect(page.getByTestId('status-codes-notice')).toHaveText('登録しました');

    // UC-15・UC-08: Aが、そのコードを含むロボットデータを、即時取得で取り込む
    const fields = {
      harvestCount: 10,
      harvestSecondsPerFruit: 36,
      operatingHours: 0.25,
      harvestOperatingHours: 0.1,
      travelStoppedHours: 0.002,
      statusCode: 'CHARGING_WAIT',
    };
    placeFile(
      'robot',
      'robot.json',
      robotJson([
        { hoursAgo: 0.5, fields },
        { hoursAgo: 0.25, fields },
      ]),
    );
    await goToMenu(page, '取り込み');
    await expect(await runNow(page, 'robot')).toContainText('取得しました（成功）');

    // UC-01・UC-04: 利用者Bが、ダッシュボードで、収穫速度が注意であること・コードの名称・推奨アクションを確認する
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/', USER_B);
    await expect(speedCard(b.page).locator('.status-badge')).toContainText('注意');
    await expect(speedCard(b.page)).toContainText('充電待ち');
    await expect(speedCard(b.page)).toContainText('推奨アクション: 確認が望ましい状態です');
    await shot(b.page, testInfo, 'scenario-config-b-caution');

    // UC-20: Bが、取り込み済みデータの一覧で、ステータスコードを名称で確認する
    await goToMenu(b.page, '取り込み済みデータ');
    const statusRows = observationRows(b.page).filter({ hasText: 'ステータスコード' });
    await expect(statusRows).toHaveCount(2);
    await expect(statusRows.first()).toContainText('充電待ち');
    await expect(statusRows.first()).toContainText('自動取り込み');

    // UC-17: Aが、コード「充電待ち」のカテゴリを、異常へ変更する（変更後の評価が、更新される）
    await advanceMinutes(request, 1);
    await goToMenu(page, 'ステータスコード');
    await page
      .locator('[data-testid="status-code-row"][data-code="CHARGING_WAIT"]')
      .getByRole('button', { name: '修正' })
      .click();
    await page.getByTestId('status-code-edit').getByLabel('カテゴリ').selectOption('ERROR');
    await page.getByTestId('status-code-edit').getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('status-codes-notice')).toHaveText('修正しました');

    // UC-01・UC-10・UC-22: Bの画面は、異常になり、異常の通知が届く
    const unreadBefore = Number(await unreadBadge(b.page).textContent());
    await b.page.goto('/');
    await expect(speedCard(b.page).locator('.status-badge')).toContainText('異常');
    await expect(speedCard(b.page)).toContainText('推奨アクション: 対応が必要な状態です');
    await b.page.goto('/notifications');
    await expect
      .poll(async () => Number(await unreadBadge(b.page).textContent()))
      .toBeGreaterThan(unreadBefore);
    const alert = notificationRows(b.page)
      .filter({ hasText: '収穫速度' })
      .filter({ hasText: '【異常】' });
    await expect(alert.first()).toHaveAttribute('data-read-state', 'UNREAD');
    await shot(b.page, testInfo, 'scenario-config-b-error');

    // UC-12: Aが、ロボットの名称を変更する（履歴は日時の順に並ぶため、操作の間は、時計を進める）
    await advanceMinutes(request, 1);
    await goToMenu(page, '設備');
    await page
      .locator('[data-testid="equipment-row"][data-equipment-id="ROBOT-01"]')
      .getByRole('button', { name: '修正' })
      .click();
    await page.getByTestId('equipment-edit').getByLabel('名称').fill('改名ロボット');
    await page.getByTestId('equipment-edit').getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('equipment-notice')).toHaveText('修正しました');

    // UC-20・UC-22: Bの設備の選択・一覧・通知に、新しい名称が現れる
    await b.page.reload();
    await expect(headerEquipment(b.page)).toContainText('改名ロボット');
    await expect(
      notificationRows(b.page).filter({ hasText: '改名ロボット' }).first(),
    ).toBeVisible();
    await b.page.goto('/observations');
    await expect(observationRows(b.page).filter({ hasText: '改名ロボット' }).first()).toBeVisible();
    await expect(observationRows(b.page).filter({ hasText: '収穫ロボット1' })).toHaveCount(0);

    // UC-12: Aが、ロボットを削除する（確認を求める。論理削除）
    await advanceMinutes(request, 1);
    await goToMenu(page, '設備');
    await page
      .locator('[data-testid="equipment-row"][data-equipment-id="ROBOT-01"]')
      .getByRole('button', { name: '削除' })
      .click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('過去のデータは残ります');
    await confirmDialog(page, '削除');
    await expect(page.getByTestId('equipment-notice')).toHaveText('削除しました');

    // UC-01・UC-20: Bの設備の選択から外れ、ハウスの収穫速度は、評価の対象がなくなって不明になる。過去のデータは、一覧に残る
    await b.page.goto('/');
    await expect(headerEquipment(b.page)).not.toContainText('改名ロボット');
    await expect(speedCard(b.page).locator('.status-badge')).toContainText('不明');
    await b.page.goto('/observations');
    await expect(observationRows(b.page).filter({ hasText: 'ROBOT-01' }).first()).toBeVisible();
    await shot(b.page, testInfo, 'scenario-config-b-deleted');

    // UC-18: Aが、変更履歴で、ステータスコード（登録・編集）・設備（編集・削除）の操作を確認する
    await page.goto('/data-entry/history?targetType=status-code');
    await expect(auditRows(page)).toHaveCount(2);
    await expect(auditRows(page).nth(0)).toContainText('編集');
    await expect(auditRows(page).nth(1)).toContainText('登録');
    await page.goto('/data-entry/history?targetType=equipment');
    await expect(auditRows(page)).toHaveCount(2);
    await expect(auditRows(page).nth(0)).toContainText('削除');
    await expect(auditRows(page).nth(1)).toContainText('編集');
    await shot(page, testInfo, 'scenario-config-a-history');
    await b.context.close();
  });
});
