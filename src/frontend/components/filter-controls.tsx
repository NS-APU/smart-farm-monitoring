/** 一覧の絞り込み・並べ替えの入力欄（ラベルつき）と、絞り込みの枠（条件の数・クリア・折りたたみ）。条件の変更は、呼び出し側が URL のクエリに反映する。 */

import { useId, useState, type ReactNode } from 'react';
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

/**
 * 絞り込みの枠（Issue #152 の PR1）。項目（`children`）を、絞り込みの並び（filter-bar）に置き、枠の上に、適用中の条件の数と、
 * 条件のクリア（初期値に戻す）を示す。狭い幅（900px 以下）では、項目を折りたたみ、開閉のボタンで開く
 * （折りたたんでも、条件の数とクリアは見える。広い幅では、開閉のボタンを出さず、常に開く。CSS）。
 * 条件の数・クリアの中身（どの条件が初期値でないか・何を戻すか）は、呼び出し側が決める（条件は URL のクエリに反映する）。
 */
export function FilterPanel(props: {
  /** 適用中の条件の数（初期値と違う条件）。 */
  readonly activeCount: number;
  readonly onClear: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="filter-panel" data-open={open ? 'true' : 'false'}>
      <div className="filter-panel-head">
        <button
          type="button"
          className="button-secondary filter-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen((current) => !current);
          }}
        >
          {open ? MESSAGES.form.filterClose : MESSAGES.form.filterOpen}
        </button>
        {props.activeCount === 0 ? null : (
          <span className="filter-count" data-testid="filter-active-count" aria-live="polite">
            {MESSAGES.form.activeConditions(props.activeCount)}
          </span>
        )}
        <button
          type="button"
          className="button-secondary filter-clear"
          disabled={props.activeCount === 0}
          onClick={props.onClear}
        >
          {MESSAGES.form.clearConditions}
        </button>
      </div>
      <div id={bodyId} className="filter-bar filter-body">
        {props.children}
      </div>
    </div>
  );
}
