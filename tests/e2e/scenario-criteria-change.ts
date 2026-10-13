/**
 * シナリオ: 判断基準の変更が、評価・通知・推移・満足度の画面に反映され、既定値へ戻すと元に戻る（複数の利用者。利用者A・Bのブラウザを切り替える）。
 *
 * 通るユースケース（use-cases.md）:
 *   UC-01・UC-04 Bが、変更前のダッシュボード（注意・確認が望ましい）を確認 → UC-19 Aが、環境適応性と満足度の判断基準を緩める
 *   → UC-01・UC-04・UC-02 Bの画面が、正常・「現在の状態を維持」・変更済みの基準に変わる → UC-21 Bが、満足度の詳細で正常を確認
 *   → UC-03 Bが、ステータスの推移で、変更前（注意）→ 変更後（正常）を確認 → UC-19 Aが、環境適応性の基準を厳しくする
 *   → UC-10・UC-22・UC-05 異常の通知がBに届き、Bが詳細・推奨アクション（対応が必要）を確認 → UC-19 Aが、既定値へ戻す
 *   → UC-01・UC-02 Bの画面は、既定値の評価（注意）に戻り、満足度は変更済みのまま → UC-18 Aが、変更履歴で、4件の操作を確認
 *
 * 各ユースケースの値の同値分割は、UC-NN-*.ts が担う。ここでは、ユースケースの連なりと、利用者をまたぐ影響を確かめる。
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import {
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
import {
  environmentData,
  merge,
  satisfactionData,
  seed,
  shot,
} from './support/viewpoint-scenarios.ts';
import { dashboardCard as card, locatorOf, userIdText } from './support/pages.ts';

const criterion = (page: Page, indicator: string): Locator =>
  page.getByTestId(`criterion-edit-${indicator}`);
const saveButton = (page: Page): Locator => page.getByRole('button', { name: '保存する' });
const notice = locatorOf('criteria-notice');
const cautionCount = async (page: Page): Promise<number> =>
  Number(await page.getByTestId('summary-CAUTION').locator('.summary-count').textContent());

/** 観点の詳細から、判断基準の編集（SC-13）を開く。 */
async function openCriteria(page: Page, viewpointId: string): Promise<void> {
  await page.goto(`/viewpoints/${viewpointId}`);
  await page.getByRole('link', { name: '判断基準を編集' }).click();
  await expect(page.getByRole('heading', { name: /判断基準の編集/, level: 1 })).toBeVisible();
}

test.describe('シナリオ: 判断基準の変更の、評価・通知・推移・満足度への反映（UC-01・04 → UC-19 → UC-01・04・02 → UC-21 → UC-03 → UC-19 → UC-10・22・05 → UC-19 → UC-18）', () => {
  test('Aが判断基準を緩める・厳しくする・既定値へ戻すと、Bのダッシュボード・詳細・満足度・推移・通知が、そのたびに変わる。変更は、変更履歴に残る', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    // 温度 27℃（既定値では「注意」。正常は 25℃未満）、満足度 3.9（既定値では「注意」。正常は 4.0 以上）
    await seed(
      request,
      merge(environmentData({ temperature: 27 }), satisfactionData([4, 4, 4, 4, 4, 4, 4, 4, 3])),
    );
    await alignBrowserClock(page);
    await openAs(page, '/');

    // UC-01・UC-04: 利用者Bが、変更前のダッシュボードを確認する（環境適応性・満足度とも注意）
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/', USER_B);
    await expect(card(b.page, 'environmentalAdaptability').locator('.status-badge')).toContainText(
      '注意',
    );
    await expect(card(b.page, 'environmentalAdaptability')).toContainText(
      '推奨アクション: 確認が望ましい状態です',
    );
    await expect(card(b.page, 'satisfaction').locator('.status-badge')).toContainText('注意');
    const cautionBefore = await cautionCount(b.page);
    const unreadBefore = Number(await unreadBadge(b.page).textContent());
    await shot(b.page, testInfo, 'scenario-criteria-b-before');

    // UC-19: Aが、環境適応性（温度の正常上限 25℃ → 30℃）と満足度（注意下限 4.0 → 3.5）の判断基準を緩める
    await advanceMinutes(request, 1);
    await openCriteria(page, 'environmentalAdaptability');
    await criterion(page, 'temperatureCelsius').getByLabel('正常上限（未満で正常）').fill('30');
    await saveButton(page).click();
    await expect(notice(page)).toHaveText('保存しました。現在の評価を更新しました');
    await expect(page.getByTestId('criteria-state')).toContainText('版: CUSTOM-1');
    await shot(page, testInfo, 'scenario-criteria-a-saved');
    await page.goto('/viewpoints/satisfaction/criteria');
    await criterion(page, 'overallSatisfaction').getByLabel('注意下限（未満で注意）').fill('3.5');
    await saveButton(page).click();
    await expect(notice(page)).toBeVisible();

    // UC-01・UC-04・UC-02: Bの画面が、正常・「現在の状態を維持」・変更済みの基準に変わる（注意の件数は、2件減る）
    await b.page.reload();
    await expect(card(b.page, 'environmentalAdaptability').locator('.status-badge')).toContainText(
      '正常',
    );
    await expect(card(b.page, 'environmentalAdaptability')).toContainText(
      '推奨アクション: 現在の状態を維持し',
    );
    await expect(card(b.page, 'satisfaction').locator('.status-badge')).toContainText('正常');
    expect(await cautionCount(b.page)).toBe(cautionBefore - 2);
    await shot(b.page, testInfo, 'scenario-criteria-b-relaxed');
    await b.page.goto('/viewpoints/environmentalAdaptability');
    await expect(b.page.getByTestId('criteria-state')).toContainText('変更済み（版: CUSTOM-1）');
    await expect(b.page.getByTestId('diagnostic-message')).toContainText(
      'カスタムの判断基準による判定です',
    );

    // UC-21: Bが、満足度の詳細で、総合満足度 3.9 が正常になったことを確認する
    await b.page.goto('/satisfaction');
    await expect(b.page.getByTestId('overall-score')).toHaveText('3.9');
    await expect(b.page.locator('.overall .status-badge')).toContainText('正常');

    // UC-03: Bが、ステータスの推移で、変更前（注意）→ 変更後（正常）を確認する
    await b.page.goto('/viewpoints/environmentalAdaptability?equipmentId=SENSOR-01');
    await expect(b.page.getByTestId('status-history').locator('.status-segment')).toHaveText([
      '注意',
      '正常',
    ]);

    // UC-19: Aが、環境適応性の基準を厳しくする（温度の正常上限 20℃・異常上限 26℃。27℃は異常になる）
    await advanceMinutes(request, 1);
    await openCriteria(page, 'environmentalAdaptability');
    await criterion(page, 'temperatureCelsius').getByLabel('正常上限（未満で正常）').fill('20');
    await criterion(page, 'temperatureCelsius').getByLabel('異常上限（以上で異常）').fill('26');
    await saveButton(page).click();
    await expect(notice(page)).toBeVisible();
    await expect(page.getByTestId('criteria-state')).toContainText('版: CUSTOM-2');

    // UC-10・UC-22・UC-05: 異常の通知がBに届く。Bが、通知から、詳細・推奨アクションを確認する
    await b.page.goto('/notifications');
    await expect
      .poll(async () => Number(await unreadBadge(b.page).textContent()))
      .toBeGreaterThan(unreadBefore);
    const alert = b.page
      .getByTestId('notification-row')
      .filter({ hasText: '環境適応性' })
      .filter({ hasText: 'ハウス1' })
      .filter({ hasText: '【異常】' });
    await expect(alert).toHaveAttribute('data-read-state', 'UNREAD');
    await expect(alert).toContainText('カスタムの判断基準による判定です');
    await shot(b.page, testInfo, 'scenario-criteria-b-notification');
    await alert.getByRole('link', { name: '詳細を確認' }).click();
    await expect(b.page.getByTestId('recommended-action')).toContainText('対応が必要な状態です');
    await expect(
      b.page.getByTestId('diagnosis').locator('.diagnosis-head .status-badge'),
    ).toContainText('異常');

    // UC-19: Aが、環境適応性の基準を、既定値へ戻す（確認を求める）
    await advanceMinutes(request, 1);
    await openCriteria(page, 'environmentalAdaptability');
    await page.getByRole('button', { name: '既定値へ戻す' }).click();
    await confirmDialog(page, '既定値へ戻す');
    await expect(notice(page)).toHaveText('既定値へ戻しました');
    await expect(page.getByTestId('criteria-state')).toContainText('既定値');

    // UC-01・UC-02・UC-03: Bの環境適応性は、既定値の評価（注意）に戻る。満足度は、変更済みの基準のまま（正常）
    await b.page.goto('/');
    await expect(card(b.page, 'environmentalAdaptability').locator('.status-badge')).toContainText(
      '注意',
    );
    await expect(card(b.page, 'environmentalAdaptability')).not.toContainText('カスタムの判断基準');
    await expect(card(b.page, 'satisfaction').locator('.status-badge')).toContainText('正常');
    await expect(card(b.page, 'satisfaction')).toContainText('カスタムの判断基準');
    await b.page.goto('/viewpoints/environmentalAdaptability?equipmentId=SENSOR-01');
    await expect(b.page.getByTestId('status-history').locator('.status-segment')).toHaveText([
      '注意',
      '正常',
      '異常',
      '注意',
    ]);
    await shot(b.page, testInfo, 'scenario-criteria-b-reset');

    // UC-18: Aが、変更履歴で、4件の操作（編集3・既定値へ戻す1。どれも、操作種別は「編集」）を確認する
    await page.goto('/data-entry/history?targetType=criteria');
    await expect(page.getByTestId('audit-row')).toHaveCount(4);
    for (const row of await page.getByTestId('audit-row').all()) {
      await expect(row.locator('td').nth(1)).toHaveText('編集');
    }
    await expect(page.getByTestId('audit-row').first()).toContainText('environmentalAdaptability');
    await expect(page.getByTestId('audit-row').first()).toContainText(userIdText('e2e-user'));
    await goToMenu(page, 'ダッシュボード');
    await b.context.close();
  });
});
