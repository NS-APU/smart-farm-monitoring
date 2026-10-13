/**
 * 定期的に取得し直すフック。画面の更新は約10秒間隔で、タブが表示されているときだけ行う
 * （FR-6.7、coding-standards.md「フロントエンド」）。タブが非表示から表示に戻ったときは、次の間隔を待たず、すぐに取得し直す。
 * 取得関数（fetcher）が変わったら、読み込み中の状態に戻して、取得し直す。
 * 取得済みのデータがあるときの、更新の一時的な失敗（モバイル回線の切断など）では、データを保持し、
 * 失敗は refreshError で伝える（画面の表示を消さない）。連続して失敗が続いたら、データを破棄してエラーにする。
 */

import { useCallback, useEffect, useState } from 'react';

export const POLLING_INTERVAL_MS = 10_000;
/** データを保持したまま、更新の失敗を許す連続の回数。これに達したら、エラーにする。 */
export const MAX_CONSECUTIVE_REFRESH_FAILURES = 3;

export interface PollingState<Data> {
  readonly data: Data | undefined;
  /** データがない状態での取得の失敗（データを保持している間は undefined）。 */
  readonly error: Error | undefined;
  /** データを保持したまま、直近の更新が失敗している場合の原因。成功すれば undefined。 */
  readonly refreshError: Error | undefined;
  /** 取得関数が変わってから、最初の結果が得られるまで true。 */
  readonly isLoading: boolean;
  /** すぐに取得し直す。 */
  readonly reload: () => void;
}

interface Result<Data> {
  readonly fetcher: unknown;
  readonly data?: Data;
  readonly error?: Error;
  readonly refreshError?: Error;
  /** データを保持したままの、連続した更新の失敗の回数。 */
  readonly failures: number;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** 取得に失敗したときの、次の状態。データを保持できる間は保持する。 */
function afterFailure<Data>(
  previous: Result<Data> | undefined,
  fetcher: unknown,
  error: Error,
): Result<Data> {
  if (
    previous !== undefined &&
    previous.fetcher === fetcher &&
    previous.data !== undefined &&
    previous.failures + 1 < MAX_CONSECUTIVE_REFRESH_FAILURES
  ) {
    return { fetcher, data: previous.data, refreshError: error, failures: previous.failures + 1 };
  }
  return { fetcher, error, failures: 0 };
}

export function usePolling<Data>(
  fetcher: () => Promise<Data>,
  intervalMs: number = POLLING_INTERVAL_MS,
): PollingState<Data> {
  const [result, setResult] = useState<Result<Data> | undefined>(undefined);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetcher().then(
        (data) => {
          if (!cancelled) {
            setResult({ fetcher, data, failures: 0 });
          }
        },
        (error: unknown) => {
          if (!cancelled) {
            setResult((previous) => afterFailure(previous, fetcher, toError(error)));
          }
        },
      );
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        load();
      }
    }, intervalMs);
    // 別のタブから戻ったときに、古い内容を見せ続けないよう、すぐに取得し直す
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        load();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetcher, intervalMs, reloadCount]);

  const reload = useCallback(() => {
    setReloadCount((count) => count + 1);
  }, []);

  const current = result?.fetcher === fetcher ? result : undefined;
  return {
    data: current?.data,
    error: current?.error,
    refreshError: current?.refreshError,
    isLoading: current === undefined,
    reload,
  };
}
