/**
 * 判断基準の閾値の入力（SC-13。Issue #358）。スライダーと数値の欄が連動し、範囲の目安・単位・現在値と変更後の値を示す。
 * 数値の欄が入力の本体（ラベル・エラー・検証は、これまでどおり）で、スライダーは、目安の範囲での調整の補助。
 * 保存できる値の範囲は、スライダーの範囲ではない（範囲外の値は、数値の欄に入力でき、スライダーの範囲が広がる）。
 */

import type { ReactNode } from 'react';
import type { ThresholdSliderRange } from '@smart-farm/shared/constants/criteria-ranges';
import { MESSAGES } from '../i18n/messages.ts';
import type { FieldControlProps } from './form-controls.tsx';
import { sliderValueText } from './threshold-slider.ts';

const TEXT = MESSAGES.criteria;

export interface ThresholdInputProps {
  readonly control: FieldControlProps;
  /** スライダーの名前に使う、閾値の短い名前（例: 注意下限）。数値の欄のラベルを含めない（同じラベルが 2 つにならないように）。 */
  readonly shortLabel: string;
  readonly unit: string;
  readonly range: ThresholdSliderRange;
  /** 入力欄の文字。 */
  readonly text: string;
  /** 入力欄の文字を数値として読んだ値（読めなければ NaN）。 */
  readonly value: number;
  /** 保存されている値（現在値）。 */
  readonly savedValue: number;
  readonly editable: boolean;
  readonly onChange: (text: string) => void;
}

function withUnit(value: number, unit: string): string {
  return `${String(value)}${unit}`;
}

export function ThresholdInput(props: ThresholdInputProps): ReactNode {
  const { range, value, savedValue, unit } = props;
  const valid = Number.isFinite(value);
  const sliderValue = valid ? Math.min(Math.max(value, range.min), range.max) : range.min;
  const changed = valid && value !== savedValue;
  return (
    <div className="threshold-input">
      <div className="threshold-controls">
        <input
          type="range"
          className="threshold-slider"
          aria-label={`${props.shortLabel}${TEXT.sliderSuffix}`}
          aria-valuetext={valid ? withUnit(value, unit) : TEXT.notANumber}
          min={range.min}
          max={range.max}
          step={range.step}
          value={sliderValue}
          disabled={!props.editable}
          onChange={(event) => {
            props.onChange(sliderValueText(Number(event.target.value), range.step));
          }}
        />
        <input
          {...props.control}
          inputMode="decimal"
          autoComplete="off"
          value={props.text}
          readOnly={!props.editable}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        />
      </div>
      <p className="threshold-meta muted" data-testid="threshold-meta">
        <span>
          {TEXT.rangeHint}: {withUnit(range.min, unit)}〜{withUnit(range.max, unit)}
        </span>
        <span>
          {TEXT.currentValue}: {withUnit(savedValue, unit)}
        </span>
        <span className={changed ? 'threshold-changed' : undefined}>
          {TEXT.afterValue}: {valid ? withUnit(value, unit) : '—'}
          {valid && !changed ? `（${TEXT.unchanged}）` : ''}
        </span>
      </p>
    </div>
  );
}
