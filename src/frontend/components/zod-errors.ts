/** 入力の検証（Zod）の結果を、項目ごとのエラー（項目名 → メッセージ）にする。項目名は、パスを `.` でつなぐ。 */

import type { ZodError } from 'zod';
import { toFieldErrors } from '@smart-farm/shared/schemas/field-errors';

export function fieldErrorsOfZod(error: ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const { name, message } of toFieldErrors(error)) {
    // 同じ項目の最初のメッセージを使う
    errors[name] ??= message;
  }
  return errors;
}
