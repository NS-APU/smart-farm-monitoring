/** ログイン中の利用者が、操作の権限を持つか。画面の表示制御のみ（サーバー側でも、権限を確認する）。 */

import type { Permission } from '@smart-farm/shared/constants/permissions';
import { useAuth } from '../auth/auth-context.tsx';

export function usePermission(permission: Permission): boolean {
  const { user } = useAuth();
  return user?.permissions.includes(permission) ?? false;
}
