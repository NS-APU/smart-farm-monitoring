/**
 * フォームを入れるダイアログ（Issue #364・#365・#366）。設定の画面の、登録・修正・割り当てを、画面の中ではなく、ダイアログで行う。
 * - `role="dialog"` `aria-modal`。見出し（h2）で名前を付ける
 * - 開いたら、最初の入力欄（なければ閉じるボタン）にフォーカスを移す。Tab の移動を中に閉じ込め、Esc で閉じる。閉じたら、開いた要素へフォーカスを戻す
 * - 開いている間は、背面（本文）のスクロールを止める
 * - 背面（スクリーン）の押下では閉じない（入力途中の内容を、誤って失わないため）。閉じるのは、✕・Esc・フォームのキャンセル
 * 取り消しにくい操作の確認は、`ConfirmDialog`（form-controls.tsx）を使う。
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MESSAGES } from '../i18n/messages.ts';
import { Icon } from './icon.tsx';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 本文の入力欄（最初にフォーカスを置く）。 */
const FIELD = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

export interface ModalProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** 試験・E2E 用の識別子。 */
  readonly testId?: string;
  /** 幅。既定は標準（640px）。表を入れるものは広め（880px）。 */
  readonly size?: 'standard' | 'wide';
}

export function Modal(props: ModalProps): ReactNode {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // 開く前にフォーカスのあった要素。最初のフォーカスの移動（下の効果）より前の、最初の描画のときに控える
  // （開発ビルドの StrictMode は、効果を 2 回実行する。2 回目に控えると、1 回目が移したフォーカス〔ダイアログの中〕を、控えてしまう）
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  // 閉じる処理は、親が毎回作り直すため、最新のものを参照する（キーボードの購読を、張り直さない）
  const onCloseRef = useRef(props.onClose);
  useEffect(() => {
    onCloseRef.current = props.onClose;
  });

  useEffect(() => {
    const dialogNode = dialogRef.current;
    (bodyRef.current?.querySelector<HTMLElement>(FIELD) ?? closeRef.current)?.focus();
    document.body.classList.add('modal-open');
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      const dialog = dialogRef.current;
      if (event.key !== 'Tab' || dialog === null) {
        return;
      }
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items.at(0);
      const last = items.at(-1);
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('modal-open');
      // 開発ビルドの StrictMode は、効果をいったん解除して再実行する。そのときは、ダイアログが画面にあるため、戻さない
      if (dialogNode?.isConnected !== true) {
        opener?.focus();
      }
    };
  }, [opener]);

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className={`modal${props.size === 'wide' ? ' modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={props.testId ?? 'modal'}
      >
        <div className="modal-head">
          <h2 id={titleId}>{props.title}</h2>
          <button
            ref={closeRef}
            type="button"
            className="modal-close"
            aria-label={MESSAGES.form.close}
            onClick={props.onClose}
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        <div ref={bodyRef} className="modal-body">
          {props.children}
        </div>
      </div>
    </div>
  );
}
