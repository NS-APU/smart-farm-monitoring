/** 入力の検証（Zod）のエラーを、項目ごとのエラー（項目名とメッセージ）に変換する。項目名は、パスを `.` でつなぐ。 */

import type { ZodError } from 'zod';
import type { FieldError } from '../errors.ts';

export function toFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    name: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
