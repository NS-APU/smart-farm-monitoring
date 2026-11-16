/** ロールの表示名（ヘッダーのユーザーメニュー。Issue #353）。知らないロール（既定の 2 つ以外）は、undefined。 */

import {
  ADMIN_ROLE_ID,
  ADMIN_ROLE_NAME,
  GENERAL_ROLE_ID,
  GENERAL_ROLE_NAME,
} from '@smart-farm/shared/constants/permissions';

const ROLE_NAMES: Readonly<Record<string, string>> = {
  [ADMIN_ROLE_ID]: ADMIN_ROLE_NAME,
  [GENERAL_ROLE_ID]: GENERAL_ROLE_NAME,
};

export function roleDisplayName(role: string): string | undefined {
  return ROLE_NAMES[role];
}
