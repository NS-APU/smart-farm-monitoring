/**
 * DynamoDB のアダプタのカーソル。前のページの最後の位置（キーの値）を、不透明な文字列にする。
 * オフセットのカーソル（common/pagination.ts）と違い、深いページでも、先頭から読み直さない。
 */

import { invalidCursorError } from '../common/pagination.ts';

export function encodeKeyCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

/** カーソルを、指定した個数の文字列に戻す。省略なら undefined。形式が違えば、入力不正（VALIDATION_ERROR）。 */
export function decodeKeyCursor(
  cursor: string | undefined,
  length: number,
): readonly string[] | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursorError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== length ||
    !parsed.every((part) => typeof part === 'string')
  ) {
    throw invalidCursorError();
  }
  return parsed;
}
