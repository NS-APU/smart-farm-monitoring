/**
 * シナリオ: ヘッダーのユーザーメニュー（Issue #353）。ユーザーアイコン・ユーザー名・ロール（括弧内。管理者・一般）を 1 つのボタンにし、
 * 押すと、ユーザー名の変更・パスワードの変更・通知の設定・テーマ・ログアウトを開く。
 * - 表示: ユーザー名とロール。長いユーザー名（200 文字）は、広い幅では省略し（全文は、ツールチップ）、狭い幅（900px 以下）では、アイコンだけにする
 * - 個人に関する画面（通知の設定など）にいる間は、ユーザーのボタンが、現在の画面を示す
 * テーマの切り替えは、scenario-theme.ts。ユーザー名・パスワードの変更・ログアウトの操作は、UC-13・UC-14。
 *
 * 確認できないこと（E2E の限界）: 実機（スマートフォン）での、タップのしやすさ・見た目。
 */

import { expect, test, type Page } from '@playwright/test';
import { E2E_USER } from './support/e2e-user.ts';
import { GENERAL, addUser, goToUserMenu, openAs, openUserMenu, prepareApp } from './support/app.ts';
import { shot } from './support/viewpoint-scenarios.ts';

const LONG_NAME = 'あ'.repeat(200);

function userButton(page: Page) {
  return page.getByRole('banner').getByRole('button', { name: /^ログイン中のユーザー/ });
}

test.describe('ユーザーメニュー: 表示と項目', () => {
  test('管理者は「ユーザー名（管理者）」、一般は「ユーザー名（一般）」を示し、ボタンの名前にも含む', async ({
    page,
    request,
    browser,
  }) => {
    await prepareApp(request);
    await addUser(request, GENERAL);
    await openAs(page, '/');

    await expect(page.getByTestId('user-name')).toHaveText(E2E_USER.userName);
    await expect(page.getByTestId('user-role')).toHaveText('（管理者）');
    await expect(userButton(page)).toHaveAttribute(
      'aria-label',
      `ログイン中のユーザー: ${E2E_USER.userName}（管理者）`,
    );

    const other = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    try {
      const otherPage = await other.newPage();
      await openAs(otherPage, '/', GENERAL);
      await expect(otherPage.getByTestId('user-name')).toHaveText(GENERAL.userName);
      await expect(otherPage.getByTestId('user-role')).toHaveText('（一般）');
    } finally {
      await other.close();
    }
  });

  test('開くと、ユーザー名の変更・パスワードの変更・通知の設定・テーマ（3 項目）・ログアウトを、この順に示し、サイドメニューに「通知の設定」はない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openAs(page, '/');

    const menu = await openUserMenu(page);

    await expect(menu.getByRole('menuitem')).toHaveText([
      'ユーザー名の変更',
      'パスワードの変更',
      '通知の設定',
      'ログアウト',
    ]);
    await expect(menu.getByRole('menuitem', { name: '通知の設定' })).toHaveAttribute(
      'href',
      '/settings/push',
    );
    await expect(menu.getByRole('menuitemradio')).toHaveText([
      'システム（既定）',
      'ライト',
      'ダーク',
    ]);
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('navigation', { name: 'メニュー' }).getByRole('link', { name: '通知の設定' }),
    ).toHaveCount(0);
  });

  test('項目を選ぶと、その画面へ移り、メニューが閉じる。個人の設定の画面にいる間は、ユーザーのボタンが、現在の画面を示す', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openAs(page, '/');
    await expect(userButton(page)).not.toHaveAttribute('aria-current', 'page');

    await goToUserMenu(page, '通知の設定');

    await expect(page.getByRole('heading', { name: '通知の設定', level: 1 })).toBeVisible();
    await expect(page.getByRole('menu', { name: 'ユーザー' })).toHaveCount(0);
    await expect(userButton(page)).toHaveAttribute('aria-current', 'page');
    const menu = await openUserMenu(page);
    await expect(menu.getByRole('menuitem', { name: '通知の設定' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

for (const viewport of [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 720, iconOnly: false },
  { name: 'タブレット幅（768px）', width: 768, height: 1024, iconOnly: true },
  { name: 'スマートフォン幅（375px）', width: 375, height: 800, iconOnly: true },
]) {
  test(`長いユーザー名（200 文字）でも、ヘッダーが崩れない（${viewport.name}）。${viewport.iconOnly ? 'アイコンだけを示し、' : '省略して、'}全文は、ボタンの名前とツールチップにある`, async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    const longUser = { ...GENERAL, userId: 'e2e-long-name', userName: LONG_NAME };
    await addUser(request, longUser);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openAs(page, '/', longUser);

    const trigger = userButton(page);
    await expect(trigger).toHaveAttribute(
      'aria-label',
      `ログイン中のユーザー: ${LONG_NAME}（一般）`,
    );
    await expect(trigger).toHaveAttribute('title', `${LONG_NAME}（一般）`);
    const box = await trigger.boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    if (viewport.iconOnly) {
      // 狭い幅は、名前・ロールの文字を出さない（アイコンだけ。丸いボタン）
      await expect(page.getByTestId('user-name')).toBeHidden();
      expect(box?.width ?? 0).toBeLessThanOrEqual(44);
    } else {
      // 広い幅は、名前を省略する（文字があふれず、ボタンの幅は、上限の中）
      const name = page.getByTestId('user-name');
      await expect(name).toBeVisible();
      expect(await name.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      expect(box?.width ?? 0).toBeLessThanOrEqual(20 * 16 + 2);
      await expect(page.getByTestId('user-role')).toBeVisible();
    }

    // メニューは、ページの幅の中に収まる
    const menu = await openUserMenu(page);
    const menuBox = await menu.boundingBox();
    expect(menuBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    await page.keyboard.press('Escape');

    await shot(page, testInfo, `user-menu-long-${String(viewport.width)}`);
  });
}
