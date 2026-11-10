/**
 * 認可の方針（ロール → 権限）。architecture.md 9章。
 * ロールと権限の割り当てを設定として持つ。既定は、管理者（全権限）・一般（手動入力のみ）の 2 ロール（ADR-0013）。
 * 3 ロール以上でも、設定の変更だけで対応できる。
 */

import {
  ADMIN_ROLE_ID,
  ADMIN_ROLE_NAME,
  GENERAL_ROLE_ID,
  GENERAL_ROLE_NAME,
  PERMISSIONS,
  type Permission,
} from '@smart-farm/shared/constants/permissions';

export interface RoleDefinition {
  readonly name: string;
  readonly permissions: readonly Permission[];
}

export type RoleConfig = Readonly<Record<string, RoleDefinition>>;

export const DEFAULT_ROLE_CONFIG: RoleConfig = {
  [ADMIN_ROLE_ID]: { name: ADMIN_ROLE_NAME, permissions: PERMISSIONS },
  [GENERAL_ROLE_ID]: { name: GENERAL_ROLE_NAME, permissions: ['manual-entry:write'] },
};

export interface AccessPolicy {
  isKnownRole(role: string): boolean;
  /** ロールの権限。未知のロールは権限なし（要ログインの操作のみ）。 */
  permissionsOf(role: string): readonly Permission[];
  can(role: string, permission: Permission): boolean;
  roleIds(): readonly string[];
  /** ロールの一覧（ユーザー管理の選択肢）。 */
  roleOptions(): readonly { readonly roleId: string; readonly name: string }[];
}

export function createAccessPolicy(config: RoleConfig): AccessPolicy {
  return {
    isKnownRole: (role) => Object.hasOwn(config, role),
    permissionsOf: (role) => (Object.hasOwn(config, role) ? (config[role]?.permissions ?? []) : []),
    can: (role, permission) =>
      Object.hasOwn(config, role) && (config[role]?.permissions.includes(permission) ?? false),
    roleIds: () => Object.keys(config),
    roleOptions: () =>
      Object.entries(config).map(([roleId, role]) => ({ roleId, name: role.name })),
  };
}
