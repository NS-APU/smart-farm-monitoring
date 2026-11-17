/**
 * 視点（短期・長期）と期間の選択を、URL のクエリで保持する（再読み込み・画面の移動でも保たれる。
 * functional-specification.md 1.2「一覧」と同じ方針）。
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
  const setHorizon = useCallback(
    (next: Horizon) => {
      // 期間を選んでいなければ、視点を切り替えても、選んだことにしない
      navigate(`${pathname}?${horizonQueryString(next, selectedPeriodDays)}`, { replace: true });
    },
    [pathname, selectedPeriodDays],
  );
  const setPeriodDays = useCallback(
    (next: PeriodDays) => {
      navigate(`${pathname}?${horizonQueryString(horizon, next)}`, { replace: true });
    },
    [pathname, horizon],
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
 * 古い URL の `horizon` は、読まず、期間を選んだときに外れる。
 */
export function usePeriodSelection(
  defaultPeriodDays: PeriodDays = DEFAULT_PERIOD_DAYS,
): PeriodSelection {
  const { pathname, search } = useLocation();
  const selectedPeriodDays = readPeriodQuery(search);
  const periodDays = selectedPeriodDays ?? defaultPeriodDays;
  const setPeriodDays = useCallback(
    (next: PeriodDays) => {
      const query = new URLSearchParams({ periodDays: String(next) }).toString();
      navigate(`${pathname}?${query}`, { replace: true });
    },
    [pathname],
  );
  return { periodDays, selectedPeriodDays, setPeriodDays };
}
