/**
 * 秘密情報の参照名の検証（Issue #206。ADR-0016 の D-55）。
 * 参照名は、パラメータストアのパス（`<接頭辞><参照名>`）になる。上の階層への移動（`..`）・絶対パス・大文字などを拒み、
 * 接頭辞（環境ごとのパス）の外を指せないようにする。参照名は、利用者が入力する値（接続設定の参照名）になりうる。
 */

import { AppError } from '@smart-farm/shared/errors';
import { MAX_SECRET_VALUE_BYTES } from './ports/secret-port.ts';

const SEGMENT = '[a-z0-9][a-z0-9._-]{0,63}';
/** 1〜4 階層。各階層は、小文字・数字で始まり、小文字・数字・`.`・`_`・`-` が、64 文字まで。 */
const REFERENCE_PATTERN = new RegExp(`^${SEGMENT}(/${SEGMENT}){0,3}$`);

export function isValidSecretReference(reference: string): boolean {
  return REFERENCE_PATTERN.test(reference);
}

/** 参照名を検証して返す。不正なら、エラー（参照名の値は、メッセージに含めない）。 */
export function parseSecretReference(reference: string): string {
  if (!isValidSecretReference(reference)) {
    throw new AppError('VALIDATION_ERROR', '秘密情報の参照名が正しくありません');
  }
  return reference;
}

/** 値を検証する。空・4 KB を超える値は、拒否する（値は、メッセージに含めない）。 */
export function assertValidSecretValue(value: string): void {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_SECRET_VALUE_BYTES) {
    throw new AppError('VALIDATION_ERROR', '秘密情報の値が正しくありません');
  }
}
