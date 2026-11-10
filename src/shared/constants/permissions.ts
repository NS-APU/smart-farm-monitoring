/**
 * 操作の権限（FR-9.5、architecture.md 9章）。
 * 操作ごとに「必要な権限」を定め、ロールへの割り当ては設定で行う。権限が null の操作は「要ログイン」のみ。
 * 既定は、管理者（全権限）・一般（手動入力のみ）の 2 ロール（ADR-0013。Issue #115）。dev_spec.md 4章。
 */

export const PERMISSIONS = [
  'equipment:manage',
  'ingestion:configure',
  'ingestion:run',
  'ingestion:read',
  'status-code:manage',
  'manual-entry:write',
  'criteria:edit',
  'user:manage',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** 既定のロール: 管理者（全権限）。最初のユーザー（`pnpm initial-user`）は、このロールで作る。 */
export const ADMIN_ROLE_ID = 'admin';
export const ADMIN_ROLE_NAME = '管理者';
/** 既定のロール: 一般（手動入力のみ。自身のユーザー情報の編集と、要ログインの閲覧は、権限なしで使える）。 */
export const GENERAL_ROLE_ID = 'general';
export const GENERAL_ROLE_NAME = '一般';
