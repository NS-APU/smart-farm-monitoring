/** 期間（当日／直近7日／30日／60日／90日）の切り替え（FR-5.6）。視点（短期・長期）の切り替えは、ない（#591）。 */

import type { ReactNode } from 'react';
import {
  PERIOD_DAYS_OPTIONS,
  type Horizon,
  type PeriodDays,
} from '@smart-farm/shared/constants/status';
import { MESSAGES } from '../i18n/messages.ts';

export interface HorizonControlsProps {
  /** 評価の視点。視点の切り替えはないため、表示には使わない（呼び出し側が、取得に使う視点を、そろえて示すためだけに受ける）。 */
  readonly horizon: Horizon;
  readonly periodDays: PeriodDays;
  readonly onPeriodChange: (periodDays: PeriodDays) => void;
  /** 期間の欄の名前。指定しなければ「期間」。 */
  readonly periodLabel?: string;
}

export function HorizonControls(props: HorizonControlsProps): ReactNode {
  return (
    <div className="horizon-controls">
      <label className="period-field">
        <span>{props.periodLabel ?? MESSAGES.dashboard.period}</span>
        <select
          value={props.periodDays}
          onChange={(event) => {
            const selected = PERIOD_DAYS_OPTIONS.find(
              (days) => days === Number(event.target.value),
            );
            if (selected !== undefined) {
              props.onPeriodChange(selected);
            }
          }}
        >
          {PERIOD_DAYS_OPTIONS.map((days) => (
            <option key={days} value={days}>
              {MESSAGES.dashboard.periodDays[days]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** 期間のクエリ文字列。期間は、選んだときだけ付ける（選んでいなければ、観点ごとの既定の期間で評価する）。 */
export function periodQueryString(periodDays: PeriodDays | undefined): string {
  return periodDays === undefined
    ? ''
    : new URLSearchParams({ periodDays: String(periodDays) }).toString();
}

/** URL のクエリから、選んだ期間だけを読む（不正な値・指定なしは undefined）。 */
export function readPeriodQuery(search: URLSearchParams): PeriodDays | undefined {
  return PERIOD_DAYS_OPTIONS.find((days) => days === Number(search.get('periodDays')));
}
