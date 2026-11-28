/**
 * ヘッダーのユーザーメニュー（Issue #353。functional-specification.md 2.3・ui-design-guidelines.md 8 章）の単体テスト。
 * ユーザーアイコン・ユーザー名・ロールを 1 つのボタンにし、押すと、ユーザー名の変更・パスワードの変更・通知の設定・テーマ（システム・ライト・ダーク）・ログアウトを開く。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResponse } from '@smart-farm/shared/schemas/auth';
import { App } from '../../../src/frontend/app.tsx';
import { THEME_STORAGE_KEY } from '../../../src/frontend/lib/theme.ts';
import {
  WORKER_LOGIN,
  createFakeFetch,
  createMemorySession,
  dashboard,
  equipmentTree,
  jsonResponse,
} from '../../support/frontend.ts';
import { withBaseRoutes } from '../../support/management-frontend.ts';

function loginAs(role: string, userName = '農作業者A'): LoginResponse {
  return { ...WORKER_LOGIN, user: { ...WORKER_LOGIN.user, role, userName } };
}

function renderApp(login: LoginResponse = loginAs('admin')) {
  const routes = withBaseRoutes({
    'GET /equipment': () => jsonResponse(equipmentTree()),
    'GET /dashboard': () => jsonResponse(dashboard()),
    'GET /notifications/unread-count': () => jsonResponse({ unreadCount: 0 }),
  });
  const { fetchFn } = createFakeFetch(routes);
  return render(<App session={createMemorySession(login)} fetchFn={fetchFn} />);
}

async function findTrigger(name: RegExp | string = /^ログイン中のユーザー/): Promise<HTMLElement> {
  const header = await screen.findByRole('banner');
  return within(header).getByRole('button', { name });
}

async function openMenu(name?: RegExp | string): Promise<HTMLElement> {
  fireEvent.click(await findTrigger(name));
  return screen.findByRole('menu', { name: 'ユーザー' });
}

const root = document.documentElement;

/** メニューの全項目（リンク・テーマ・ログアウト）を、並びの順に返す。 */
function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  root.removeAttribute('data-theme');
  window.history.pushState(null, '', '/');
  // 狭い幅ではない（matchMedia は、jsdom にない。引き出しの動作は、app-layout.test.tsx が確認する）
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  root.removeAttribute('data-theme');
});

describe('ユーザーメニュー: 表示', () => {
  it.each([
    ['admin', '（管理者）'],
    ['general', '（一般）'],
  ])('ユーザー名の隣に、ロール（%s → %s）を示す', async (role, shown) => {
    renderApp(loginAs(role));

    const trigger = await findTrigger();

    expect(within(trigger).getByTestId('user-name').textContent).toBe('農作業者A');
    expect(within(trigger).getByTestId('user-role').textContent).toBe(shown);
  });

  it('知らないロールのときは、括弧を付けず、ユーザー名だけを示す', async () => {
    renderApp(loginAs('worker'));

    const trigger = await findTrigger();

    expect(within(trigger).getByTestId('user-name').textContent).toBe('農作業者A');
    expect(within(trigger).queryByTestId('user-role')).toBeNull();
    expect(trigger.getAttribute('aria-label')).toBe('ログイン中のユーザー: 農作業者A');
  });

  it('ボタンの名前は、ユーザー名とロールを含む（狭い幅で、文字を隠しても、読み上げられる）。メニューは、閉じている', async () => {
    renderApp(loginAs('admin'));

    const trigger = await findTrigger('ログイン中のユーザー: 農作業者A（管理者）');

    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('長いユーザー名（200 文字）でも、全文を、ボタンの名前とツールチップに持つ（見た目は、CSS で省略する）', async () => {
    const longName = 'あ'.repeat(200);
    renderApp(loginAs('general', longName));

    const trigger = await findTrigger();

    expect(trigger.getAttribute('aria-label')).toBe(`ログイン中のユーザー: ${longName}（一般）`);
    expect(trigger.getAttribute('title')).toBe(`${longName}（一般）`);
    expect(within(trigger).getByTestId('user-name').textContent).toBe(longName);
  });
});

describe('ユーザーメニュー: 項目と操作', () => {
  it('開くと、ユーザー名の変更・パスワードの変更・通知の設定（リンク）、テーマ（3 項目）、ログアウト（ボタン）を、この順に示す', async () => {
    renderApp();

    const menu = await openMenu();

    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'ユーザー名の変更',
      'パスワードの変更',
      '通知の設定',
      'ログアウト',
    ]);
    expect(items.map((item) => item.tagName)).toEqual(['A', 'A', 'A', 'BUTTON']);
    expect(items.slice(0, 3).map((item) => item.getAttribute('href'))).toEqual([
      '/profile',
      '/change-password',
      '/settings/push',
    ]);
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['システム（既定）', 'ライト', 'ダーク']);
    expect(menuItems(menu).map((item) => item.textContent)).toEqual([
      'ユーザー名の変更',
      'パスワードの変更',
      '通知の設定',
      'システム（既定）',
      'ライト',
      'ダーク',
      'ログアウト',
    ]);
    expect((await findTrigger()).getAttribute('aria-expanded')).toBe('true');
  });

  it.each([
    ['ユーザー名の変更', 'ユーザー名の変更'],
    ['パスワードの変更', 'パスワードの変更'],
    ['通知の設定', '通知の設定'],
  ])('「%s」を選ぶと、その画面へ移り、メニューを閉じる', async (item, heading) => {
    renderApp();
    const menu = await openMenu();

    fireEvent.click(within(menu).getByRole('menuitem', { name: item }));

    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeDefined();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('個人の設定の画面（通知の設定など）にいる間は、ユーザーのボタンと、メニューの該当の項目が、現在の画面を示す', async () => {
    window.history.pushState(null, '', '/settings/push');
    renderApp();
    const trigger = await findTrigger();
    await screen.findByRole('heading', { name: '通知の設定', level: 1 });
    expect(trigger.getAttribute('aria-current')).toBe('page');

    const menu = await openMenu();

    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.getAttribute('aria-current')),
    ).toEqual([null, null, 'page', null]);
  });

  it('ほかの画面（ダッシュボードなど）では、現在の画面を示さない', async () => {
    renderApp();
    const trigger = await findTrigger();

    expect(trigger.getAttribute('aria-current')).toBeNull();
  });
});

describe('ユーザーメニュー: キーボードと、閉じ方', () => {
  it('開くと、最初の項目にフォーカスがあり、↑↓・Home・End で、リンク・テーマ・ログアウトの全項目を移れる（端で折り返す）', async () => {
    renderApp();
    const menu = await openMenu();
    const [profile, password, push, system, , , logout] = menuItems(menu);

    await waitFor(() => {
      expect(document.activeElement).toBe(profile);
    });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(password);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(push);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(system);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(profile);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(logout);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(profile);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(logout);
  });

  it('Esc で閉じ、ボタンにフォーカスが戻る', async () => {
    renderApp();
    const menu = await openMenu();

    fireEvent.keyDown(menu, { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(await findTrigger());
  });

  it('メニューの外を押すと、閉じる。もう一度ボタンを押しても、閉じる', async () => {
    renderApp();
    await openMenu();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    await openMenu();
    fireEvent.click(await findTrigger());
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('ユーザーメニューの中のテーマ（Issue #352・#353）: 選ぶとすぐ切り替わり、設定が保存される', () => {
  it('テーマは、見出し「テーマ」のまとまりで、既定は「システム（既定）」にチェックが付く', async () => {
    renderApp();

    const menu = await openMenu();

    const group = within(menu).getByRole('group', { name: 'テーマ' });
    const items = within(group).getAllByRole('menuitemradio');
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
  });

  it.each([
    ['light', 1],
    ['dark', 2],
  ])('保存された設定（%s）を、起動時に読み、現在の設定として示す', async (stored, checkedIndex) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, stored);
    renderApp();

    const items = within(await openMenu()).getAllByRole('menuitemradio');

    expect(items[checkedIndex]?.getAttribute('aria-checked')).toBe('true');
    expect(root.getAttribute('data-theme')).toBe(stored);
  });

  it('保存された値が不正なときは、システムとして扱う', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'blue');
    renderApp();

    const items = within(await openMenu()).getAllByRole('menuitemradio');

    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it.each([
    ['ダーク', 'dark'],
    ['ライト', 'light'],
  ])(
    '「%s」を選ぶと、data-theme が %s になり、保存され、メニューが閉じて、ユーザーのボタンにフォーカスが戻る',
    async (item, value) => {
      renderApp();
      const menu = await openMenu();

      fireEvent.click(within(menu).getByRole('menuitemradio', { name: item }));

      expect(root.getAttribute('data-theme')).toBe(value);
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(value);
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(await findTrigger());
    },
  );

  it('「システム（既定）」を選ぶと、data-theme を外し（ブラウザの設定に従う）、システムを保存する', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    renderApp();
    const menu = await openMenu();

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'システム（既定）' }));

    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('選んだ設定は、画面を作り直しても（再読み込みを模す）、保たれる', async () => {
    const first = renderApp();
    fireEvent.click(within(await openMenu()).getByRole('menuitemradio', { name: 'ダーク' }));
    first.unmount();
    root.removeAttribute('data-theme');

    renderApp();
    const items = within(await openMenu()).getAllByRole('menuitemradio');

    expect(items[2]?.getAttribute('aria-checked')).toBe('true');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });
});
