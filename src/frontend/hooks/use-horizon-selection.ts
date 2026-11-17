/**
 * 視点（短期・長期）と期間の選択を、URL のクエリで保持する（再読み込み・画面の移動でも保たれる。
 * functional-specification.md 1.2「一覧」と同じ方針）。
 * 視点・期間以外のクエリ（ダッシュボードの、観点の詳細のドロワーを開く `viewpoint` など）は、切り替えても、消さずに引き継ぐ（Issue #357）。
 */

import { useCallback } from 'react';
import {
  DEFAULT_PERIOD_DAYS,
  type Horizon,
  type PeriodDays,
} from '@smart-farm/shared/constants/status';
import {
  horizonQueryString,
  readHorizonQuery,
  readPeriodQuery,
} from '../components/horizon-controls.tsx';
import { navigate, useLocation } from '../router/router.tsx';

/**
 * 自分が決めたクエリ（`own`）に、ほかのクエリを、そのまま足す（`owned` に挙げたキーは、自分が決めるため、引き継がない）。
 * 自分のクエリを先頭に置く（例: `?horizon=SHORT&periodDays=30&viewpoint=safety`）。
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

export interface HorizonSelection {
  readonly horizon: Horizon;
  /** 表示と取得に使う期間。選んでいなければ、既定の期間。 */
  readonly periodDays: PeriodDays;
  /** 利用者が選んだ期間（選んでいなければ undefined。観点ごとの既定の期間で評価する）。 */
  readonly selectedPeriodDays: PeriodDays | undefined;
  readonly setHorizon: (horizon: Horizon) => void;
  readonly setPeriodDays: (periodDays: PeriodDays) => void;
}

/**
 * @param defaultPeriodDays 期間を選んでいないときの期間（観点ごとの既定。満足度は 30 日、ほかは 7 日）。
 *   ダッシュボードは、観点が複数あるため、既定（7 日）を表示に使い、取得には、選んだ期間だけを送る。
 */
export function useHorizonSelection(
  defaultPeriodDays: PeriodDays = DEFAULT_PERIOD_DAYS,
): HorizonSelection {
  const { pathname, search } = useLocation();
  const { horizon, periodDays: selectedPeriodDays } = readHorizonQuery(search);
  const periodDays = selectedPeriodDays ?? defaultPeriodDays;
  const searchText = search.toString();
  const setHorizon = useCallback(
    (next: Horizon) => {
      // 期間を選んでいなければ、視点を切り替えても、選んだことにしない
      const query = queryWithOthers(
        horizonQueryString(next, selectedPeriodDays),
        new URLSearchParams(searchText),
        ['horizon', 'periodDays'],
      );
      navigate(`${pathname}?${query}`, { replace: true });
    },
    [pathname, searchText, selectedPeriodDays],
  );
  const setPeriodDays = useCallback(
    (next: PeriodDays) => {
      const query = queryWithOthers(
        horizonQueryString(horizon, next),
        new URLSearchParams(searchText),
        ['horizon', 'periodDays'],
      );
      navigate(`${pathname}?${query}`, { replace: true });
    },
    [pathname, searchText, horizon],
  );
  return { horizon, periodDays, selectedPeriodDays, setHorizon, setPeriodDays };
}

export interface PeriodSelection {
  /** 表示に使う期間。選んでいなければ、既定の期間。 */
  readonly periodDays: PeriodDays;
  /** 利用者が選んだ期間（選んでいなければ undefined。観点ごとの既定の期間で評価する）。 */
  readonly selectedPeriodDays: PeriodDays | undefined;
  readonly setPeriodDays: (periodDays: PeriodDays) => void;
}

/**
 * 期間だけの選択を、URL のクエリ（`periodDays`）で保持する（ダッシュボード。視点〔短期・長期〕は、ない。Issue #355）。
 * 古い URL の `horizon` は、読まず、期間を選んだときに外れる。ただし、観点の詳細のドロワーを開いている間（`viewpoint` がある間）は、
 * `horizon` は、ドロワーの視点なので、引き継ぐ（Issue #357）。
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
      const current = new URLSearchParams(searchText);
      const owned = current.has('viewpoint') ? ['periodDays'] : ['periodDays', 'horizon'];
      const query = queryWithOthers(
        new URLSearchParams({ periodDays: String(next) }).toString(),
        current,
        owned,
      );
      navigate(`${pathname}?${query}`, { replace: true });
    },
    [pathname, searchText],
  );
  return { periodDays, selectedPeriodDays, setPeriodDays };
}
