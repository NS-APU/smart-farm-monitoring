/**
 * 操作の権限（FR-9.5、architecture.md 9章）。
 * 認証・認可の要否とロールの分け方は未確定（Q-017）のため、操作ごとに「必要な権限」を定め、
 * ロールへの割り当ては設定で行う。権限が null の操作は「要ログイン」のみ。
 * 既定は1ロール（全権限）。dev_spec.md 4章。
 */

export const PERMISSIONS = [
  'equipment:manage',
  'ingestion:configure',
  'ingestion:run',
  'status-code:manage',
  'manual-entry:write',
  'criteria:edit',
  'user:manage',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** 既定のロール（1ロール。農作業者）。 */
export const DEFAULT_ROLE_ID = 'worker';
export const DEFAULT_ROLE_NAME = '農作業者';
