/**
 * 認可の方針（ロール → 権限）。architecture.md 9章。
 * ロールの分け方は未確定（Q-017）のため、ロールと権限の割り当てを設定として持つ。
 * 既定は1ロール（農作業者。全権限）。3ロール（管理者・評価者・閲覧者）でも、設定の変更だけで対応できる。
 */

import {
  DEFAULT_ROLE_ID,
  DEFAULT_ROLE_NAME,
  PERMISSIONS,
  type Permission,
} from '@smart-farm/shared/constants/permissions';

export interface RoleDefinition {
  readonly name: string;
  readonly permissions: readonly Permission[];
}

export type RoleConfig = Readonly<Record<string, RoleDefinition>>;

export const DEFAULT_ROLE_CONFIG: RoleConfig = {
  [DEFAULT_ROLE_ID]: { name: DEFAULT_ROLE_NAME, permissions: PERMISSIONS },
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
