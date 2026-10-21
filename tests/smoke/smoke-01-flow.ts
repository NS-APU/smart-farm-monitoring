/**
 * スモークテスト（サーバーレス環境。Issue #79）: ログイン → ダッシュボードの表示 → 手動入力 → 通知の確認 → ログアウト。
 * 環境の主要な経路（CloudFront・API の Lambda・Cognito・DynamoDB）が、動くことを確かめる。各操作の時間も、記録する（許容時間は負荷テストと同じ）。
 *
 * 手動入力は、環境に書き込む。**終わりに、入力したデータを削除する**（論理削除。変更履歴には残る）。途中で失敗した場合は、
 * 入力済みデータ（SC-07）で、キーワード「スモークテスト」を検索して、削除する。
 * 入力するのは、合成の値（温度 23℃・湿度 60%。正常の範囲）だけ。
 */

import { expect, test, type Page } from '@playwright/test';
import { measure, trackApi, type ActionSteps } from '../stress/support/recorder.ts';
import { createObservedAtSource } from '../stress/support/observed-at.ts';
import type { LimitKey } from '../stress/support/limits.ts';
import {
  expectDashboardShown,
  fillLogin,
  loadingView,
  loginButton,
  mainArea,
  menuLink,
  openLogin,
} from './support/smoke-ui.ts';

const ENTRY_NOTE = 'スモークテスト（自動）。削除してよい';

test('ログイン → ダッシュボード → 手動入力 → 通知 → ログアウト', async ({ page }) => {
  trackApi(page);
  const m = (
    uc: string,
    action: string,
    screen: string,
    limit: LimitKey,
    steps: ActionSteps,
  ): Promise<unknown> => measure(page, { uc, action, screen, limit }, steps);
  const banner = page.getByRole('banner');
  const form = mainArea(page);

  // ログイン → ダッシュボード
  await m('UC-13', 'ログイン画面を開く', 'ログイン（SC-01）', 'screen', {
    act: () => openLogin(page),
    respond: () => expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible(),
  });
  await fillLogin(page);
  await m(
    'UC-13',
    'ユーザーID・パスワードを入力して「ログイン」を押す',
    'ログイン（SC-01）→ ダッシュボード（SC-02）',
    'dashboardInitial',
    {
      act: () => loginButton(page).click(),
      respond: () => expectDashboardShown(page),
    },
  );
  await m(
    'UC-01',
    'ダッシュボードを開く（画面の再読み込み）',
    'ダッシュボード（SC-02）',
    'dashboardInitial',
    {
      act: () => page.reload(),
      respond: () => expectDashboardShown(page),
    },
  );

  // 手動入力（保存 → 削除）
  await m('UC-06', 'メニューから「データ入力」を開く', 'データ入力（SC-06）', 'screen', {
    act: () => menuLink(page, 'データ入力').click(),
    respond: async () => {
      await expect(page.getByRole('heading', { name: 'データ入力', level: 1 })).toBeVisible();
      await expect(form.getByLabel('対象の設備')).toBeVisible();
    },
  });
  // 同じ設備・項目・計測日時の入力は、1つだけ（重複は 409）。実行のたびに、少し違う日時にする
  const observedAt = createObservedAtSource(Date.now(), 20 + Math.floor(Math.random() * 280));
  await form.getByLabel('対象の設備').selectOption('SENSOR-01');
  await form.getByLabel('カテゴリ').selectOption('ENVIRONMENT');
  await form.getByLabel('計測日時（日本時間）').fill(observedAt());
  await form.getByTestId('entry-items').getByLabel('温度').fill('23');
  await form.getByTestId('entry-items').getByLabel('湿度').fill('60');
  await form.getByLabel('備考（所感・補足情報）').fill(ENTRY_NOTE);
  // 保存できたか（保存の応答の確認の中で、立てる）。失敗したときに、削除の手順を、飛ばすため
  const entry = { saved: false };
  try {
    await m(
      'UC-07',
      '環境の値（温度・湿度）を入力して「保存する」を押す',
      'データ入力（SC-06）',
      'operation',
      {
        act: () => form.getByRole('button', { name: '保存する' }).click(),
        respond: async () => {
          await expect(page.getByTestId('entry-result')).toContainText('保存しました');
          await expect(page.getByTestId('related-environmentalAdaptability')).toBeVisible();
          entry.saved = true;
        },
      },
    );

    // 通知
    await m('UC-05', 'メニューから「通知」を開く', '通知（SC-05）', 'screen', {
      act: () => menuLink(page, '通知').click(),
      respond: async () => {
        await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
        await expect(loadingView(page)).toHaveCount(0);
      },
    });
  } finally {
    if (entry.saved) {
      await deleteSmokeEntry(page, m);
    }
  }

  // ログアウト
  await m('UC-13', 'ヘッダーの「ログアウト」を押す', 'ログイン（SC-01）', 'screen', {
    act: () => banner.getByRole('button', { name: 'ログアウト' }).click(),
    respond: () => expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible(),
  });
  await page.goto('/notifications');
  await expect(page).toHaveURL(/\/login\?next=%2Fnotifications$/);
});

/** 入力済みデータ（SC-07）で、キーワードで絞り込み、スモークテストの入力を、削除する。 */
async function deleteSmokeEntry(
  page: Page,
  m: (
    uc: string,
    action: string,
    screen: string,
    limit: LimitKey,
    steps: ActionSteps,
  ) => Promise<unknown>,
): Promise<void> {
  const rows = page.getByTestId('entry-row');
  await m(
    'UC-18',
    '「入力済みデータの一覧」を開き、「スモークテスト」で検索する',
    '入力済みデータ（SC-07）',
    'screen',
    {
      act: async () => {
        await menuLink(page, 'データ入力').click();
        await page.getByRole('link', { name: '入力済みデータの一覧へ' }).click();
        await page.getByLabel('キーワード').fill('スモークテスト');
      },
      respond: async () => {
        await expect(page.getByRole('heading', { name: '入力済みデータ', level: 1 })).toBeVisible();
        await expect(loadingView(page)).toHaveCount(0);
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText('スモークテスト');
      },
    },
  );
  await m('UC-18', '入力の「削除」を押し、確認で削除する', '入力済みデータ（SC-07）', 'operation', {
    act: async () => {
      await rows.first().getByRole('button', { name: '削除' }).click();
      await page
        .getByTestId('confirm-dialog')
        .getByRole('button', { name: '削除', exact: true })
        .click();
    },
    respond: async () => {
      await expect(page.getByTestId('entries-notice')).toHaveText('削除しました');
      await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    },
  });
}
