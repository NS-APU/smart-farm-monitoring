/**
 * UC-14 ユーザーを管理する（SC-14。FR-9.4〜FR-9.6、NFR-5.1）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、ユーザーの一覧を開き、最終ログイン日時を確認する
 *               2. 農作業者が、ユーザーを登録・編集・削除する（ユーザーID、ユーザー名、パスワード、ロール）
 *               3. システムが、入力内容を検証して保存する
 *   代替フロー  同じユーザーIDを重複して登録しようとした場合は、エラーとする（FR-9.4 のユーザーIDは一意）
 *   事後条件    ユーザーの情報が保存されている
 *
 * 値の同値分割: ロール（農作業者＝全権限・閲覧者＝権限なし）、ユーザーID・ユーザー名の長さと文字種の境界、パスワード
 * （8文字以上で英大文字・英小文字・数字を含む。境界: 7文字・8文字、各文字種の欠け）、操作（登録・編集・削除・確認の取り消し・自分自身の削除）、
 * 利用者（操作する人・操作される人。別のブラウザ）、権限（管理できる・できない）。
 * 関連するユースケース: UC-13（登録したユーザーでログイン。削除・パスワード変更の反映）、UC-12・UC-17・UC-19（ロールによる権限）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  USER_B,
  VIEWER,
  accessToken,
  addUser,
  alignBrowserClock,
  confirmDialog,
  goToMenu,
  newUserSession,
  openAs,
  prepareApp,
} from './support/app.ts';
import { loginViaUi } from './support/helpers.ts';
import { E2E_USER } from './support/e2e-user.ts';
import { shot } from './support/viewpoint-scenarios.ts';
import { locatorOf, rowBy } from './support/pages.ts';

const rows = locatorOf('user-row');
const rowOf = rowBy('user-row', 'data-user-id');
const addForm = (page: Page) => page.getByTestId('user-add');
const editForm = (page: Page) => page.getByTestId('user-edit');
const notice = locatorOf('users-notice');

async function openUsers(page: Page, user?: Parameters<typeof openAs>[2]): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/', user);
  await goToMenu(page, 'ユーザー');
  await expect(page.getByRole('heading', { name: 'ユーザー', level: 1 })).toBeVisible();
}

async function register(
  page: Page,
  values: { userId: string; userName: string; password: string; role?: string },
): Promise<void> {
  const form = addForm(page);
  await form.getByLabel('ユーザーID').fill(values.userId);
  await form.getByLabel('ユーザー名').fill(values.userName);
  await form.getByLabel('パスワード').fill(values.password);
  if (values.role !== undefined) {
    await form.getByLabel('ロール').selectOption(values.role);
  }
  await form.getByRole('button', { name: '登録する' }).click();
}

/** 別のブラウザで、ユーザーとしてログインを試みる（成功なら、ダッシュボードを表示）。 */
async function tryLogin(page: Page, user: { userId: string; password: string }): Promise<void> {
  await page.goto('/login');
  await loginViaUi(page, user.password, user.userId);
}

test.describe('基本フロー: ユーザーの一覧を開き、登録・編集・削除する', () => {
  test('ユーザーの一覧に、ユーザーID・ユーザー名・ロール・最終ログイン日時を表示する。ログイン中のユーザーを示し、自分自身は削除できない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await openUsers(page);

    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByRole('columnheader').allTextContents()).resolves.toEqual([
      'ユーザーID',
      'ユーザー名',
      'ロール',
      '最終ログイン',
      '操作',
    ]);
    const me = rowOf(page, E2E_USER.userId);
    await expect(me).toContainText(E2E_USER.userName);
    await expect(me).toContainText('農作業者');
    await expect(me).toContainText('（ログイン中）');
    await expect(me).toContainText('2026/10/09 12:00:00');
    await expect(me.getByRole('button', { name: '削除' })).toBeDisabled();
    // ログインしていないユーザーは「未ログイン」
    await expect(rowOf(page, USER_B.userId)).toContainText('未ログイン');
    await expect(rowOf(page, USER_B.userId).getByRole('button', { name: '削除' })).toBeEnabled();
    await shot(page, testInfo, 'uc14-list');
  });

  test('登録: ユーザーID・ユーザー名・パスワード・ロールを入力して登録すると、一覧に追加され、登録したユーザーが、そのパスワードでログインできる', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await openUsers(page);

    await register(page, {
      userId: 'worker-new',
      userName: '新しい作業者',
      password: 'Abcdef12',
      role: 'worker',
    });

    await expect(notice(page)).toHaveText('登録しました');
    await expect(rowOf(page, 'worker-new')).toContainText('新しい作業者');
    await expect(rowOf(page, 'worker-new')).toContainText('農作業者');
    await expect(rowOf(page, 'worker-new')).toContainText('未ログイン');
    // 入力欄はクリアされる（パスワードを画面に残さない）
    await expect(addForm(page).getByLabel('パスワード')).toHaveValue('');
    // 登録したユーザーが、別のブラウザでログインできる（UC-13）
    const other = await newUserSession(browser, testInfo, 'new-user');
    await tryLogin(other.page, { userId: 'worker-new', password: 'Abcdef12' });
    await expect(other.page.getByText('新しい作業者', { exact: true })).toBeVisible();
    // 最終ログイン日時が記録される
    await page.reload();
    await expect(rowOf(page, 'worker-new')).not.toContainText('未ログイン');
    await other.context.close();
  });

  test('ロール「閲覧者」で登録したユーザーは、権限のない操作ができない（メニューのユーザー管理を表示しない）', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await openUsers(page);
    await register(page, {
      userId: 'viewer-new',
      userName: '閲覧の人',
      password: 'Abcdef12',
      role: 'viewer',
    });
    await expect(notice(page)).toHaveText('登録しました');
    await expect(rowOf(page, 'viewer-new')).toContainText('閲覧者');

    const other = await newUserSession(browser, testInfo, 'viewer');
    await tryLogin(other.page, { userId: 'viewer-new', password: 'Abcdef12' });

    await expect(other.page.getByRole('navigation', { name: 'メニュー' })).toBeVisible();
    await expect(
      other.page
        .getByRole('navigation', { name: 'メニュー' })
        .getByRole('link', { name: 'ユーザー' }),
    ).toHaveCount(0);
    await other.page.goto('/settings/users');
    await expect(other.page.getByTestId('permission-notice')).toHaveText(
      'ユーザーを管理する権限がありません',
    );
    await other.context.close();
  });

  test('編集: ユーザー名・ロールを変更できる。パスワードを入力しなければ、パスワードは変わらない。ユーザーIDは変更できない', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await openUsers(page);

    await rowOf(page, USER_B.userId).getByRole('button', { name: '修正' }).click();
    await expect(editForm(page).getByLabel('ユーザーID')).toHaveCount(0);
    await editForm(page).getByLabel('ユーザー名').fill('利用者B（改）');
    await editForm(page).getByLabel('ロール').selectOption('viewer');
    await editForm(page).getByRole('button', { name: '保存' }).click();

    await expect(notice(page)).toHaveText('修正しました');
    await expect(rowOf(page, USER_B.userId)).toContainText('利用者B（改）');
    await expect(rowOf(page, USER_B.userId)).toContainText('閲覧者');
    // パスワードは変えていない → 元のパスワードでログインできる
    const other = await newUserSession(browser, testInfo, 'user-b');
    await tryLogin(other.page, USER_B);
    await expect(other.page.getByText('利用者B（改）', { exact: true })).toBeVisible();
    await other.context.close();
  });

  test('パスワードを変更すると、古いパスワードではログインできず、新しいパスワードでログインできる', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await openUsers(page);

    await rowOf(page, USER_B.userId).getByRole('button', { name: '修正' }).click();
    await editForm(page).getByLabel('パスワード').fill('Changed-Pw1');
    await editForm(page).getByRole('button', { name: '保存' }).click();
    await expect(notice(page)).toHaveText('修正しました');

    const other = await newUserSession(browser, testInfo, 'user-b');
    await tryLogin(other.page, USER_B);
    await expect(other.page.getByRole('alert')).toHaveText(
      'ユーザーIDまたはパスワードが正しくありません',
    );
    await tryLogin(other.page, { userId: USER_B.userId, password: 'Changed-Pw1' });
    await expect(other.page.getByRole('banner')).toBeVisible();
    await other.context.close();
  });

  test('削除: 確認を求め、削除すると、一覧から外れ、そのユーザーはログインできない。確認でキャンセルすると、削除しない', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await openUsers(page);

    await rowOf(page, USER_B.userId).getByRole('button', { name: '削除' }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('ユーザーを削除しますか');
    await shot(page, testInfo, 'uc14-confirm');
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'キャンセル' }).click();
    await expect(rowOf(page, USER_B.userId)).toHaveCount(1);
    await rowOf(page, USER_B.userId).getByRole('button', { name: '削除' }).click();
    await confirmDialog(page, '削除');

    await expect(notice(page)).toHaveText('削除しました');
    await expect(rowOf(page, USER_B.userId)).toHaveCount(0);
    const other = await newUserSession(browser, testInfo, 'user-b');
    await tryLogin(other.page, USER_B);
    await expect(other.page.getByRole('alert')).toHaveText(
      'ユーザーIDまたはパスワードが正しくありません',
    );
    await other.context.close();
  });

  test('ログイン中のユーザーを削除すると、そのユーザーは、次の操作から使えなくなり、ログイン画面へ戻る', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    const other = await newUserSession(browser, testInfo, 'user-b');
    await openAs(other.page, '/', USER_B);
    await openUsers(page);

    await rowOf(page, USER_B.userId).getByRole('button', { name: '削除' }).click();
    await confirmDialog(page, '削除');
    await expect(notice(page)).toHaveText('削除しました');

    // 削除されたユーザーの画面は、次の更新（約10秒）または操作で、ログイン画面へ戻る
    await goToMenu(other.page, '通知');
    await expect(other.page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible({
      timeout: 20_000,
    });
    await other.context.close();
  });
});

test.describe('代替フロー: 同じユーザーIDを重複して登録しようとした場合は、エラーとする', () => {
  test('登録済みのユーザーIDは、重複としてエラーにする', async ({ page, request }) => {
    await prepareApp(request);
    await openUsers(page);

    await register(page, {
      userId: E2E_USER.userId,
      userName: '重複',
      password: 'Abcdef12',
      role: 'worker',
    });

    await expect(addForm(page).locator('[data-field="userId"] .field-error')).toHaveText(
      '同じユーザーIDがすでに登録されています',
    );
    await expect(rows(page)).toHaveCount(1);
  });
});

test.describe('入力の検証（ユーザーID・ユーザー名・パスワード・ロール）', () => {
  const invalidIds: readonly { name: string; value: string; message: string }[] = [
    { name: '空', value: '', message: 'ユーザーIDは必須です' },
    {
      name: '空白を含む',
      value: 'user a',
      message: '英数字・ハイフン・アンダースコアのみ使えます（先頭は英数字）',
    },
    {
      name: '日本語',
      value: 'ユーザー',
      message: '英数字・ハイフン・アンダースコアのみ使えます（先頭は英数字）',
    },
    {
      name: '101文字（境界の外）',
      value: `u${'a'.repeat(100)}`,
      message: 'ユーザーIDは100文字以内で指定してください',
    },
  ];

  for (const item of invalidIds) {
    test(`ユーザーIDが${item.name}: エラーを表示し、登録しない`, async ({ page, request }) => {
      await prepareApp(request);
      await openUsers(page);

      await register(page, { userId: item.value, userName: '名前', password: 'Abcdef12' });

      await expect(addForm(page).locator('[data-field="userId"] .field-error')).toHaveText(
        item.message,
      );
      await expect(rows(page)).toHaveCount(1);
    });
  }

  const invalidNames: readonly { name: string; value: string; message: string }[] = [
    { name: '空', value: '', message: 'ユーザー名は必須です' },
    { name: '空白のみ', value: '   ', message: 'ユーザー名は必須です' },
    {
      name: '201文字（境界の外）',
      value: 'あ'.repeat(201),
      message: 'ユーザー名は200文字以内で指定してください',
    },
  ];

  for (const item of invalidNames) {
    test(`ユーザー名が${item.name}: エラーを表示し、登録しない`, async ({ page, request }) => {
      await prepareApp(request);
      await openUsers(page);

      await register(page, { userId: 'user-x', userName: item.value, password: 'Abcdef12' });

      await expect(addForm(page).locator('[data-field="userName"] .field-error')).toHaveText(
        item.message,
      );
    });
  }

  const passwords: readonly { name: string; value: string; ok: boolean; message?: string }[] = [
    {
      name: '7文字（境界の外）',
      value: 'Abcdef1',
      ok: false,
      message: 'パスワードは8文字以上で指定してください',
    },
    { name: '8文字（境界）', value: 'Abcdef12', ok: true },
    {
      name: '数字がない',
      value: 'Abcdefgh',
      ok: false,
      message: 'パスワードは英大文字・英小文字・数字を含めてください',
    },
    {
      name: '英大文字がない',
      value: 'abcdefg1',
      ok: false,
      message: 'パスワードは英大文字・英小文字・数字を含めてください',
    },
    {
      name: '英小文字がない',
      value: 'ABCDEFG1',
      ok: false,
      message: 'パスワードは英大文字・英小文字・数字を含めてください',
    },
    { name: '空', value: '', ok: false, message: 'パスワードは8文字以上で指定してください' },
    { name: '記号を含む長いパスワード', value: 'Abc-def_12345!?', ok: true },
  ];

  for (const item of passwords) {
    test(`パスワードが${item.name}: ${item.ok ? '登録できる' : 'エラーを表示し、登録しない'}`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await openUsers(page);

      await register(page, { userId: 'user-pw', userName: '名前', password: item.value });

      if (item.ok) {
        await expect(notice(page)).toHaveText('登録しました');
      } else {
        await expect(addForm(page).locator('[data-field="password"] .field-error')).toHaveText(
          item.message ?? '',
        );
        await expect(rows(page)).toHaveCount(1);
      }
    });
  }

  test('ロールが未選択ならエラー。ロールの選択肢は、定義済みのもの（農作業者・閲覧者）のみ', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openUsers(page);
    await expect(addForm(page).getByLabel('ロール').locator('option')).toHaveText([
      'ロールを選択してください',
      '農作業者',
      '閲覧者',
    ]);

    await register(page, { userId: 'user-r', userName: '名前', password: 'Abcdef12', role: '' });

    await expect(addForm(page).locator('[data-field="role"] .field-error')).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
  });

  test('編集で、パスワードを変更する場合に条件を満たさなければエラー（空のままなら、変更しない）', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await openUsers(page);
    await rowOf(page, USER_B.userId).getByRole('button', { name: '修正' }).click();
    await editForm(page).getByLabel('パスワード').fill('short');

    await editForm(page).getByRole('button', { name: '保存' }).click();
    await expect(editForm(page).locator('[data-field="password"] .field-error')).toBeVisible();
    await editForm(page).getByLabel('パスワード').fill('');
    await editForm(page).getByRole('button', { name: '保存' }).click();

    await expect(notice(page)).toHaveText('修正しました');
    // 空のままなら、パスワードは変わらない → 元のパスワードでログインできる
    const other = await newUserSession(browser, testInfo, 'user-b');
    await tryLogin(other.page, USER_B);
    await expect(other.page.getByText(USER_B.userName, { exact: true })).toBeVisible();
    await other.context.close();
  });

  test('エラーを直して、もう一度登録できる', async ({ page, request }) => {
    await prepareApp(request);
    await openUsers(page);
    await register(page, { userId: 'user-ok', userName: '名前', password: 'short' });
    await expect(addForm(page).locator('[data-field="password"] .field-error')).toBeVisible();

    await addForm(page).getByLabel('パスワード').fill('Abcdef12');
    await addForm(page).getByRole('button', { name: '登録する' }).click();

    await expect(notice(page)).toHaveText('登録しました');
    await expect(addForm(page).locator('.field-error')).toHaveCount(0);
  });
});

test.describe('権限: ユーザーを管理する権限のない利用者（閲覧者）は、管理できない', () => {
  test('閲覧者には、メニューにユーザー管理を表示せず、直接開いても、権限がない旨を表示する。サーバー側でも拒否する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, VIEWER);
    await alignBrowserClock(page);
    await openAs(page, '/', VIEWER);
    await expect(
      page.getByRole('navigation', { name: 'メニュー' }).getByRole('link', { name: 'ユーザー' }),
    ).toHaveCount(0);

    await page.goto('/settings/users');

    await expect(page.getByTestId('permission-notice')).toHaveText(
      'ユーザーを管理する権限がありません',
    );
    await expect(rows(page)).toHaveCount(0);
    await expect(addForm(page)).toHaveCount(0);
    await shot(page, testInfo, 'uc14-forbidden');
    const login = await request.post('/api/v1/auth/login', {
      data: { userId: VIEWER.userId, password: VIEWER.password },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const denied = await request.fetch('/api/v1/users', {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(denied.status()).toBe(403);
  });
});

test.describe('事後条件: ユーザーの情報が保存されている（画面を読み直しても残る）', () => {
  test('登録・編集・削除の結果は、画面を読み直しても残り、エラー・登録・編集中の画面を撮影する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await addUser(request, VIEWER);
    await openUsers(page);

    // 登録（入力の誤りを直して登録する。エラー表示の画面を撮影する）
    await register(page, { userId: 'saved-user', userName: '保存の確認', password: 'short' });
    await expect(addForm(page).locator('[data-field="password"] .field-error')).toBeVisible();
    await shot(page, testInfo, 'uc14-validation-error');
    await addForm(page).getByLabel('パスワード').fill('Abcdef12');
    await addForm(page).getByLabel('ロール').selectOption('viewer');
    await addForm(page).getByRole('button', { name: '登録する' }).click();
    await expect(notice(page)).toHaveText('登録しました');
    await shot(page, testInfo, 'uc14-registered');

    // 編集（編集中の画面を撮影する）
    await rowOf(page, USER_B.userId).getByRole('button', { name: '修正' }).click();
    await expect(editForm(page)).toBeVisible();
    await expect(editForm(page).getByLabel('ユーザー名')).toHaveValue(USER_B.userName);
    await expect(editForm(page).getByLabel('パスワード')).toHaveValue('');
    await expect(editForm(page).getByLabel('ロール')).toHaveValue('worker');
    await shot(page, testInfo, 'uc14-edit');
    await editForm(page).getByLabel('ユーザー名').fill('保存された名前');
    await editForm(page).getByRole('button', { name: '保存' }).click();
    await expect(notice(page)).toHaveText('修正しました');
    await expect(editForm(page)).toHaveCount(0);

    // 削除
    await rowOf(page, VIEWER.userId).getByRole('button', { name: '削除' }).click();
    await confirmDialog(page, '削除');
    await expect(notice(page)).toHaveText('削除しました');

    // 読み直しても、結果が残る（3人: 本人・B・登録したユーザー。削除したユーザーはいない）
    await page.reload();
    await expect(rows(page)).toHaveCount(3);
    await expect(rowOf(page, 'saved-user')).toContainText('保存の確認');
    await expect(rowOf(page, 'saved-user')).toContainText('閲覧者');
    await expect(rowOf(page, USER_B.userId)).toContainText('保存された名前');
    await expect(rowOf(page, VIEWER.userId)).toHaveCount(0);
  });

  test('ログイン中のユーザー自身の名前は変更できるが、自分自身は削除できない（画面でも、サーバー側でも）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openUsers(page);

    await rowOf(page, E2E_USER.userId).getByRole('button', { name: '修正' }).click();
    await editForm(page).getByLabel('ユーザー名').fill('名前を変えた本人');
    await editForm(page).getByRole('button', { name: '保存' }).click();

    await expect(notice(page)).toHaveText('修正しました');
    await expect(rowOf(page, E2E_USER.userId)).toContainText('名前を変えた本人');
    await expect(rowOf(page, E2E_USER.userId)).toContainText('（ログイン中）');
    await expect(rowOf(page, E2E_USER.userId).getByRole('button', { name: '削除' })).toBeDisabled();
    const token = await accessToken(request);
    const denied = await request.fetch(`/api/v1/users/${E2E_USER.userId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(denied.status()).toBe(409);
    await page.reload();
    await expect(rowOf(page, E2E_USER.userId)).toHaveCount(1);
  });

  test('ロールを閲覧者へ変更すると、そのユーザーがログイン中でも、次のリクエストから、ユーザー管理を拒否する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    const token = await accessToken(request, USER_B);
    const listUsersAs = () =>
      request.fetch('/api/v1/users', { headers: { authorization: `Bearer ${token}` } });
    expect((await listUsersAs()).status()).toBe(200);
    await openUsers(page);

    await rowOf(page, USER_B.userId).getByRole('button', { name: '修正' }).click();
    await editForm(page).getByLabel('ロール').selectOption('viewer');
    await editForm(page).getByRole('button', { name: '保存' }).click();
    await expect(notice(page)).toHaveText('修正しました');

    expect((await listUsersAs()).status()).toBe(403);
  });
});

test.describe('スマートフォン幅（375px）でも、ユーザー管理は、横にはみ出さず、操作できる', () => {
  test('一覧・登録の画面が、画面の幅に収まり、登録できる', async ({ page, request }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await page.setViewportSize({ width: 375, height: 667 });
    await openUsers(page);

    await expect(rows(page)).toHaveCount(2);
    await shot(page, testInfo, 'uc14-list-narrow');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    // 表の列が、1文字ずつ折り返すほど、押しつぶされない
    const headerHeights = await page
      .getByRole('columnheader')
      .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().height));
    expect(Math.max(...headerHeights)).toBeLessThan(48);
    // 狭い幅（900px 以下）では、1 行が 1 枚のカードになり、修正・削除のボタンが、横にスクロールせずに、画面の幅の中に見える
    for (const name of ['修正', '削除']) {
      const box = await rows(page).first().getByRole('button', { name }).boundingBox();
      expect(box?.x ?? -1, `${name}ボタンの左端`).toBeGreaterThanOrEqual(0);
      expect(
        (box?.x ?? Infinity) + (box?.width ?? Infinity),
        `${name}ボタンの右端`,
      ).toBeLessThanOrEqual(375);
    }
    await register(page, {
      userId: 'narrow-user',
      userName: '狭い画面の人',
      password: 'Abcdef12',
      role: 'worker',
    });
    await expect(notice(page)).toHaveText('登録しました');
    await shot(page, testInfo, 'uc14-registered-narrow');
  });
});

test.describe('境界値: 長いユーザー名・ユーザーID（上限ちょうど）', () => {
  test('ユーザー名200文字・ユーザーID100文字でも登録でき、一覧の表は、操作のボタンが見える範囲に収まる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openUsers(page);
    const longName = 'あ'.repeat(200);
    const longId = `u${'a'.repeat(99)}`;

    await register(page, {
      userId: longId,
      userName: longName,
      password: 'Abcdef12',
      role: 'worker',
    });

    await expect(notice(page)).toHaveText('登録しました');
    await expect(rowOf(page, longId)).toContainText(longName);
    await shot(page, testInfo, 'uc14-long-values');
    // 操作のボタンが、表の枠の中で、切れずに見える（ユーザー名の列だけが折り返す）
    const button = rowOf(page, longId).getByRole('button', { name: '削除' });
    const buttonBox = await button.boundingBox();
    const panelBox = await page.locator('.table-scroll').boundingBox();
    expect((buttonBox?.x ?? 0) + (buttonBox?.width ?? 0)).toBeLessThanOrEqual(
      (panelBox?.x ?? 0) + (panelBox?.width ?? 0) + 1,
    );
  });
});

test.describe('タブレット幅（768px。NFR-7.3）でも、ユーザー管理の表は、全列・操作のボタンが、横にスクロールせずに見える', () => {
  test('一覧が、表の枠の中に収まる', async ({ page, request }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await page.setViewportSize({ width: 768, height: 1024 });
    await openUsers(page);

    await expect(rows(page)).toHaveCount(2);
    await shot(page, testInfo, 'uc14-list-tablet');
    const scroll = page.locator('.table-scroll');
    expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await expect(rowOf(page, USER_B.userId).getByRole('button', { name: '削除' })).toBeInViewport();
  });
});
