/**
 * 定期的に取得し直す一覧で、新しい項目を、自動では加えないための状態（Issue #159 の SC-05-10。通知一覧）。
 * 再取得で、新しい項目が先頭に入ると、操作中の行が下へずれて、押そうとした行が動く。そのため、表示する一覧は、読み込んだ時点のものに保ち、
 * 新しい項目の件数（`newCount`）だけを示す。押す（`showNew`）と、新しい項目を含めて更新する。
 * - 表示中の項目の内容（既読・メモの件数など）は、再取得の結果で、その場で更新する（行の位置・数は変えない）
 * - 自分の操作のあとの再取得（`refresh`）は、新しい項目を含めて更新する
 * - 絞り込み・ページが変わったとき（`scopeKey` が変わる）、取得に失敗して一覧がなくなったときは、保った一覧を捨てて、新しく読み込んだものを示す
 */

import { useCallback, useState } from 'react';

export interface HoldNewItems<Page> {
  /** 表示する一覧（読み込み中・失敗中は undefined）。 */
  readonly shown: Page | undefined;
  /** 表示中の一覧にない、新しい項目の件数。 */
  readonly newCount: number;
  /** 新しい項目を含めて、最新の内容に更新する。 */
  readonly showNew: () => void;
  /** すぐに取得し直し、取得できたら、新しい項目を含めて更新する（自分の操作のあと）。 */
  readonly refresh: () => void;
}

interface Held<Page> {
  readonly scopeKey: string;
  readonly page: Page;
}

/**
 * @param latest 最新の取得結果（`usePolling` の data）
 * @param scopeKey 一覧の範囲（絞り込み・ページ）。変わったら、保った一覧を捨てる
 * @param polling `usePolling` の `reload` と `version`（取得が完了した回数）
 */
export function useHoldNewItems<Item, Page extends { readonly items: readonly Item[] }>(
  latest: Page | undefined,
  scopeKey: string,
  idOf: (item: Item) => string,
  polling: { readonly reload: () => void; readonly version: number },
): HoldNewItems<Page> {
  const [held, setHeld] = useState<Held<Page> | undefined>(undefined);
  // 自分の操作のあとの取得: この回数より後に完了した取得で、更新する
  const [adoptAfter, setAdoptAfter] = useState<number | undefined>(undefined);

  // 保った一覧の置き換え（描画の中で、条件つきで状態を更新する）
  const adoptNow = held?.scopeKey !== scopeKey;
  const adoptAfterRefresh = adoptAfter !== undefined && polling.version > adoptAfter;
  if (latest === undefined) {
    if (held !== undefined) {
      setHeld(undefined);
    }
  } else if (adoptNow || adoptAfterRefresh) {
    setHeld({ scopeKey, page: latest });
    if (adoptAfterRefresh) {
      setAdoptAfter(undefined);
    }
  }

  const showNew = useCallback(() => {
    if (latest !== undefined) {
      setHeld({ scopeKey, page: latest });
    }
  }, [latest, scopeKey]);
  const { reload, version } = polling;
  const refresh = useCallback(() => {
    setAdoptAfter(version);
    reload();
  }, [reload, version]);

  if (latest === undefined || held?.scopeKey !== scopeKey) {
    return { shown: latest, newCount: 0, showNew, refresh };
  }
  const latestById = new Map(latest.items.map((item) => [idOf(item), item]));
  const heldIds = new Set(held.page.items.map(idOf));
  const shown: Page = {
    ...held.page,
    items: held.page.items.map((item) => latestById.get(idOf(item)) ?? item),
  };
  return {
    shown,
    newCount: latest.items.filter((item) => !heldIds.has(idOf(item))).length,
    showNew,
    refresh,
  };
}
