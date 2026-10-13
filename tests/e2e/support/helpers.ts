import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { LoginResponseSchema } from '../../../src/shared/schemas/auth.ts';
import { E2E_USER } from './e2e-user.ts';

/** 画面からログインする（ログイン画面が表示されていること）。 */
export async function loginViaUi(
  page: Page,
  password: string = E2E_USER.password,
  userId: string = E2E_USER.userId,
): Promise<void> {
  await page.getByLabel('ユーザーID').fill(userId);
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
}

/**
 * 指定のパスを開く。未認証でログイン画面へ誘導された場合のみ、ログインする（すでにログインしていれば、そのまま）。
 * 1つのテストの中で、複数の画面を続けて開くときに使う。
 */
export async function gotoAuthenticated(page: Page, path: string): Promise<void> {
  await page.goto(path);
  const userIdField = page.getByLabel('ユーザーID');
  await Promise.race([userIdField.waitFor(), page.getByRole('banner').waitFor()]);
  if (await userIdField.isVisible()) {
    await loginViaUi(page);
  }
}

/**
 * バックエンドのデータをリセットし、初期データ（と、指定ならデモデータ）を入れ直す（開発用 API。ローカル・テストのみ）。
 * 初期ユーザーは作り直される。
 */
export async function resetBackend(
  request: APIRequestContext,
  seed: 'NONE' | 'DEMO',
): Promise<void> {
  const login = await request.post('/api/v1/auth/login', {
    data: { userId: E2E_USER.userId, password: E2E_USER.password },
  });
  expect(login.ok()).toBe(true);
  const { accessToken } = LoginResponseSchema.parse(await login.json());
  const reset = await request.post('/api/v1/dev/reset', {
    data: { seed },
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(reset.status()).toBe(204);
}
