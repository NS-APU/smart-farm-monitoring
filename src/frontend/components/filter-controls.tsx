/** 一覧の絞り込み・並べ替えの入力欄（ラベルつき）。条件の変更は、呼び出し側が URL のクエリに反映する。 */

import { useId, type ReactNode } from 'react';
import { MESSAGES } from '../i18n/messages.ts';

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export function SelectFilter(props: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly FilterOption[];
  /** 指定すると、先頭に「すべて」（値は空）の選択肢を加える。 */
  readonly withAll?: boolean;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <select
        id={id}
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      >
        {props.withAll === true ? <option value="">{MESSAGES.form.all}</option> : null}
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function InputFilter(props: {
  readonly label: string;
  readonly value: string;
  readonly type?: 'search' | 'text' | 'date';
  readonly onChange: (value: string) => void;
}): ReactNode {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      />
    </div>
  );
}

/** 並べ替えの向き（降順・昇順）の選択肢。 */
export const DIRECTION_OPTIONS: readonly FilterOption[] = [
  { value: 'desc', label: MESSAGES.form.directionDesc },
  { value: 'asc', label: MESSAGES.form.directionAsc },
];
