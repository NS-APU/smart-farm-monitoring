/** 視点（短期・長期）と、長期視点の期間（当日／直近7日／30日／60日／90日）の切り替え（FR-5.6）。 */

import type { ReactNode } from 'react';
import {
  DEFAULT_PERIOD_DAYS,
  PERIOD_DAYS_OPTIONS,
  type Horizon,
  type PeriodDays,
} from '@smart-farm/shared/constants/status';
import { MESSAGES } from '../i18n/messages.ts';

export interface HorizonControlsProps {
  readonly horizon: Horizon;
  readonly periodDays: PeriodDays;
  /** 視点の切り替え。指定しなければ、切り替えを出さない（満足度は、短期評価を持たない）。 */
  readonly onHorizonChange?: (horizon: Horizon) => void;
  readonly onPeriodChange: (periodDays: PeriodDays) => void;
}

export function HorizonControls(props: HorizonControlsProps): ReactNode {
  const { onHorizonChange } = props;
  return (
    <div className="horizon-controls">
      {onHorizonChange === undefined ? null : (
        <fieldset>
          <legend>{MESSAGES.dashboard.horizon}</legend>
          <label>
            <input
              type="radio"
              name="horizon"
              checked={props.horizon === 'SHORT'}
              onChange={() => {
                onHorizonChange('SHORT');
              }}
            />
            {MESSAGES.dashboard.horizonShort}
          </label>
          <label>
            <input
              type="radio"
              name="horizon"
              checked={props.horizon === 'LONG'}
              onChange={() => {
                onHorizonChange('LONG');
              }}
            />
            {MESSAGES.dashboard.horizonLong}
          </label>
        </fieldset>
      )}
      <label className="period-field">
        <span>{MESSAGES.dashboard.period}</span>
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

/** URL のクエリから、視点・期間を読む（不正な値は既定値）。 */
export function readHorizonQuery(search: URLSearchParams): {
  horizon: Horizon;
  periodDays: PeriodDays;
} {
  const periodDays = PERIOD_DAYS_OPTIONS.find((days) => days === Number(search.get('periodDays')));
  return {
    horizon: search.get('horizon') === 'SHORT' ? 'SHORT' : 'LONG',
    periodDays: periodDays ?? DEFAULT_PERIOD_DAYS,
  };
}

/** 視点・期間のクエリ文字列（既定値の長期・直近7日も明示する）。 */
export function horizonQueryString(horizon: Horizon, periodDays: PeriodDays): string {
  return new URLSearchParams({ horizon, periodDays: String(periodDays) }).toString();
}
