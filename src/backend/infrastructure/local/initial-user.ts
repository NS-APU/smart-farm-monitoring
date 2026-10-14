/**
 * 最初のユーザーの作成（暫定: 環境変数の初期ユーザー。dev_spec.md 4章、要件側 R-13）。
 * ユーザーが1人もいない場合のみ作成する（冪等。既存のユーザーを上書きしない）。
 * 平文のパスワードは、ハッシュ化して保存し、ログに出力しない。
 */

import { toUserId } from '@smart-farm/shared/schemas/common';
import type { UserRepository } from '../../application/ports/repositories.ts';
import { hashPassword } from './password-hasher.ts';

export interface InitialUser {
  readonly userId: string;
  readonly userName: string;
  readonly password: string;
  readonly role: string;
}

/** 作成した場合は true。 */
export async function ensureInitialUser(
  users: UserRepository,
  initialUser: InitialUser,
  now: Date,
): Promise<boolean> {
  if ((await users.list()).length > 0) {
    return false;
  }
  await users.save({
    userId: toUserId(initialUser.userId),
    userName: initialUser.userName,
    role: initialUser.role,
    passwordHash: hashPassword(initialUser.password),
    createdAt: now.toISOString(),
  });
  return true;
}
