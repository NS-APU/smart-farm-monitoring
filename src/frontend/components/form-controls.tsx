/**
 * フォームの部品: ラベルと入力欄とエラーの組（Field）、確認のダイアログ（ConfirmDialog）、ページ送り（Pager）。
 * エラーは、入力欄に関連づけて（aria-describedby）、色だけに頼らず文字で示す（NFR-7.2）。
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MESSAGES } from '../i18n/messages.ts';

export interface FieldControlProps {
  readonly id: string;
  readonly 'aria-invalid': boolean;
  readonly 'aria-describedby': string | undefined;
}

export interface FieldProps {
  readonly label: string;
  /** 項目名（テスト・エラーの対応づけ用）。 */
  readonly name: string;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly required?: boolean;
  readonly children: (control: FieldControlProps) => ReactNode;
}

export function Field(props: FieldProps): ReactNode {
  const id = useId();
  const messageId = `${id}-message`;
  const hasMessage = props.error !== undefined || props.hint !== undefined;
  return (
    <div
      className={`field${props.error === undefined ? '' : ' field-invalid'}`}
      data-field={props.name}
    >
      <label htmlFor={id}>
        {props.label}
        {props.required === true ? (
          <span className="required-mark" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      {props.children({
        id,
        'aria-invalid': props.error !== undefined,
        'aria-describedby': hasMessage ? messageId : undefined,
      })}
      {props.error === undefined ? null : (
        <p id={messageId} className="field-error">
          {props.error}
        </p>
      )}
      {props.error === undefined && props.hint !== undefined ? (
        <p id={messageId} className="field-hint">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

export interface ConfirmDialogProps {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** ダイアログの中で、Tab で移動できる要素。 */
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)';

/**
 * 取り消しにくい操作（削除など）の確認。キャンセルが先に選ばれる。
 * キーボード・スクリーンリーダーの利用者が、背景の操作を誤らないよう、Tab をダイアログの中で循環させ、
 * Esc でキャンセルし、閉じたときは、開く前にフォーカスのあった要素へ戻す（V-149）。
 */
export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // 開く前にフォーカスのあった要素。キャンセルへの最初のフォーカス（autoFocus）より前の、最初の描画のときに控える
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  // 閉じて（本当に外れて）から、開く前の要素へフォーカスを戻す。開発ビルドの StrictMode は、効果をいったん解除して再実行するが、
  // そのときは、ダイアログがまだ画面にあるため、戻さない（戻すと、最初のフォーカス（キャンセル）が、背景のボタンに奪われる）
  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      if (dialog?.isConnected !== true) {
        opener?.focus();
      }
    };
  }, [opener]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      props.onCancel();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dialog-backdrop">
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- ダイアログのキーボード操作（Esc・Tab の循環）を、ダイアログ全体で受ける */}
      <div
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="confirm-dialog"
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId}>{props.title}</h2>
        <p>{props.message}</p>
        <div className="dialog-actions">
          <button
            type="button"
            className="button-secondary"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- 取り消しにくい操作の確認では、安全な側（キャンセル）に最初のフォーカスを置く
            autoFocus
            onClick={props.onCancel}
          >
            {MESSAGES.form.cancel}
          </button>
          <button
            type="button"
            className="button-danger"
            disabled={props.busy === true}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface PagerProps {
  readonly pageNumber: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  /** ページ番号の要素のテスト ID（同じ画面に複数あるときや、既存の識別子を保つときに指定する）。 */
  readonly pageTestId?: string;
}

export function Pager(props: PagerProps): ReactNode {
  return (
    <div className="pager">
      <button
        type="button"
        className="button-secondary"
        disabled={!props.hasPrevious}
        onClick={props.onPrevious}
      >
        {MESSAGES.viewpoint.previousPage}
      </button>
      <span className="muted" data-testid={props.pageTestId ?? 'pager-page'}>
        {props.pageNumber}
      </span>
      <button
        type="button"
        className="button-secondary"
        disabled={!props.hasNext}
        onClick={props.onNext}
      >
        {MESSAGES.viewpoint.nextPage}
      </button>
    </div>
  );
}

/** 画面全体のエラー（保存の失敗など）。 */
export function FormError(props: { readonly message: string | undefined }): ReactNode {
  return props.message === undefined ? null : (
    <p role="alert" className="form-error">
      {props.message}
    </p>
  );
}

/** 権限がない操作の案内（画面の表示制御。サーバー側でも拒否する）。 */
export function PermissionNotice(props: { readonly message: string }): ReactNode {
  return (
    <p className="notice notice-info" role="status" data-testid="permission-notice">
      {props.message}
    </p>
  );
}
