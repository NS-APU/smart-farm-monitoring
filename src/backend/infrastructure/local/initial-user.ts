/**
 * 最初のユーザーの作成（暫定: 環境変数の初期ユーザー。dev_spec.md 4章、要件側 R-13）。
 * ユーザーが1人もいない場合のみ作成する（冪等。既存のユーザーを上書きしない）。
 * 平文のパスワードは、資格情報のポート（CredentialPort）に預け（ローカルは、ハッシュ化して保存）、ログに出力しない。
 * Cognito では、最初のユーザーを、手元のコマンド（runtime/initial-user-cli.ts）で、この関数を使って作る。
 */

import { toUserId } from '@smart-farm/shared/schemas/common';
import type { CredentialPort } from '../../application/ports/credential-port.ts';
import type { UserRepository } from '../../application/ports/repositories.ts';
import { createLocalCredentials } from './local-credentials.ts';
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
  credentials: CredentialPort = createLocalCredentials({ hash: hashPassword }),
): Promise<boolean> {
  if ((await users.list()).length > 0) {
    return false;
  }
  const userId = toUserId(initialUser.userId);
  const stored = await credentials.register(userId, initialUser.password);
  await users.save({
    userId,
    userName: initialUser.userName,
    role: initialUser.role,
    ...stored,
    createdAt: now.toISOString(),
  });
  return true;
}
