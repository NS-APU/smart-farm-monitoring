/**
 * パスワード欄の共通部品（Issue #157 の SC-01-4）。ログイン・パスワードの変更・ユーザーの登録／再設定の入力欄に使う。
 * - 表示切替: 既定は非表示。目のボタンで、入力した文字を表示・非表示にする（`aria-pressed`。名前は変えない）。
 * - Caps Lock の注意: Caps Lock がオンのまま入力しようとしているとき、欄の近くに、文字で示す（色だけに頼らない）。
 *   ブラウザは、フォーカスの時点では、状態を教えないため、キーの入力（押下・離す）と、欄のクリックで確かめる。欄から離れたら消す。
 * ラベル・エラーとの関連づけ（`id`・`aria-*`）は、呼び出し側が、そのまま渡す（`Field` の control など）。
 */

import {
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { MESSAGES } from '../i18n/messages.ts';
import { Icon } from './icon.tsx';

const TEXT = MESSAGES.passwordInput;

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export function PasswordInput(props: PasswordInputProps): ReactNode {
  const { onKeyDown, onKeyUp, onMouseDown, onBlur, ...inputProps } = props;
  const [isVisible, setIsVisible] = useState(false);
  const [isCapsLockOn, setIsCapsLockOn] = useState(false);

  return (
    <div className="password-field">
      <div className="password-input">
        <input
          {...inputProps}
          type={isVisible ? 'text' : 'password'}
          // 表示にしても、候補・自動の大文字化・スペルチェックの下線を出さない（入力の内容を、別の機能へ渡さない）
          spellCheck={false}
          autoCapitalize="off"
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            setIsCapsLockOn(event.getModifierState('CapsLock'));
            onKeyDown?.(event);
          }}
          onKeyUp={(event: KeyboardEvent<HTMLInputElement>) => {
            setIsCapsLockOn(event.getModifierState('CapsLock'));
            onKeyUp?.(event);
          }}
          onMouseDown={(event: MouseEvent<HTMLInputElement>) => {
            setIsCapsLockOn(event.getModifierState('CapsLock'));
            onMouseDown?.(event);
          }}
          onBlur={(event) => {
            setIsCapsLockOn(false);
            onBlur?.(event);
          }}
        />
        <button
          type="button"
          className="password-toggle button-secondary"
          aria-label={TEXT.toggle}
          aria-pressed={isVisible}
          title={TEXT.toggle}
          onClick={() => {
            setIsVisible((visible) => !visible);
          }}
        >
          <Icon name={isVisible ? 'eye-off' : 'eye'} size={18} />
        </button>
      </div>
      {/* 読み上げ用の領域は、中身が現れる前から置く（あとから置いた領域は、読み上げられないことがある） */}
      <div className="password-caps-notice" aria-live="polite" data-testid="caps-lock-notice">
        {isCapsLockOn ? (
          <>
            <Icon name="info" size={14} />
            {TEXT.capsLockOn}
          </>
        ) : null}
      </div>
    </div>
  );
}
