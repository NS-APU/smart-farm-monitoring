/** 視点（短期・長期）と、長期視点の期間（当日／直近7日／30日／60日／90日）の切り替え（FR-5.6）。 */

import type { ReactNode } from 'react';
import {
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

/**
 * URL のクエリから、視点・期間を読む。視点の不正な値は長期。期間は、選んだ期間（不正な値・指定なしは undefined。
 * 選んでいなければ、観点ごとの既定の期間で評価する。満足度は 30 日、ほかは 7 日）。
 */
export function readHorizonQuery(search: URLSearchParams): {
  horizon: Horizon;
  periodDays: PeriodDays | undefined;
} {
  const periodDays = PERIOD_DAYS_OPTIONS.find((days) => days === Number(search.get('periodDays')));
  return {
    horizon: search.get('horizon') === 'SHORT' ? 'SHORT' : 'LONG',
    periodDays,
  };
}

/** 視点・期間のクエリ文字列（既定値の長期も明示する）。期間は、選んだときだけ付ける。 */
export function horizonQueryString(horizon: Horizon, periodDays: PeriodDays | undefined): string {
  return new URLSearchParams({
    horizon,
    ...(periodDays === undefined ? {} : { periodDays: String(periodDays) }),
  }).toString();
}
