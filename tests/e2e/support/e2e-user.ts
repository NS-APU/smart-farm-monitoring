import { PERMISSIONS } from '../../../src/shared/constants/permissions.ts';

/** E2E テスト用の初期ユーザー。明らかにダミーとわかる値（実際の認証情報ではない）。 */
export const E2E_USER = {
  userId: 'e2e-user',
  userName: 'E2Eテスト用ユーザー',
  password: 'Dummy-Passw0rd-e2e',
} as const;

/** E2E のロール定義（JSON）。worker＝農作業者（全権限）、viewer＝閲覧者（要ログインの操作のみ）。 */
export const E2E_ROLE_DEFINITIONS_JSON = JSON.stringify({
  worker: { name: '農作業者', permissions: PERMISSIONS },
  viewer: { name: '閲覧者', permissions: [] },
});
