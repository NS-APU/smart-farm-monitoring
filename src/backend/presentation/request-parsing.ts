/** リクエストの本文・クエリの読み取り（スキーマで検証する）。 */

import type { Context } from 'hono';
import type { z } from 'zod';
import { ZodError } from 'zod';
import { AppError, validationError } from '@smart-farm/shared/errors';
import { toFieldErrors } from '@smart-farm/shared/schemas/field-errors';
import type { AppEnv } from './api-deps.ts';

/** リクエスト本文の上限（バイト）。 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** JSON の文字列を読む。形式が不正なら VALIDATION_ERROR（400）。 */
function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'リクエストの本文が JSON として読み取れません');
  }
}

/**
 * 外部から受けた値（本文・クエリ・パスのパラメータ）を、スキーマで検証する。不正なら VALIDATION_ERROR（400）。
 * サービスの内部（保存済みのデータ・生成した値）の検証の失敗（ZodError）は、入力の誤りではなく不具合のため、
 * ここを通さない（エラーの応答の変換で、想定外のエラー（500）として、ログに残す）。
 */
export function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.infer<Schema> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw validationError(toFieldErrors(error));
    }
    throw error;
  }
}

/** JSON の本文を読み、スキーマで検証する。形式が不正なら VALIDATION_ERROR（400）。 */
export async function parseJsonBody<Schema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: Schema,
): Promise<z.infer<Schema>> {
  return parseInput(schema, readJson(await c.req.text()));
}

/** 本文が空でもよい JSON の本文を読み、スキーマで検証する（空の場合は、空のオブジェクトとして検証する）。 */
export async function parseOptionalJsonBody<Schema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const text = await c.req.text();
  if (text.trim() === '') {
    return parseInput(schema, {});
  }
  return parseInput(schema, readJson(text));
}

/** クエリを、スキーマで検証する。 */
export function parseQuery<Schema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: Schema,
): z.infer<Schema> {
  return parseInput(schema, c.req.query());
}
