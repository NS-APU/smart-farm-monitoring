/**
 * パスワードのハッシュ化（Node 標準の scrypt）。平文のパスワードを保存・ログ出力しない（FR-9.2）。
 * 暗号の仕組みは自作せず、標準ライブラリの実績のあるアルゴリズムを使う（coding-standards.md）。
 * 形式: `scrypt$<salt（16進数）>$<ハッシュ（16進数）>`。
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const FORMAT_PREFIX = 'scrypt';

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_BYTES);
  return `${FORMAT_PREFIX}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  const [prefix, saltHex, hashHex] = passwordHash.split('$');
  if (prefix !== FORMAT_PREFIX || saltHex === undefined || hashHex === undefined) {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== KEY_BYTES) {
    return false;
  }
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_BYTES);
  return timingSafeEqual(actual, expected);
}
