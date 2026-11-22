/**
 * パスワード欄の共通部品（`PasswordInput`。Issue #157 の SC-01-4）の単体テスト。
 * 表示切替（aria-pressed・aria-label・既定は非表示）と、Caps Lock の注意（キー入力で確認・読み上げ）を確かめる。
 * ブラウザでの Caps Lock の状態は、再現できないため、`getModifierState` に答えるキーイベント（`modifierCapsLock`）で確かめる。
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { PasswordInput } from '../../../src/frontend/components/password-input.tsx';
import { MESSAGES } from '../../../src/frontend/i18n/messages.ts';
import { at } from '../../support/management-frontend.ts';

const TEXT = MESSAGES.passwordInput;

function Host(): ReactNode {
  const [value, setValue] = useState('');
  return (
    <form>
      <label htmlFor="pw">パスワード</label>
      <PasswordInput
        id="pw"
        name="password"
        autoComplete="current-password"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
      <button type="submit">送信</button>
    </form>
  );
}

/** Caps Lock の状態（`getModifierState('CapsLock')` の答え）を指定したキーイベントを送る。 */
function press(element: HTMLElement, type: 'keyDown' | 'keyUp', capsLock: boolean, key = 'a') {
  fireEvent[type](element, { key, modifierCapsLock: capsLock });
}

function input(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('パスワード');
}

/** Caps Lock の注意の領域（読み上げ用の領域。常に置き、注意があるときだけ、中身を入れる）。 */
function notice(): HTMLElement {
  return screen.getByTestId('caps-lock-notice');
}

function toggle(): HTMLElement {
  return screen.getByRole('button', { name: TEXT.toggle });
}

describe('パスワード欄の部品: 表示切替', () => {
  it('既定は、非表示（type=password）で、切替のボタンは、押されていない（aria-pressed=false）', () => {
    render(<Host />);

    expect(input().type).toBe('password');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('切替のボタンは、type=button（フォームを送信しない）で、読み上げ用の名前（aria-label）を持つ', () => {
    render(<Host />);

    expect(toggle().getAttribute('type')).toBe('button');
    expect(toggle().getAttribute('aria-label')).toBe(TEXT.toggle);
  });

  it('切替のボタンの名前に「パスワード」を含めない（欄のラベルでの検索を、重複させない）', () => {
    expect(TEXT.toggle).not.toContain('パスワード');
    render(<Host />);

    expect(screen.getAllByLabelText('パスワード', { exact: false })).toHaveLength(1);
  });

  it('押すと、パスワードを表示（type=text）し、aria-pressed=true になる。もう一度押すと、非表示に戻る', () => {
    render(<Host />);
    fireEvent.change(input(), { target: { value: 'Dummy-Passw0rd-1' } });

    fireEvent.click(toggle());

    expect(input().type).toBe('text');
    expect(input().value).toBe('Dummy-Passw0rd-1');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(toggle());

    expect(input().type).toBe('password');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('切り替えても、ボタンの名前は変わらない（状態は aria-pressed で伝える）', () => {
    render(<Host />);

    fireEvent.click(toggle());

    expect(toggle().getAttribute('aria-label')).toBe(TEXT.toggle);
  });

  it('表示にしても、スペルチェック・自動の大文字化を無効にする', () => {
    render(<Host />);

    fireEvent.click(toggle());

    expect(input().getAttribute('spellcheck')).toBe('false');
    expect(input().getAttribute('autocapitalize')).toBe('off');
  });

  it('2 つの欄は、それぞれ独立して切り替わる', () => {
    render(
      <>
        <label htmlFor="a">現在</label>
        <PasswordInput id="a" value="" onChange={() => undefined} />
        <label htmlFor="b">新しい</label>
        <PasswordInput id="b" value="" onChange={() => undefined} />
      </>,
    );
    const toggles = screen.getAllByRole('button', { name: TEXT.toggle });

    fireEvent.click(at(toggles, 0));

    expect(screen.getByLabelText<HTMLInputElement>('現在').type).toBe('text');
    expect(screen.getByLabelText<HTMLInputElement>('新しい').type).toBe('password');
  });
});

describe('パスワード欄の部品: Caps Lock の注意', () => {
  it('初めは、注意を出さない。注意の領域は、読み上げ用に（aria-live=polite）、常に置く', () => {
    render(<Host />);

    expect(notice().textContent).toBe('');
    expect(notice().getAttribute('aria-live')).toBe('polite');
  });

  it('Caps Lock がオンで、キーを押すと、注意を示す（読み上げ用の領域に入る）', () => {
    render(<Host />);

    press(input(), 'keyDown', true);

    expect(notice().textContent).toContain(TEXT.capsLockOn);
  });

  it('Caps Lock がオフのキー入力では、注意を出さない', () => {
    render(<Host />);

    press(input(), 'keyDown', false);

    expect(notice().textContent).toBe('');
  });

  it('Caps Lock をオフにして、キーを離すと、注意が消える', () => {
    render(<Host />);
    press(input(), 'keyDown', true);

    press(input(), 'keyUp', false, 'CapsLock');

    expect(notice().textContent).toBe('');
  });

  it('Caps Lock のキー自体で、オンになったときも、注意を示す', () => {
    render(<Host />);

    press(input(), 'keyDown', true, 'CapsLock');

    expect(notice().textContent).toContain(TEXT.capsLockOn);
  });

  it('欄から離れると、注意を消す（別の欄・画面で、注意が残らない）', () => {
    render(<Host />);
    press(input(), 'keyDown', true);

    fireEvent.blur(input());

    expect(notice().textContent).toBe('');
  });

  it('欄をクリックしたとき、Caps Lock がオンなら、注意を示す（フォーカスの時点の確認）', () => {
    render(<Host />);

    fireEvent.mouseDown(input(), { modifierCapsLock: true });

    expect(notice().textContent).toContain(TEXT.capsLockOn);
  });

  it('パスワードを表示にしているときも、注意を示す', () => {
    render(<Host />);
    fireEvent.click(toggle());

    press(input(), 'keyDown', true);

    expect(notice().textContent).toContain(TEXT.capsLockOn);
  });

  it('注意は、文字で示す（色だけに頼らない）', () => {
    expect(TEXT.capsLockOn).toMatch(/Caps Lock/);
  });

  it('呼び出し側が渡した onKeyDown・onBlur も、実行する', () => {
    const calls: string[] = [];
    render(
      <>
        <label htmlFor="pw2">パスワード</label>
        <PasswordInput
          id="pw2"
          value=""
          onChange={() => undefined}
          onKeyDown={() => calls.push('keydown')}
          onBlur={() => calls.push('blur')}
        />
      </>,
    );
    const field = screen.getByLabelText('パスワード');

    press(field, 'keyDown', false);
    fireEvent.blur(field);

    expect(calls).toEqual(['keydown', 'blur']);
  });
});
