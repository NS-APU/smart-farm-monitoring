import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ItemDefinition } from '../../../src/shared/constants/items.ts';
import { EntryValueInput } from '../../../src/frontend/components/entry-value-input.tsx';

const CONTROL = { id: 'field-1', 'aria-invalid': false, 'aria-describedby': undefined } as const;

/** 範囲の目安・最小・上限を持たない項目（定義にない項目。数値の欄だけを出す）。 */
const PLAIN_ITEM: ItemDefinition = {
  itemKey: 'unlistedItem',
  category: 'FAILURE',
  label: '定義にない項目',
  unit: '件',
  valueType: 'number',
  aggregation: 'TOTAL',
  origins: ['MANUAL'],
};

/** 範囲の目安がある項目（湿度。保存できる範囲は 0〜100）。 */
const HUMIDITY: ItemDefinition = {
  itemKey: 'humidityPercent',
  category: 'ENVIRONMENT',
  label: '湿度',
  unit: '%',
  valueType: 'number',
  min: 0,
  max: 100,
  aggregation: 'LEVEL',
  origins: ['MANUAL'],
};

/** 範囲の目安があるが、最小・上限の指定がない項目（保存できる範囲の制限なし）。 */
const OPEN_RANGE: ItemDefinition = {
  itemKey: 'failureCount',
  category: 'FAILURE',
  label: '故障回数',
  unit: '回',
  valueType: 'integer',
  aggregation: 'TOTAL',
  origins: ['MANUAL'],
};

function renderInput(item: ItemDefinition, text: string, onChange = vi.fn()) {
  render(<EntryValueInput control={CONTROL} item={item} text={text} onChange={onChange} />);
  return onChange;
}

describe('データ入力の数値の項目（EntryValueInput。Issue #361）', () => {
  it('範囲の目安のない項目は、数値の欄だけを出す（スライダー・範囲の表示はない）', () => {
    const onChange = renderInput(PLAIN_ITEM, '5');

    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByTestId('entry-slider-meta')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '6' } });
    expect(onChange).toHaveBeenCalledWith('6');
  });

  it('最小・上限のない項目は、目安の範囲のまま（保存できる範囲で、狭めない）', () => {
    renderInput(OPEN_RANGE, '3');

    const slider = screen.getByRole<HTMLInputElement>('slider');
    expect([slider.min, slider.max]).toEqual(['0', '20']);
    expect(screen.getByTestId('entry-slider-meta').textContent).toBe('目安の範囲: 0〜20回');
  });

  it('保存できる範囲（最小・上限）の中に、スライダーの範囲を収める。目安を超える値でも、上限は超えない', () => {
    renderInput(HUMIDITY, '250');

    const slider = screen.getByRole<HTMLInputElement>('slider');
    expect([slider.min, slider.max, slider.value]).toEqual(['0', '100', '100']);
  });

  it('空欄・読めない文字は、スライダーを最小の位置にして、「未入力」と読み上げる。全角の数字は読む', () => {
    const { unmount } = render(
      <EntryValueInput control={CONTROL} item={HUMIDITY} text="" onChange={vi.fn()} />,
    );
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('未入力');
    unmount();

    render(<EntryValueInput control={CONTROL} item={HUMIDITY} text="６０" onChange={vi.fn()} />);
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('60%');
  });
});
