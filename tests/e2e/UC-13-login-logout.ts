/**
 * UC-13 ログイン・ログアウトする（SC-01。FR-9.1〜FR-9.3、NFR-5.1）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、ユーザーIDとパスワードでログインする
 *               2. システムが、認証し、利用を許可する
 *               3. 農作業者が、利用を終えたらログアウトする
 *   代替フロー  ・認証に失敗した場合は、エラーを表示する。試行回数が制限を超えた場合は、ログインを受け付けない
 *               ・未認証でアクセスした場合は、ログイン画面へ誘導する
 *               ・セッションの有効期限が切れた場合は、再度ログインを求める
 *   事後条件    認証済みの農作業者が、システムを利用できる。または、ログアウトしている
 *
 * 値の同値分割: 認証情報（正しい・パスワード違い・存在しないユーザー・大文字小文字違い・空・空白）、試行回数の制限
 * （5回の失敗まで・6回目から拒否。境界: 15分、成功でリセット、接続元ごと）、セッション（アクセス30分は自動更新・リフレッシュ7日で期限切れ）、
 * 戻り先（同じサイト内・外部へ誘導するもの）、ログアウト（トークンの無効化・別のタブ・別のブラウザ）。
 * 関連するユースケース: UC-14（登録したユーザーでのログイン）、すべてのユースケースの前提（未認証のアクセス）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  USER_B,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  newUserSession,
  openAs,
  prepareApp,
} from './support/app.ts';
import { E2E_USER } from './support/e2e-user.ts';
import { loginViaUi, resetBackend } from './support/helpers.ts';
import { shot } from './support/viewpoint-scenarios.ts';

const FAILED_MESSAGE = 'ユーザーIDまたはパスワードが正しくありません';
const LOCKED_MESSAGE = 'ログインの試行回数が上限を超えました。しばらくしてからやり直してください';

/** 接続元（X-Forwarded-For）を、テストごとに別にする（ログインの試行回数の制限が、ほかのテストに影響しないように）。 */
async function useClient(page: Page, address: string): Promise<void> {
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': address });
}

async function submitLogin(page: Page, userId: string, password: string): Promise<void> {
  await page.getByLabel('ユーザーID').fill(userId);
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
}

test.beforeEach(async ({ request }) => {
  await resetBackend(request, 'NONE');
});

test.describe('基本フロー: ログインし、利用し、ログアウトする', () => {
  test('未認証でアクセスするとログイン画面へ誘導され、認証に成功するとダッシュボードが表示され、ログアウトで戻る', async ({
    page,
  }, testInfo) => {
    // 1. 未認証のアクセスは、ログイン画面へ誘導する
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\?next=%2F$/);
    await expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
    await shot(page, testInfo, 'uc13-login');

    // 2. 認証に失敗したら、原因を特定できないメッセージを表示する
    await loginViaUi(page, 'Wrong-Passw0rd');
    await expect(page.getByRole('alert')).toHaveText(FAILED_MESSAGE);
    await shot(page, testInfo, 'uc13-failed');

    // 3. 認証に成功したら、ダッシュボードを表示する
    await loginViaUi(page);
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
    await expect(page.getByText(E2E_USER.userName)).toBeVisible();
    await shot(page, testInfo, 'uc13-logged-in');

    // 4. 再読み込みしても、ログインが保持される
    await page.reload();
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

    // 5. ログアウトすると、ログイン画面へ戻り、保護された画面へ直接アクセスできない
    await page.getByRole('button', { name: 'ログアウト' }).click();
    await expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
    await page.goto('/notifications');
    await expect(page).toHaveURL(/\/login\?next=%2Fnotifications$/);
  });

  test('パスワードの入力欄は、入力内容を表示しない。ログインの前後で、パスワードが URL に現れない。Enter キーでも送信できる', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.getByLabel('パスワード')).toHaveAttribute('type', 'password');

    await page.getByLabel('ユーザーID').fill(E2E_USER.userId);
    await page.getByLabel('パスワード').fill(E2E_USER.password);
    expect(page.url()).not.toContain(E2E_USER.password);
    await page.getByLabel('パスワード').press('Enter');

    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
    expect(page.url()).not.toContain(E2E_USER.password);
  });

  test('ログイン済みで、ログイン画面を開くと、ダッシュボードへ移る', async ({ page }) => {
    await page.goto('/');
    await loginViaUi(page);
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

    await page.goto('/login');

    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test('ログイン中のユーザー名を、ヘッダーに表示する', async ({ page }) => {
    await page.goto('/');
    await loginViaUi(page);

    await expect(page.getByLabel('ログイン中のユーザー')).toHaveText(E2E_USER.userName);
  });

  test('スマートフォン幅（375px）でも、ログイン画面は、横にはみ出さず、入力欄とボタンが画面の幅に収まり、ログインできる', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/login');

    await shot(page, testInfo, 'uc13-login-narrow');
    const box = await page.getByLabel('ユーザーID').boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? 0).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
    const button = await page.getByRole('button', { name: 'ログイン' }).boundingBox();
    expect(button?.x ?? 0).toBeGreaterThanOrEqual(0);
    expect((button?.x ?? 0) + (button?.width ?? 0)).toBeLessThanOrEqual(375);
    await loginViaUi(page);

    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
    await shot(page, testInfo, 'uc13-logged-in-narrow');
  });
});

test.describe('代替フロー: 認証に失敗した場合は、原因を特定できないエラーを表示する（認証情報の同値分割）', () => {
  const failures: readonly { name: string; userId: string; password: string }[] = [
    { name: 'パスワードが違う', userId: E2E_USER.userId, password: 'Wrong-Passw0rd' },
    { name: '存在しないユーザー', userId: 'nobody', password: E2E_USER.password },
    {
      name: 'ユーザーIDの大文字小文字が違う（区別する）',
      userId: 'E2E-USER',
      password: E2E_USER.password,
    },
    {
      name: 'パスワードの大文字小文字が違う（区別する）',
      userId: E2E_USER.userId,
      password: E2E_USER.password.toUpperCase(),
    },
    {
      name: 'ユーザーIDの前後に空白がある',
      userId: ` ${E2E_USER.userId} `,
      password: E2E_USER.password,
    },
    { name: 'ユーザーIDが空白のみ', userId: '   ', password: E2E_USER.password },
    {
      name: 'ユーザーIDに記号を含む（形式が不正）',
      userId: "e2e-user'--",
      password: E2E_USER.password,
    },
  ];

  for (const [index, item] of failures.entries()) {
    test(`${item.name}: ユーザーIDの存在を推測させない、同じメッセージを表示し、ログインしない`, async ({
      page,
    }) => {
      await useClient(page, `203.0.113.${String(10 + index)}`);
      await page.goto('/login');

      await submitLogin(page, item.userId, item.password);

      await expect(page.getByRole('alert')).toHaveText(FAILED_MESSAGE);
      await expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
      await expect(page.getByRole('banner')).toHaveCount(0);
    });
  }

  test('ユーザーID・パスワードが未入力なら、項目ごとのエラーを表示し、送信しない', async ({
    page,
  }) => {
    await page.goto('/login');

    await page.getByRole('button', { name: 'ログイン' }).click();

    await expect(page.getByText('ユーザーIDを入力してください')).toBeVisible();
    await expect(page.getByText('パスワードを入力してください')).toBeVisible();
    await expect(page.getByLabel('ユーザーID')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert')).toHaveCount(0);
    // 片方だけ入力すると、もう片方のエラーだけが残る
    await page.getByLabel('ユーザーID').fill(E2E_USER.userId);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(page.getByText('ユーザーIDを入力してください')).toHaveCount(0);
    await expect(page.getByText('パスワードを入力してください')).toBeVisible();
  });

  test('失敗した後に、正しい認証情報でログインできる（エラー表示は消える）', async ({ page }) => {
    await useClient(page, '203.0.113.30');
    await page.goto('/login');
    await submitLogin(page, E2E_USER.userId, 'Wrong-Passw0rd');
    await expect(page.getByRole('alert')).toBeVisible();

    await submitLogin(page, E2E_USER.userId, E2E_USER.password);

    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  });
});

test.describe('代替フロー: 試行回数が制限（失敗5回 / 15分 / 接続元）を超えた場合は、ログインを受け付けない', () => {
  async function failTimes(page: Page, times: number): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      await submitLogin(page, E2E_USER.userId, 'Wrong-Passw0rd');
      await expect(page.getByRole('alert')).toHaveText(FAILED_MESSAGE);
    }
  }

  test('失敗が5回までは、通常のエラー。6回目は、正しい認証情報でも、受け付けず、その旨を表示する', async ({
    page,
  }, testInfo) => {
    await useClient(page, '203.0.113.40');
    await page.goto('/login');
    await failTimes(page, 5);

    await submitLogin(page, E2E_USER.userId, E2E_USER.password);

    await expect(page.getByRole('alert')).toHaveText(LOCKED_MESSAGE);
    await expect(page.getByRole('banner')).toHaveCount(0);
    await shot(page, testInfo, 'uc13-locked');
  });

  test('失敗が4回なら、制限に達しない（境界）。正しいパスワードで、ログインできる', async ({
    page,
  }) => {
    await useClient(page, '203.0.113.41');
    await page.goto('/login');
    await failTimes(page, 4);

    await submitLogin(page, E2E_USER.userId, E2E_USER.password);

    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  });

  test('制限は、15分で解ける（14分後は、まだ拒否。15分後は、受け付ける）', async ({
    page,
    request,
  }) => {
    await prepareApp(request, { equipment: false });
    await useClient(page, '203.0.113.42');
    await page.goto('/login');
    await failTimes(page, 5);
    await advanceMinutes(request, 14);
    await submitLogin(page, E2E_USER.userId, E2E_USER.password);
    await expect(page.getByRole('alert')).toHaveText(LOCKED_MESSAGE);

    await advanceMinutes(request, 1);
    await submitLogin(page, E2E_USER.userId, E2E_USER.password);

    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  });

  test('成功すると、失敗の回数はリセットされる（4回失敗 → 成功 → ログアウト → 4回失敗でも、制限されない）', async ({
    page,
  }) => {
    await useClient(page, '203.0.113.43');
    await page.goto('/login');
    await failTimes(page, 4);
    await submitLogin(page, E2E_USER.userId, E2E_USER.password);
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
    await page.getByRole('button', { name: 'ログアウト' }).click();
    await failTimes(page, 4);

    await submitLogin(page, E2E_USER.userId, E2E_USER.password);

    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  });

  test('制限は、接続元ごと（ある接続元が制限されても、別の接続元は、ログインできる）', async ({
    page,
    browser,
  }, testInfo) => {
    await useClient(page, '203.0.113.44');
    await page.goto('/login');
    await failTimes(page, 5);
    await submitLogin(page, E2E_USER.userId, E2E_USER.password);
    await expect(page.getByRole('alert')).toHaveText(LOCKED_MESSAGE);

    const other = await newUserSession(browser, testInfo, 'other-client');
    await useClient(other.page, '203.0.113.45');
    await other.page.goto('/login');
    await submitLogin(other.page, E2E_USER.userId, E2E_USER.password);

    await expect(other.page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
    await other.context.close();
  });
});

test.describe('代替フロー: 未認証でアクセスした場合は、ログイン画面へ誘導する（戻り先）', () => {
  test('保護された画面（クエリつき）へのアクセスは、ログイン画面へ誘導され、ログイン後に、元の画面（クエリを含む）へ戻る', async ({
    page,
  }) => {
    await page.goto('/notifications?kind=INGESTION_FAILURE&readState=UNREAD');
    await expect(page).toHaveURL(
      /\/login\?next=%2Fnotifications%3Fkind%3DINGESTION_FAILURE%26readState%3DUNREAD$/,
    );

    await loginViaUi(page);

    await expect(page).toHaveURL(/\/notifications\?kind=INGESTION_FAILURE&readState=UNREAD$/);
    await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
  });

  const unsafe: readonly { name: string; next: string }[] = [
    { name: '別のサイト（https://…）', next: 'https://evil.example/phish' },
    { name: 'プロトコル相対（//…）', next: '//evil.example/phish' },
    { name: 'スキームなしの相対パス', next: 'evil' },
    { name: '空', next: '' },
  ];

  for (const item of unsafe) {
    test(`戻り先が${item.name}の場合は、外部へ誘導せず、ダッシュボードへ移る`, async ({
      page,
      baseURL,
    }) => {
      await page.goto(`/login?next=${encodeURIComponent(item.next)}`);

      await loginViaUi(page);

      await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
      // 同じサイトにとどまっていること。サイトの origin は、設定（dev-ports.ts）から決まる baseURL を使う
      expect(new URL(page.url()).origin).toBe(baseURL);
    });
  }

  test('すべての保護された画面は、未認証だと、ログイン画面へ誘導する', async ({ page }) => {
    for (const path of [
      '/',
      '/notifications',
      '/data-entry',
      '/data-entry/list',
      '/data-entry/history',
      '/observations',
      '/settings/equipment',
      '/settings/ingestion',
      '/settings/status-codes',
      '/settings/users',
      '/settings/push',
      '/satisfaction',
      '/viewpoints/safety',
      '/viewpoints/safety/criteria',
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
      await expect(page).toHaveURL(/\/login\?next=/);
    }
  });
});

test.describe('代替フロー: セッションの有効期限が切れた場合は、再度ログインを求める', () => {
  test('アクセストークン（30分）の期限が切れても、リフレッシュトークン（7日）で、自動で更新され、ログインし直さずに使い続けられる', async ({
    page,
    request,
  }) => {
    await prepareApp(request, { equipment: false });
    await alignBrowserClock(page);
    await openAs(page, '/');
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

    await advanceMinutes(request, 31);
    await page
      .getByRole('navigation', { name: 'メニュー' })
      .getByRole('link', { name: '通知', exact: true })
      .click();

    await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
    await expect(page.getByTestId('notifications-empty')).toBeVisible();
  });

  test('リフレッシュトークン（7日）の期限が切れたら、ログイン画面へ戻り、ログイン後に、元の画面へ戻る', async ({
    page,
    request,
  }) => {
    await prepareApp(request, { equipment: false });
    await alignBrowserClock(page);
    await openAs(page, '/');
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

    await advanceMinutes(request, 7 * 24 * 60 + 1);
    await page
      .getByRole('navigation', { name: 'メニュー' })
      .getByRole('link', { name: '通知', exact: true })
      .click();

    await expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
    await expect(page).toHaveURL(/\/login\?next=%2Fnotifications$/);
    await loginViaUi(page);
    await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
  });
});

test.describe('ログアウト: セッションを破棄する', () => {
  test('ログアウトすると、アクセストークンが無効になる（古いトークンで、API を呼べない）。この端末のセッションも消える', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await loginViaUi(page);
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
    const token = await page.evaluate(() => {
      const raw = window.sessionStorage.getItem('smart-farm.session');
      return (JSON.parse(raw ?? '{}') as { accessToken?: string }).accessToken ?? '';
    });
    expect(token).not.toBe('');
    const before = await request.get('/api/v1/equipment', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.status()).toBe(200);

    await page.getByRole('button', { name: 'ログアウト' }).click();

    await expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
    const after = await request.get('/api/v1/equipment', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.status()).toBe(401);
    expect(await page.evaluate(() => window.sessionStorage.length)).toBe(0);
  });

  test('ログアウトした後に、ブラウザの「戻る」で、保護された画面へ戻ろうとしても、ログイン画面へ誘導する', async ({
    page,
  }) => {
    await page.goto('/');
    await loginViaUi(page);
    await page
      .getByRole('navigation', { name: 'メニュー' })
      .getByRole('link', { name: '通知', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'ログアウト' }).click();
    await expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
    await page.goBack();

    await expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '通知', level: 1 })).toHaveCount(0);
    await expect(page.getByRole('banner')).toHaveCount(0);
  });

  test('セッションは、タブごと（別のタブでは、ログインが必要）。別のタブを開いても、元のタブのセッションは保たれる', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await loginViaUi(page);
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

    const tab = await context.newPage();
    await tab.goto('/');

    await expect(tab.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  });

  test('複数の利用者（A・B）が、別のブラウザで、それぞれログインでき、Aがログアウトしても、Bのセッションは続く', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await addUser(request, USER_B);
    await page.goto('/');
    await loginViaUi(page);
    const b = await newUserSession(browser, testInfo, 'user-b');
    await b.page.goto('/');
    await loginViaUi(b.page, USER_B.password, USER_B.userId);
    await expect(page.getByLabel('ログイン中のユーザー')).toHaveText(E2E_USER.userName);
    await expect(b.page.getByLabel('ログイン中のユーザー')).toHaveText(USER_B.userName);

    await page.getByRole('button', { name: 'ログアウト' }).click();

    await expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
    await b.page.reload();
    await expect(b.page.getByLabel('ログイン中のユーザー')).toHaveText(USER_B.userName);
    await b.context.close();
  });
});
