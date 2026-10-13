/**
 * 失敗のログ用のフィールド（エラーの種類・メッセージ・原因・スタック）。ログの内容は、運用者のみが見る（応答には含めない）。
 * 秘密情報のマスクは、ロガー側（json-logger.ts）が行う。スタックは、長さを限る（ログの量は費用に直結するため）。
 */

const MAX_STACK_CHARS = 2000;

export interface ErrorLogFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly errorCause?: string;
  readonly errorStack?: string;
}

function describeCause(cause: unknown): string | undefined {
  if (cause === undefined) {
    return undefined;
  }
  return cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : typeof cause === 'string'
      ? cause
      : 'unknown';
}

export function errorLogFields(error: unknown): ErrorLogFields {
  if (!(error instanceof Error)) {
    return { errorName: 'NonError', errorMessage: String(error) };
  }
  const cause = describeCause(error.cause);
  return {
    errorName: error.name,
    errorMessage: error.message,
    ...(cause === undefined ? {} : { errorCause: cause }),
    ...(error.stack === undefined ? {} : { errorStack: error.stack.slice(0, MAX_STACK_CHARS) }),
  };
}
