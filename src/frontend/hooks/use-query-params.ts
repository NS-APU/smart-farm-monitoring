/**
 * 一覧の絞り込み・並べ替えの条件を、URL のクエリで保持する（再読み込み・画面の移動でも保たれる。
 * functional-specification.md 1.2「一覧」）。値が空の条件は、クエリから外す。
 */

import { useCallback } from 'react';
import type { SortDirection } from '@smart-farm/shared/constants/sorting';
import { navigate, useLocation } from '../router/router.tsx';

export interface QueryParams {
  /** 条件の値。ない場合は、既定値（なければ空の文字列）。 */
  readonly get: (name: string, fallback?: string) => string;
  /** 条件を変更する。undefined・空の文字列は、その条件を外す。 */
  readonly set: (patch: Readonly<Record<string, string | undefined>>) => void;
}

export function useQueryParams(): QueryParams {
  const { pathname, search } = useLocation();
  const searchText = search.toString();

  const get = useCallback(
    (name: string, fallback = '') => new URLSearchParams(searchText).get(name) ?? fallback,
    [searchText],
  );
  const set = useCallback(
    (patch: Readonly<Record<string, string | undefined>>) => {
      const next = new URLSearchParams(searchText);
      for (const [name, value] of Object.entries(patch)) {
        if (value === undefined || value === '') {
          next.delete(name);
        } else {
          next.set(name, value);
        }
      }
      const text = next.toString();
      navigate(text === '' ? pathname : `${pathname}?${text}`, { replace: true });
    },
    [pathname, searchText],
  );
  return { get, set };
}

/** 並べ替えの向き。URL のクエリが asc のときだけ昇順、それ以外（未指定・未知の値）は降順。 */
export function readSortDirection(query: QueryParams): SortDirection {
  return query.get('direction') === 'asc' ? 'asc' : 'desc';
}

/** 並べ替えの項目と向き。項目は、候補にある値のときだけ使い、未指定・未知の値は既定の項目にする。 */
export function readSortParams<Key extends string>(
  query: QueryParams,
  keys: readonly Key[],
  defaultKey: Key,
): { readonly sort: Key; readonly direction: SortDirection } {
  return {
    sort: keys.find((value) => value === query.get('sort')) ?? defaultKey,
    direction: readSortDirection(query),
  };
}
