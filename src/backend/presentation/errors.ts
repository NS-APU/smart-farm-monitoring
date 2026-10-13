/**
 * API の共通エラー形式（functional-specification.md 1.3）:
 * `{ "error": { "code", "message", "fields": [{ "name", "message" }] } }`
 * message に内部情報（スタックトレース、パス、SQL、設定値）を含めない（security.md）。
 */

import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError, type ErrorCode, type FieldError } from '@smart-farm/shared/errors';
import type { ErrorResponse } from '@smart-farm/shared/schemas/api';
import { errorLogFields } from '../application/error-fields.ts';
import type { AppEnv } from './api-deps.ts';

const HTTP_STATUS_OF_ERROR_CODE: Readonly<Record<ErrorCode, ContentfulStatusCode>> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  SERVICE_UNAVAILABLE: 503,
};

export function buildErrorBody(
  code: ErrorCode,
  message: string,
  fields: readonly FieldError[] = [],
): ErrorResponse {
  return { error: { code, message, ...(fields.length > 0 ? { fields: [...fields] } : {}) } };
}

export const handleNotFound: NotFoundHandler<AppEnv> = (c) =>
  c.json(buildErrorBody('NOT_FOUND', '指定されたリソースが見つかりません'), 404);

export const handleError: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof AppError) {
    return c.json(
      buildErrorBody(error.code, error.message, error.fields),
      HTTP_STATUS_OF_ERROR_CODE[error.code],
    );
  }
  if (error instanceof HTTPException && error.status < 500) {
    return c.json(buildErrorBody('VALIDATION_ERROR', 'リクエストが正しくありません'), 400);
  }
  // 想定外のエラー（バグ）。詳細はログにのみ残し、応答には内部情報を含めない。
  // 入力の検証の失敗（400）は、AppError（request-parsing.ts の parseInput）として扱う。
  // サービスの内部の検証の失敗（ZodError。保存済みのデータの不整合など）は、ここへ来る
  c.var.logger.error('想定外のエラーが発生しました', {
    method: c.req.method,
    path: c.req.path,
    ...errorLogFields(error),
  });
  return c.json(
    buildErrorBody(
      'INTERNAL_ERROR',
      'サーバーでエラーが発生しました。しばらくしてからやり直してください',
    ),
    500,
  );
};
