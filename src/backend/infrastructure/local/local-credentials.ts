/** 資格情報（パスワード）の管理のローカル実装。パスワードのハッシュを、ユーザーの記録に持つ。 */

import type { CredentialPort } from '../../application/ports/credential-port.ts';
import type { PasswordHasherPort } from '../../application/ports/password-hasher-port.ts';

export function createLocalCredentials(hasher: PasswordHasherPort): CredentialPort {
  return {
    register: (_userId, password) => Promise.resolve({ passwordHash: hasher.hash(password) }),
    reset: (_userId, password) => Promise.resolve({ passwordHash: hasher.hash(password) }),
    // ハッシュは、ユーザーの記録とともに、削除される
    remove: () => Promise.resolve(),
  };
}
