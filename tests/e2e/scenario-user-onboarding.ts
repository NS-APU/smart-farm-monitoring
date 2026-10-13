/**
 * シナリオ: 新しい利用者の受け入れから、権限の変更・削除まで（複数の利用者。利用者A・Bのブラウザを切り替える）。
 *
 * 通るユースケース（use-cases.md）:
 *   UC-13 ログイン → UC-14 利用者Bを登録 → UC-13 Bがログイン → UC-12 Bが構成を登録 → UC-01 Aが、Bの登録した構成をダッシュボードで確認
 *   → UC-14 最終ログイン日時の確認 → UC-14 Bのロールを閲覧者へ変更 → UC-13 Bがログインし直す → UC-12 Bは参照のみ
 *   → UC-14 Bを削除 → UC-13 Bの画面はログイン画面へ戻り、再ログインできない → UC-13 Aがログアウト
 *
 * 各ユースケースの値の同値分割は、UC-NN-*.ts が担う。ここでは、ユースケースの連なりと、利用者をまたぐ影響を確かめる。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  USER_B,
  alignBrowserClock,
  confirmDialog,
  goToMenu,
  newUserSession,
  openAs,
  prepareApp,
} from './support/app.ts';
import { loginViaUi } from './support/helpers.ts';
import { shot } from './support/viewpoint-scenarios.ts';

const userRow = (page: Page, userId: string) =>
  page.locator(`[data-testid="user-row"][data-user-id="${userId}"]`);
const equipmentRows = (page: Page) => page.getByTestId('equipment-row');
const facilityForm = (page: Page) => page.getByRole('form', { name: 'ハウスを登録' });
const childForm = (page: Page) => page.getByRole('form', { name: 'ロボット・環境センサーを登録' });

test.describe('シナリオ: 新しい利用者の受け入れから、権限の変更・削除まで（UC-13 → UC-14 → UC-12 → UC-01 → UC-14 → UC-13 → UC-12 → UC-14 → UC-13）', () => {
  test('Aが利用者Bを登録し、Bが構成を登録し、Aがそれを確認する。Aが、Bを閲覧者へ変更すると、Bは参照のみになり、Bを削除すると、Bの画面はログイン画面へ戻り、再ログインできない', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request, { equipment: false });
    await alignBrowserClock(page);

    // UC-13: 利用者A（初期のユーザー）がログインする
    await openAs(page, '/');
    await expect(page.getByText('設備が登録されていません。設備を登録してください')).toBeVisible();

    // UC-14: Aが、利用者B（農作業者）を登録する。まだログインしていないので「未ログイン」
    await goToMenu(page, 'ユーザー');
    const addForm = page.getByTestId('user-add');
    await addForm.getByLabel('ユーザーID').fill(USER_B.userId);
    await addForm.getByLabel('ユーザー名').fill(USER_B.userName);
    await addForm.getByLabel('パスワード').fill(USER_B.password);
    await addForm.getByLabel('ロール').selectOption('worker');
    await addForm.getByRole('button', { name: '登録する' }).click();
    await expect(page.getByTestId('users-notice')).toHaveText('登録しました');
    await expect(userRow(page, USER_B.userId)).toContainText('農作業者');
    await expect(userRow(page, USER_B.userId)).toContainText('未ログイン');
    await shot(page, testInfo, 'scenario-onboarding-a-registered');

    // UC-13: 利用者Bが、登録されたユーザーIDとパスワードでログインする（別のブラウザ）
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/', USER_B);
    await expect(b.page.getByText(USER_B.userName, { exact: true })).toBeVisible();
    await expect(
      b.page.getByText('設備が登録されていません。設備を登録してください'),
    ).toBeVisible();

    // UC-12: Bが、ハウスとロボットを登録する
    await goToMenu(b.page, '設備');
    await facilityForm(b.page).getByLabel('設備ID').fill('HOUSE-N');
    await facilityForm(b.page).getByLabel('名称').fill('B新設ハウス');
    await facilityForm(b.page).getByRole('button', { name: '登録する' }).click();
    await expect(b.page.getByTestId('equipment-notice')).toHaveText('登録しました');
    await childForm(b.page).getByLabel('種別').selectOption('ROBOT');
    await childForm(b.page).getByLabel('親のハウス').selectOption('HOUSE-N');
    await childForm(b.page).getByLabel('設備ID').fill('ROBOT-N');
    await childForm(b.page).getByLabel('名称').fill('B新設ロボット');
    await childForm(b.page).getByLabel('データ上の識別子').fill('ROBOT-NEW-01');
    await childForm(b.page).getByRole('button', { name: '登録する' }).click();
    await expect(equipmentRows(b.page)).toHaveCount(2);
    await shot(b.page, testInfo, 'scenario-onboarding-b-equipment');

    // UC-01: Aが、Bの登録した構成を、ダッシュボードで確認する（ハウスは10観点、ロボットは7観点）
    await page.goto('/');
    await expect(page.locator('.page-meta')).toContainText('対象: B新設ハウス');
    await expect(page.locator('.viewpoint-card')).toHaveCount(10);
    await page.getByRole('banner').getByLabel('対象の設備').selectOption('ROBOT-N');
    await expect(page.locator('.viewpoint-card')).toHaveCount(7);
    await expect(page.locator('.page-meta')).toContainText('対象: B新設ロボット');

    // UC-14: Aが、Bの最終ログイン日時を確認する
    await goToMenu(page, 'ユーザー');
    await expect(userRow(page, USER_B.userId)).not.toContainText('未ログイン');
    await expect(userRow(page, USER_B.userId)).toContainText('2026/10/09 12:00:00');

    // UC-14: Aが、Bのロールを、閲覧者へ変更する
    await userRow(page, USER_B.userId).getByRole('button', { name: '修正' }).click();
    await page.getByTestId('user-edit').getByLabel('ロール').selectOption('viewer');
    await page.getByTestId('user-edit').getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('users-notice')).toHaveText('修正しました');
    await expect(userRow(page, USER_B.userId)).toContainText('閲覧者');

    // UC-13: Bが、ログアウトして、ログインし直す → UC-12: 構成は参照のみ（権限は、ログインのたびに反映される）
    await b.page.getByRole('button', { name: 'ログアウト' }).click();
    await expect(b.page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
    await loginViaUi(b.page, USER_B.password, USER_B.userId);
    await goToMenu(b.page, '設備');
    await expect(b.page.getByTestId('permission-notice')).toHaveText(
      '設備を変更する権限がありません。参照のみできます',
    );
    await expect(equipmentRows(b.page)).toHaveCount(2);
    await expect(facilityForm(b.page)).toHaveCount(0);
    await expect(b.page.getByRole('button', { name: '削除' })).toHaveCount(0);
    await expect(
      b.page.getByRole('navigation', { name: 'メニュー' }).getByRole('link', { name: 'ユーザー' }),
    ).toHaveCount(0);
    await shot(b.page, testInfo, 'scenario-onboarding-b-readonly');

    // UC-14: Aが、Bを削除する（確認を求める）
    await userRow(page, USER_B.userId).getByRole('button', { name: '削除' }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('ユーザーを削除しますか');
    await shot(page, testInfo, 'scenario-onboarding-a-confirm');
    await confirmDialog(page, '削除');
    await expect(page.getByTestId('users-notice')).toHaveText('削除しました');
    await expect(userRow(page, USER_B.userId)).toHaveCount(0);

    // UC-13: Bの画面は、次の操作（または更新）で、ログイン画面へ戻り、同じ認証情報では、ログインできない
    await goToMenu(b.page, 'ダッシュボード');
    await expect(b.page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible({
      timeout: 20_000,
    });
    await loginViaUi(b.page, USER_B.password, USER_B.userId);
    await expect(b.page.getByRole('alert')).toHaveText(
      'ユーザーIDまたはパスワードが正しくありません',
    );
    await shot(b.page, testInfo, 'scenario-onboarding-b-denied');
    await b.context.close();

    // UC-13: Aは、構成を登録した利用者がいなくなっても、構成を使い続けられ、ログアウトする
    await goToMenu(page, '設備');
    await expect(equipmentRows(page)).toHaveCount(2);
    await page.getByRole('button', { name: 'ログアウト' }).click();
    await expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
  });
});
