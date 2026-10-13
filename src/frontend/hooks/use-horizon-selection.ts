/**
 * 視点（短期・長期）と期間の選択を、URL のクエリで保持する（再読み込み・画面の移動でも保たれる。
 * functional-specification.md 1.2「一覧」と同じ方針）。
 */

import { useCallback } from 'react';
import type { Horizon, PeriodDays } from '@smart-farm/shared/constants/status';
import { horizonQueryString, readHorizonQuery } from '../components/horizon-controls.tsx';
import { navigate, useLocation } from '../router/router.tsx';

export interface HorizonSelection {
  readonly horizon: Horizon;
  readonly periodDays: PeriodDays;
  readonly setHorizon: (horizon: Horizon) => void;
  readonly setPeriodDays: (periodDays: PeriodDays) => void;
}

export function useHorizonSelection(): HorizonSelection {
  const { pathname, search } = useLocation();
  const { horizon, periodDays } = readHorizonQuery(search);
  const setHorizon = useCallback(
    (next: Horizon) => {
      navigate(`${pathname}?${horizonQueryString(next, periodDays)}`, { replace: true });
    },
    [pathname, periodDays],
  );
  const setPeriodDays = useCallback(
    (next: PeriodDays) => {
      navigate(`${pathname}?${horizonQueryString(horizon, next)}`, { replace: true });
    },
    [pathname, horizon],
  );
  return { horizon, periodDays, setHorizon, setPeriodDays };
}
