/**
 * アプリケーション共通のエラー型。
 * API の応答（{ error: { code, message, fields } }）に対応する。
 * message には内部情報（スタックトレース、パス、SQL、設定値）を含めない（security.md）。
 */

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface FieldError {
  readonly name: string;
  readonly message: string;
}

export interface AppErrorOptions {
  readonly fields?: readonly FieldError[];
  readonly cause?: unknown;
}

/** 入力の検証エラー（VALIDATION_ERROR）の共通のメッセージ。項目ごとの内容は fields に持つ。 */
export const VALIDATION_ERROR_MESSAGE = '入力内容に誤りがあります';

/** 想定できるエラー（入力不正、認証・認可、競合など）。想定外のエラー（バグ）は通常の Error のまま扱う。 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly fields: readonly FieldError[];

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.fields = options.fields ?? [];
  }
}

/** 型の絞り込み。現在は、テストでのみ使う（本番のコードは、`instanceof AppError` で判定する）。 */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** 入力の検証エラー（VALIDATION_ERROR）。 */
export function validationError(fields: readonly FieldError[]): AppError {
  return new AppError('VALIDATION_ERROR', VALIDATION_ERROR_MESSAGE, { fields });
}

/** 登録済みの値との重複（CONFLICT）。メッセージは、全体と項目の両方に同じ文を使う。 */
export function conflictError(fieldName: string, message: string): AppError {
  return new AppError('CONFLICT', message, { fields: [{ name: fieldName, message }] });
}
