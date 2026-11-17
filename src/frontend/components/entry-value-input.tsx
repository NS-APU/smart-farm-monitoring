/**
 * データ入力（SC-06）の、数値の項目の入力（Issue #361）。数値の欄と、スライダーが連動し、範囲の目安と単位を示す。
 * 数値の欄が入力の本体（ラベル・ヒント〔入力できる値の説明〕・エラー・検証は、これまでどおり）で、スライダーは、目安の範囲での調整の補助。
 * 目安を超える値は、数値の欄に入力でき（保存できる上限までは）、スライダーの範囲が、その値を含むように広がる。
 * 範囲の目安は、shared の entry-ranges.ts（仮の値）。保存できる範囲（最小・手動入力の上限）は、超えない。
 */

import type { ReactNode } from 'react';
import { manualMaxOf, type ItemDefinition } from '@smart-farm/shared/constants/items';
import { findEntrySliderRange } from '@smart-farm/shared/constants/entry-ranges';
import type { ThresholdSliderRange } from '@smart-farm/shared/constants/criteria-ranges';
import { MESSAGES } from '../i18n/messages.ts';
import type { FieldControlProps } from './form-controls.tsx';
import { normalizeNumberText } from './number-text.ts';
import { extendSliderRange, sliderValueText } from './threshold-slider.ts';

const TEXT = MESSAGES.entry;

export interface EntryValueInputProps {
  readonly control: FieldControlProps;
  readonly item: ItemDefinition;
  /** 入力欄の文字。 */
  readonly text: string;
  readonly onChange: (text: string) => void;
}

/** 入力欄の文字を、数値として読む。空欄・読めない文字は NaN。 */
function toNumber(text: string): number {
  const normalized = normalizeNumberText(text);
  return normalized === '' ? Number.NaN : Number(normalized);
}

/** 保存できる範囲（最小・手動入力の上限）の中に、スライダーの範囲を収める。 */
function withinLimits(range: ThresholdSliderRange, item: ItemDefinition): ThresholdSliderRange {
  const limitMax = manualMaxOf(item);
  return {
    min: item.min === undefined ? range.min : Math.max(range.min, item.min),
    max: limitMax === undefined ? range.max : Math.min(range.max, limitMax),
    step: range.step,
  };
}

export function EntryValueInput(props: EntryValueInputProps): ReactNode {
  const { item, text } = props;
  const base = findEntrySliderRange(item.itemKey);
  const value = toNumber(text);
  const valid = Number.isFinite(value);
  const range =
    base === undefined ? undefined : withinLimits(extendSliderRange(base, [value]), item);
  return (
    <div className="threshold-input">
      <div className="threshold-controls">
        {range === undefined ? null : (
          <input
            type="range"
            className="threshold-slider"
            aria-label={`${item.label}${MESSAGES.criteria.sliderSuffix}`}
            aria-valuetext={valid ? `${String(value)}${item.unit}` : TEXT.sliderEmpty}
            min={range.min}
            max={range.max}
            step={range.step}
            value={valid ? Math.min(Math.max(value, range.min), range.max) : range.min}
            onChange={(event) => {
              props.onChange(sliderValueText(Number(event.target.value), range.step));
            }}
          />
        )}
        <input
          {...props.control}
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        />
      </div>
      {range === undefined ? null : (
        <p className="threshold-meta muted" data-testid="entry-slider-meta">
          <span>
            {MESSAGES.criteria.rangeHint}: {String(range.min)}〜{String(range.max)}
            {item.unit}
          </span>
        </p>
      )}
    </div>
  );
}
