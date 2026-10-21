/**
 * スモークテスト・性能の実測の画面操作の補助。画面の文言・要素は、tests/e2e/support/・tests/stress/support/ui.ts と同じもの
 * （画面の仕様変更時は、同じ箇所を直す）。ログインに使う値は、環境変数から読む（smoke-env.ts）。
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { readSmokeEnv, type SmokeEnv } from './smoke-env.ts';

export {
  expectDashboardShown,
  expectDetailShown,
  loadingView,
  mainArea,
} from '../../stress/support/ui.ts';

let cached: SmokeEnv | undefined;

/** 接続先・ログインの値（初回に読む）。 */
export function smokeEnv(): SmokeEnv {
  cached ??= readSmokeEnv();
  return cached;
}

/** ログイン画面を開く。 */
export async function openLogin(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
}

/** ログイン画面で、ユーザーID・パスワードを入力する（送信は、計測の対象として、呼び出し側が行う）。 */
export async function fillLogin(page: Page): Promise<void> {
  const { userId, password } = smokeEnv();
  await page.getByLabel('ユーザーID').fill(userId);
  await page.getByLabel('パスワード').fill(password);
}

export const loginButton = (page: Page): Locator => page.getByRole('button', { name: 'ログイン' });

/** メニュー（ヘッダー下のナビゲーション）のリンク。 */
export const menuLink = (page: Page, name: string): Locator =>
  page.getByRole('navigation', { name: 'メニュー' }).getByRole('link', { name, exact: true });
