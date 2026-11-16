/**
 * ヘッダーのテーマのメニュー（システム・ライト・ダーク。Issue #352）の単体テスト。
 * 選ぶとすぐ切り替わり、設定は、この端末のブラウザに保存される。キーボードでも操作でき、現在の設定が分かる。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeMenu } from '../../../src/frontend/components/theme-menu.tsx';
import { THEME_STORAGE_KEY } from '../../../src/frontend/lib/theme.ts';

const root = document.documentElement;

beforeEach(() => {
  window.localStorage.clear();
  root.removeAttribute('data-theme');
});

afterEach(() => {
  window.localStorage.clear();
  root.removeAttribute('data-theme');
});

function button(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

function openMenu(name = 'テーマ: システム'): HTMLElement {
  fireEvent.click(button(name));
  return screen.getByRole('menu', { name: 'テーマ' });
}

describe('テーマのメニュー: 表示と現在の設定', () => {
  it('既定は「システム」。ボタンの名前に、現在の設定を示し、メニューは閉じている', () => {
    render(<ThemeMenu />);

    const trigger = button('テーマ: システム');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('開くと、システム（既定）・ライト・ダークの 3 項目を示し、現在の設定にチェックが付く', () => {
    render(<ThemeMenu />);

    const menu = openMenu();

    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['システム（既定）', 'ライト', 'ダーク']);
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(button('テーマ: システム').getAttribute('aria-expanded')).toBe('true');
  });

  it.each([
    ['light', 'テーマ: ライト', 1],
    ['dark', 'テーマ: ダーク', 2],
  ])(
    '保存された設定（%s）を、起動時に読み、現在の設定として示す',
    (stored, label, checkedIndex) => {
      window.localStorage.setItem(THEME_STORAGE_KEY, stored);
      render(<ThemeMenu />);

      const items = within(openMenu(label)).getAllByRole('menuitemradio');

      expect(items[checkedIndex]?.getAttribute('aria-checked')).toBe('true');
    },
  );

  it('保存された値が不正なときは、システムとして扱う', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'blue');
    render(<ThemeMenu />);

    expect(button('テーマ: システム')).toBeDefined();
  });
});

describe('テーマのメニュー: 選ぶと、すぐ切り替わり、設定が保存される', () => {
  it.each([
    ['ダーク', 'dark', 'テーマ: ダーク'],
    ['ライト', 'light', 'テーマ: ライト'],
  ])(
    '「%s」を選ぶと、data-theme が %s になり、保存され、メニューが閉じて、ボタンが現在の設定を示す',
    (item, value, label) => {
      render(<ThemeMenu />);
      const menu = openMenu();

      fireEvent.click(within(menu).getByRole('menuitemradio', { name: item }));

      expect(root.getAttribute('data-theme')).toBe(value);
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(value);
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(button(label));
    },
  );

  it('「システム（既定）」を選ぶと、data-theme を外し（ブラウザの設定に従う）、システムを保存する', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    root.setAttribute('data-theme', 'dark');
    render(<ThemeMenu />);
    const menu = openMenu('テーマ: ダーク');

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'システム（既定）' }));

    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(button('テーマ: システム')).toBeDefined();
  });

  it('選んだ設定は、画面を作り直しても（再読み込みを模す）、保たれる', () => {
    const first = render(<ThemeMenu />);
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: 'ダーク' }));
    first.unmount();

    render(<ThemeMenu />);

    expect(button('テーマ: ダーク')).toBeDefined();
  });
});

describe('テーマのメニュー: キーボードと、閉じ方', () => {
  it('Esc で閉じ、ボタンにフォーカスが戻る', () => {
    render(<ThemeMenu />);
    openMenu();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button('テーマ: システム'));
  });

  it('メニューの外を押すと、設定を変えずに閉じる', () => {
    render(
      <div>
        <ThemeMenu />
        <p>外側</p>
      </div>,
    );
    openMenu();

    fireEvent.mouseDown(screen.getByText('外側'));

    expect(screen.queryByRole('menu')).toBeNull();
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('開くと、現在の設定の項目にフォーカスがあり、↑↓・Home・End で、項目を移れる（端で折り返す）', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    render(<ThemeMenu />);
    const menu = openMenu('テーマ: ライト');
    const [system, light, dark] = within(menu).getAllByRole('menuitemradio');

    await waitFor(() => {
      expect(document.activeElement).toBe(light);
    });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(dark);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(system);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(dark);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(system);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(dark);
  });

  it('もう一度ボタンを押すと、閉じる', () => {
    render(<ThemeMenu />);
    openMenu();

    fireEvent.click(button('テーマ: システム'));

    expect(screen.queryByRole('menu')).toBeNull();
  });
});
