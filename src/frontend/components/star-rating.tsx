/**
 * スターで選ぶ入力（満足度。SC-06。D-18）。1〜max の整数を、ラジオのグループとして選ぶ。
 * キーボード（矢印キー・Tab）とスクリーンリーダーは、ラジオの標準の操作に従う。エラーは、グループに関連づけて、色だけに頼らず文字で示す（NFR-7.2）。
 */

import { useId, type ReactNode } from 'react';
import { MESSAGES } from '../i18n/messages.ts';
import { Icon } from './icon.tsx';

export interface StarRatingProps {
  readonly label: string;
  /** 項目名（エラーの対応づけ・テスト用。Field と同じ data-field）。 */
  readonly name: string;
  /** スターの上限（1〜この値）。 */
  readonly max: number;
  /** 選んだ値。未選択なら undefined。 */
  readonly value: number | undefined;
  readonly error?: string | undefined;
  readonly onChange: (value: number) => void;
}

export function StarRating(props: StarRatingProps): ReactNode {
  const id = useId();
  const labelId = `${id}-label`;
  const messageId = `${id}-message`;
  const selected = props.value ?? 0;
  return (
    <div
      className={`field star-field${props.error === undefined ? '' : ' field-invalid'}`}
      data-field={props.name}
    >
      <span id={labelId} className="star-label">
        {props.label}
      </span>
      <div
        role="radiogroup"
        className="star-rating"
        aria-labelledby={labelId}
        aria-invalid={props.error !== undefined}
        aria-describedby={props.error === undefined ? undefined : messageId}
        // 入力の検証に失敗したとき、最初のエラーの項目へフォーカスを移せるようにする（フォームの V-150）
        tabIndex={-1}
      >
        {Array.from({ length: props.max }, (_, index) => index + 1).map((stars) => (
          <label key={stars} className={`star${stars <= selected ? ' star-on' : ''}`}>
            <input
              type="radio"
              className="visually-hidden"
              name={id}
              value={stars}
              checked={props.value === stars}
              onChange={() => {
                props.onChange(stars);
              }}
            />
            <span aria-hidden="true">{stars <= selected ? '★' : '☆'}</span>
            <span className="visually-hidden">{MESSAGES.entry.starOption(stars)}</span>
          </label>
        ))}
      </div>
      {props.error === undefined ? null : (
        <p id={messageId} className="field-error">
          <Icon name="status-error" size={14} />
          {props.error}
        </p>
      )}
    </div>
  );
}
