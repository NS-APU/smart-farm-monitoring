/**
 * 保存・削除などの操作（API の呼び出し）の実行と、その状態（実行中・エラー・項目ごとのエラー）。
 * 二重実行を防ぐため、実行中は busy を返す。エラーは、利用者向けのメッセージ（内部情報を含めない）で保持する。
 */

import { useCallback, useMemo, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { MESSAGES } from '../i18n/messages.ts';

export type SubmitResult<Value> =
  { readonly ok: true; readonly value: Value } | { readonly ok: false };

export interface SubmitState {
  readonly busy: boolean;
  readonly run: <Value>(action: () => Promise<Value>) => Promise<SubmitResult<Value>>;
  /** 項目ごとのエラー（項目名 → メッセージ）。 */
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** 画面全体のエラーのメッセージ。エラーがなければ undefined。 */
  readonly formMessage: string | undefined;
  readonly clearError: () => void;
}

export function useSubmit(): SubmitState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const run = useCallback(async <Value>(action: () => Promise<Value>) => {
    setBusy(true);
    setError(undefined);
    try {
      const value = await action();
      return { ok: true, value } as const;
    } catch (caught) {
      setError(caught);
      return { ok: false } as const;
    } finally {
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => {
    setError(undefined);
  }, []);

  const fieldErrors = useMemo(
    () =>
      error instanceof ApiError
        ? Object.fromEntries(error.fields.map((field) => [field.name, field.message]))
        : {},
    [error],
  );
  const formMessage =
    error === undefined
      ? undefined
      : error instanceof ApiError
        ? error.message
        : MESSAGES.common.unexpectedError;

  return { busy, run, fieldErrors, formMessage, clearError };
}
