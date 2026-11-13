import { DEFAULT_ROLE_CONFIG } from '../../../src/backend/application/auth/access-policy.ts';

/** E2E テスト用の初期ユーザー。明らかにダミーとわかる値（実際の認証情報ではない）。 */
export const E2E_USER = {
  userId: 'e2e-user',
  userName: 'E2Eテスト用ユーザー',
  password: 'Dummy-Passw0rd-e2e',
} as const;

/**
 * E2E のロール定義（JSON）。既定の 2 ロール（admin＝管理者〔全権限〕、general＝一般〔手動入力のみ〕。ADR-0013）に、
 * 参照のみの確認用の viewer＝閲覧者（全設備の閲覧と、取り込みの状況・ログの閲覧のみ。書き込みの権限なし）を加える。
 */
export const E2E_ROLE_DEFINITIONS_JSON = JSON.stringify({
  ...DEFAULT_ROLE_CONFIG,
  viewer: { name: '閲覧者', permissions: ['equipment:view-all', 'ingestion:read'] },
});
