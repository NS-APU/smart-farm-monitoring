/**
 * シナリオ: 手動入力のデータが、別の利用者に共有され、修正・削除が、全員の画面に反映される（複数の利用者。利用者A・Bのブラウザを切り替える）。
 *
 * 通るユースケース（use-cases.md）:
 *   UC-07 Aが、センサーの値を手動で補完（異常な温度） → UC-10 異常の通知 → UC-22 Bが、通知を確認 → UC-20 Bが、取り込み済みデータの一覧で、手動入力として閲覧
 *   → UC-02・UC-04 Bが、診断・根拠（手動入力のデータ）・推奨アクションを確認 → UC-18 Bが、Aの入力を修正（正しい値へ）
 *   → UC-01 Aが、ダッシュボードで改善を確認 → UC-20 Aが、一覧で修正後の値を確認 → UC-18 Aが、変更履歴で、登録（A）・編集（B）を確認
 *   → UC-18 Aが、入力を削除 → UC-20・UC-01 Bの一覧・ダッシュボードから消え、観点は不明になる → UC-18 Bが、履歴で削除を確認
 *
 * 各ユースケースの値の同値分割は、UC-NN-*.ts が担う。ここでは、ユースケースの連なりと、利用者をまたぐ影響を確かめる。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  SENSOR_ID,
  USER_B,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  confirmDialog,
  goToMenu,
  newUserSession,
  openAs,
  prepareApp,
  unreadBadge,
} from './support/app.ts';
import { fillEntryForm, saveEntry } from './support/entry.ts';
import { shot } from './support/viewpoint-scenarios.ts';
import { userIdText } from './support/pages.ts';

const notificationRows = (page: Page) => page.getByTestId('notification-row');
const observationRows = (page: Page) => page.getByTestId('observation-row');
const entryRows = (page: Page) => page.getByTestId('entry-row');
const auditRows = (page: Page) => page.getByTestId('audit-row');
const environmentBadge = (page: Page) =>
  page.getByTestId('card-environmentalAdaptability').locator('.status-badge');

test.describe('シナリオ: 手動入力のデータの共有・修正・削除（UC-07 → UC-10 → UC-22 → UC-20 → UC-02・04 → UC-18 → UC-01 → UC-20 → UC-18）', () => {
  test('Aが入力した異常な値を、Bが通知・一覧・診断で確認して修正し、Aが改善と履歴を確認する。Aが削除すると、Bの画面からも消え、観点は不明になる', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await alignBrowserClock(page);

    // UC-07 → UC-10: 利用者Aが、センサーの値を手動で補完する（温度 40℃ = 異常）
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

    // UC-22: 利用者Bが、ログインして、未読の通知を確認する
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/', USER_B);
    await expect(unreadBadge(b.page)).not.toHaveText('0');
    const unreadForB = Number(await unreadBadge(b.page).textContent());
    await goToMenu(b.page, '通知');
    const alert = notificationRows(b.page)
      .filter({ hasText: '環境適応性' })
      .filter({ hasText: 'ハウス1' });
    await expect(alert).toContainText('異常');
    await expect(alert).toHaveAttribute('data-read-state', 'UNREAD');

    // UC-20: Bが、取り込み済みデータの一覧で、Aの入力を、手動入力として閲覧する
    await goToMenu(b.page, '取り込み済みデータ');
    await expect(observationRows(b.page)).toHaveCount(4);
    const temperature = observationRows(b.page).filter({ hasText: '温度' });
    await expect(temperature).toContainText('40℃');
    await expect(temperature).toContainText('手動入力');
    await expect(temperature).toContainText('環境センサー1');
    await shot(b.page, testInfo, 'scenario-entry-b-observations');

    // UC-02・UC-04: Bが、通知から、診断・根拠のデータ（手動入力）・推奨アクションを確認する。確認した通知は、Bの既読になる
    await goToMenu(b.page, '通知');
    await alert.getByRole('link', { name: '詳細を確認' }).click();
    await expect(b.page.getByTestId('diagnostic-message')).toContainText('温度 40.0℃（異常）');
    await expect(b.page.getByTestId('source-data')).toContainText('手動入力');
    await expect(b.page.getByTestId('recommended-action')).toContainText('対応が必要な状態です');
    await expect(unreadBadge(b.page)).toHaveText(String(unreadForB - 1));
    await shot(b.page, testInfo, 'scenario-entry-b-detail');

    // UC-18: Bが、入力済みデータの一覧で、Aの入力を、正しい値（22℃）へ修正する（入力者は、Aのまま）
    await advanceMinutes(request, 1);
    await b.page.goto('/data-entry/list');
    await expect(entryRows(b.page)).toHaveCount(1);
    await expect(entryRows(b.page).first()).toContainText(userIdText('e2e-user'));
    await entryRows(b.page).first().getByRole('button', { name: '修正' }).click();
    const editor = b.page.getByTestId('entry-edit');
    await fillEntryForm(
      b.page,
      { items: { 温度: '22' }, note: 'Bが再確認し、22℃に訂正した' },
      editor,
    );
    await shot(b.page, testInfo, 'scenario-entry-b-edit');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(b.page.getByTestId('entries-notice')).toHaveText('修正しました');
    await b.page.goto('/');
    await expect(environmentBadge(b.page)).toContainText('正常');

    // UC-01: Aが、ダッシュボードで、状態の改善（異常 → 正常）を確認する
    await page.goto('/');
    await expect(environmentBadge(page)).toContainText('正常');
    await expect(page.getByTestId('card-environmentalAdaptability')).toContainText(
      '推奨アクション: 現在の状態を維持し',
    );

    // UC-20: Aが、一覧で、修正後の値を確認する（値は1件のまま。元の値は残らない）
    await goToMenu(page, '取り込み済みデータ');
    await expect(observationRows(page)).toHaveCount(4);
    await expect(observationRows(page).filter({ hasText: '温度' })).toContainText('22℃');
    await expect(observationRows(page).filter({ hasText: '温度' })).not.toContainText('40℃');

    // UC-18: Aが、入力済みデータの一覧・変更履歴で、Bによる修正を確認する
    await page.goto('/data-entry/list');
    await expect(entryRows(page).first()).toContainText('Bが再確認し、22℃に訂正した');
    await expect(entryRows(page).first()).not.toContainText('e2e-user-b');
    await page.goto('/data-entry/history?targetType=manual-entry');
    await expect(auditRows(page)).toHaveCount(2);
    await expect(auditRows(page).nth(0)).toContainText('編集');
    await expect(auditRows(page).nth(0)).toContainText('e2e-user-b');
    await expect(auditRows(page).nth(1)).toContainText('登録');
    await shot(page, testInfo, 'scenario-entry-a-history');

    // UC-18: Aが、入力を削除する（確認を求める。論理削除）
    await advanceMinutes(request, 1);
    await page.goto('/data-entry/list');
    await entryRows(page).first().getByRole('button', { name: '削除' }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('入力データを削除しますか');
    await confirmDialog(page, '削除');
    await expect(page.getByTestId('entries-notice')).toHaveText('削除しました');
    await expect(entryRows(page)).toHaveCount(0);

    // UC-20・UC-01: Bの一覧・ダッシュボードからも消え、観点は、データなしの「不明」になる
    await b.page.goto('/observations');
    await expect(observationRows(b.page)).toHaveCount(0);
    await expect(b.page.getByTestId('observations-empty')).toBeVisible();
    await b.page.goto('/');
    await expect(environmentBadge(b.page)).toContainText('不明');
    await shot(b.page, testInfo, 'scenario-entry-b-after-delete');

    // UC-18: Bが、変更履歴で、削除（A）・編集（B）・登録（A）の3件を確認する
    await b.page.goto('/data-entry/history?targetType=manual-entry');
    await expect(auditRows(b.page)).toHaveCount(3);
    await expect(auditRows(b.page).nth(0)).toContainText('削除');
    await expect(auditRows(b.page).nth(0)).toContainText(userIdText('e2e-user'));
    await expect(auditRows(b.page).nth(1)).toContainText('編集');
    await expect(auditRows(b.page).nth(2)).toContainText('登録');

    // UC-22: Aの通知の既読は、Bの既読とは独立（Bが確認した通知も、Aには未読のまま）
    await page.goto('/notifications');
    await expect(
      notificationRows(page).filter({ hasText: '環境適応性' }).filter({ hasText: 'ハウス1' }),
    ).toHaveAttribute('data-read-state', 'UNREAD');
    await b.context.close();
  });
});
