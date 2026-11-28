/**
 * 期間の選択を、URL のクエリで保持する（再読み込み・画面の移動でも保たれる。functional-specification.md 1.2「一覧」と同じ方針）。
 * 期間以外のクエリ（ダッシュボードの、観点の詳細のドロワーを開く `viewpoint` など）は、切り替えても、消さずに引き継ぐ（Issue #357）。
 */

import { useCallback } from 'react';
import { DEFAULT_PERIOD_DAYS, type PeriodDays } from '@smart-farm/shared/constants/status';
import { readPeriodQuery } from '../components/horizon-controls.tsx';
import { navigate, useLocation } from '../router/router.tsx';

/**
 * 自分が決めたクエリ（`own`）に、ほかのクエリを、そのまま足す（`owned` に挙げたキーは、自分が決めるため、引き継がない）。
 * 自分のクエリを先頭に置く（例: `?periodDays=30&viewpoint=safety`）。
 */
function queryWithOthers(own: string, search: URLSearchParams, owned: readonly string[]): string {
  const next = new URLSearchParams(own);
  search.forEach((value, key) => {
    if (!owned.includes(key)) {
      next.append(key, value);
    }
  });
  return next.toString();
}

export interface PeriodSelection {
  /** 表示に使う期間。選んでいなければ、既定の期間。 */
  readonly periodDays: PeriodDays;
  /** 利用者が選んだ期間（選んでいなければ undefined。観点ごとの既定の期間で評価する）。 */
  readonly selectedPeriodDays: PeriodDays | undefined;
  readonly setPeriodDays: (periodDays: PeriodDays) => void;
}

/**
 * 期間だけの選択を、URL のクエリ（`periodDays`）で保持する（ダッシュボード・観点の詳細。視点〔短期・長期〕の切り替えは、ない。
 * Issue #355・#591）。古い URL の `horizon` は、読まず、期間を選んだときに外れる。
 */
export function usePeriodSelection(
  defaultPeriodDays: PeriodDays = DEFAULT_PERIOD_DAYS,
): PeriodSelection {
  const { pathname, search } = useLocation();
  const selectedPeriodDays = readPeriodQuery(search);
  const periodDays = selectedPeriodDays ?? defaultPeriodDays;
  const searchText = search.toString();
  const setPeriodDays = useCallback(
    (next: PeriodDays) => {
      // 古い URL の `horizon` は、期間を選ぶときに外す（視点の切り替えは、ない）
      const query = queryWithOthers(
        new URLSearchParams({ periodDays: String(next) }).toString(),
        new URLSearchParams(searchText),
        ['periodDays', 'horizon'],
      );
      navigate(`${pathname}?${query}`, { replace: true });
    },
    [pathname, searchText],
  );
  return { periodDays, selectedPeriodDays, setPeriodDays };
}
