/**
 * ヘルプヒント（「?」。Issue #154。ui-design-guidelines.md 8 章）。指標名・入力欄のラベルの横に置き、押すと、説明を開く。
 * - タップ・クリック・キーボード（Tab で届き、Enter・Space で開閉）で操作できる。`title` 属性（ホバーのみ）には、頼らない
 * - 開く: aria-expanded・aria-controls。ボタンの名前は、表示の「?」ではなく、「{対象}の説明」（読み上げ用の文字。aria-label にしない
 *   ＝ ラベルで入力欄を探す操作〔getByLabel など〕に、ボタンが混ざらない）
 * - 閉じる: もう一度押す・Esc（ボタンにフォーカスを残す。ダイアログの中でも、ヒントだけを閉じ、ダイアログは閉じない）・外側を押す（タップする）・
 *   フォーカスが外へ移る。同時に開くのは 1 つ（別のヒントを押すと、先のものは閉じる）
 * - 説明の位置は、ボタンの下。画面の幅（余白 8px）からはみ出す分だけ、ずらす（スマートフォンの狭い幅。transform ではなく left でずらす: transform では、ページの横スクロールが残る）
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { MESSAGES } from '../i18n/messages.ts';

const VIEWPORT_MARGIN_PX = 8;

export interface HelpTerm {
  readonly term: string;
  readonly description: string;
}

export interface HelpHintProps {
  /** 説明する対象の名前（ボタンの名前「{対象}の説明」になる）。 */
  readonly name: string;
  /** 意味の説明。 */
  readonly help: string;
  /** 入力例（任意）。 */
  readonly example?: string | undefined;
  /** 用語と説明の組（任意。カテゴリの一覧など）。 */
  readonly terms?: readonly HelpTerm[] | undefined;
}

export function HelpHint(props: HelpHintProps): ReactNode {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);

  // 開いたとき、画面の幅からはみ出す分だけ、位置をずらす
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || panel === null) {
      return;
    }
    panel.style.left = '';
    const rect = panel.getBoundingClientRect();
    if (rect.width === 0) {
      return;
    }
    const shift =
      Math.max(0, VIEWPORT_MARGIN_PX - rect.left) -
      Math.max(0, rect.right - (window.innerWidth - VIEWPORT_MARGIN_PX));
    if (shift !== 0) {
      panel.style.left = `${String(shift)}px`;
    }
  }, [open]);

  // 外側を押した（タップした）ら、閉じる。iOS の Safari でも届くように、pointerdown を使う
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: Event): void => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    // 開いているときだけ、Esc を受ける（閉じているときの Esc は、外側のダイアログなどに任せる）
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }
  };

  // Tab などで、外へフォーカスが移ったら、閉じる
  const onBlur = (event: FocusEvent<HTMLButtonElement>): void => {
    if (open && !wrapperRef.current?.contains(event.relatedTarget)) {
      setOpen(false);
    }
  };

  return (
    <span ref={wrapperRef} className="help-hint" data-testid="help-hint">
      <button
        ref={buttonRef}
        type="button"
        className="help-hint-button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          setOpen((value) => !value);
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      >
        <span className="help-hint-mark" aria-hidden="true">
          ?
        </span>
        <span className="visually-hidden">{MESSAGES.help.hintLabel(props.name)}</span>
      </button>
      {open ? (
        <span
          ref={panelRef}
          id={panelId}
          role="note"
          className="help-hint-panel"
          data-testid="help-hint-panel"
        >
          <span className="help-hint-text">{props.help}</span>
          {props.example === undefined ? null : (
            <span className="help-hint-example">
              {MESSAGES.help.example}: {props.example}
            </span>
          )}
          {props.terms === undefined
            ? null
            : props.terms.map((item) => (
                <span key={item.term} className="help-hint-term">
                  <strong>{item.term}</strong>: {item.description}
                </span>
              ))}
        </span>
      ) : null}
    </span>
  );
}
