/**
 * 共通のレイアウト（サイドメニュー + 上部のバー）の単体テスト。
 * 狭い幅（900px 以下）では、メニューを、☰ で開閉する引き出しにする（ui-design-guidelines.md 8 章）。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResponse } from '@smart-farm/shared/schemas/auth';
import { App } from '../../../src/frontend/app.tsx';
import {
  WORKER_LOGIN,
  createFakeFetch,
  createMemorySession,
  dashboard,
  equipmentTree,
  jsonResponse,
} from '../../support/frontend.ts';
import { withBaseRoutes } from '../../support/management-frontend.ts';

/** 画面の幅が、狭い（matches = true）・広い（false）ことにする。 */
function stubViewport(narrow: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: narrow,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

function renderApp(unread = 0, login: LoginResponse = WORKER_LOGIN) {
  const routes = withBaseRoutes({
    'GET /equipment': () => jsonResponse(equipmentTree()),
    'GET /dashboard': () => jsonResponse(dashboard()),
    'GET /notifications/unread-count': () => jsonResponse({ unreadCount: unread }),
    'GET /notifications': () =>
      jsonResponse({ items: [], nextCursor: null, asOf: '2026-10-09T01:00:00.000Z' }),
  });
  const { fetchFn } = createFakeFetch(routes);
  return render(<App session={createMemorySession(login)} fetchFn={fetchFn} />);
}

/** 要素が存在することを確かめて、その要素を返す（存在しなければ、テストを失敗させる）。 */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('テストの前提: 要素がある');
  }
  return value;
}

const FOCUSABLE = 'a[href], button:not([disabled]), summary, select:not([disabled])';

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.classList.remove('menu-open');
});

describe('共通のレイアウト', () => {
  it('メニューは、本文より前にあり、「通知」の項目と件数の印は、メニュー（nav）にない（通知は、ヘッダーから開く。Issue #351）', async () => {
    renderApp(3);
    const menu = await screen.findByRole('navigation', { name: 'メニュー' });
    await screen.findByRole('heading', { name: '安全性' });

    // メニューの中のリンクは、7 つの項目だけ（Issue #353 で「通知の設定」をユーザーメニューへ移した）（名前は、文字のみ）。「通知」はない
    expect(within(menu).getAllByRole('link')).toHaveLength(7);
    expect(within(menu).queryByRole('link', { name: '通知' })).toBeNull();
    expect(menu.querySelector('.nav-badge')).toBeNull();
    const main = must(document.getElementById('main'));
    expect(menu.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('ヘッダーの通知のアイコンに、未読の件数のバッジ（読み上げの対象外）を重ね、リンクの名前は、実際の件数を示す', async () => {
    renderApp(3);
    await screen.findByRole('heading', { name: '安全性' });

    const link = await screen.findByRole('link', { name: '未読の通知: 3件' });
    expect(link.getAttribute('href')).toBe('/notifications');
    const badge = within(link).getByTestId('unread-count');
    await waitFor(() => {
      expect(badge.textContent).toBe('3');
    });
    expect(badge.hasAttribute('hidden')).toBe(false);
    expect(badge.getAttribute('aria-hidden')).toBe('true');
  });

  it('未読が 0 件のときは、バッジを表示せず（ベルだけ）、リンクの名前は 0 件を示す', async () => {
    renderApp(0);
    await screen.findByRole('heading', { name: '安全性' });

    const link = await screen.findByRole('link', { name: '未読の通知: 0件' });
    const badge = within(link).getByTestId('unread-count');
    expect(badge.hasAttribute('hidden')).toBe(true);
    expect(badge.textContent).toBe('0');
  });

  it.each([
    [99, '99'],
    [100, '99+'],
    [105, '99+'],
  ])(
    '未読が %i 件のとき、バッジの表示は「%s」（リンクの名前は、実際の件数）',
    async (unread, shown) => {
      renderApp(unread);
      await screen.findByRole('heading', { name: '安全性' });

      const link = await screen.findByRole('link', { name: `未読の通知: ${String(unread)}件` });
      await waitFor(() => {
        expect(within(link).getByTestId('unread-count').textContent).toBe(shown);
      });
    },
  );

  it('通知の画面にいる間は、ヘッダーの通知のリンクが、現在の画面を示す（メニューに「通知」がないため）', async () => {
    renderApp(2);
    const link = await screen.findByRole('link', { name: '未読の通知: 2件' });
    expect(link.getAttribute('aria-current')).toBeNull();

    fireEvent.click(link);

    await screen.findByRole('heading', { name: '通知' });
    expect(link.getAttribute('aria-current')).toBe('page');
  });

  it('ヘッダーの右端は、ユーザーメニュー（テーマの切り替えも、その中）。テーマだけのボタンは、置かない（Issue #353）', async () => {
    renderApp(1);
    const header = await screen.findByRole('banner');

    const user = await within(header).findByRole('button', { name: /^ログイン中のユーザー/ });
    const notifications = within(header).getByRole('link', { name: /^未読の通知/ });

    expect(within(header).queryByRole('button', { name: /^テーマ/ })).toBeNull();
    // 通知のアイコンの後ろ（右端）にある
    expect(
      notifications.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('「設定」は、開閉できるまとまりで、既定では開いている。中は、設定の 4 項目（「通知の設定」は、ヘッダーのユーザーメニューへ移した。Issue #353）', async () => {
    renderApp();
    const menu = await screen.findByRole('navigation', { name: 'メニュー' });

    const group = menu.querySelector('details');
    expect(group?.open).toBe(true);
    expect(group?.querySelector('summary')?.textContent).toBe('設定');
    expect(Array.from(group?.querySelectorAll('a') ?? []).map((link) => link.textContent)).toEqual([
      '設備',
      '取り込み',
      'ステータスコード',
      'ユーザー',
    ]);
  });

  it('一般（手動入力の権限だけ）には、権限のない「ユーザー」を表示しない。「取り込み」は、閲覧できるハウスの記録として表示する（#332）', async () => {
    renderApp(0, {
      ...WORKER_LOGIN,
      user: { ...WORKER_LOGIN.user, permissions: ['manual-entry:write'] },
    });
    const menu = await screen.findByRole('navigation', { name: 'メニュー' });

    const group = menu.querySelector('details');
    expect(Array.from(group?.querySelectorAll('a') ?? []).map((link) => link.textContent)).toEqual([
      '設備',
      '取り込み',
      'ステータスコード',
    ]);
  });

  it('現在の画面の項目に、aria-current を付ける', async () => {
    renderApp();
    const menu = await screen.findByRole('navigation', { name: 'メニュー' });

    expect(menu.querySelector('[aria-current="page"]')?.textContent).toBe('ダッシュボード');
  });
});

describe('狭い幅の、メニューの引き出し', () => {
  it('開く操作（☰）を持ち、開いたとき、aria-expanded が変わり、フォーカスが引き出しの中に移る', async () => {
    stubViewport(true);
    renderApp();
    await screen.findByRole('heading', { name: '安全性' });
    const toggle = screen.getByRole('button', { name: 'メニューを開く' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('app-sidebar');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });
    const sidebar = must(document.getElementById('app-sidebar'));
    expect(sidebar.contains(document.activeElement)).toBe(true);
    expect(document.querySelector('.app-shell')?.classList.contains('menu-is-open')).toBe(true);
    expect(document.body.classList.contains('menu-open')).toBe(true);
  });

  it('Esc で閉じ、フォーカスを ☰ に戻す', async () => {
    stubViewport(true);
    renderApp();
    await screen.findByRole('heading', { name: '安全性' });
    const toggle = screen.getByRole('button', { name: 'メニューを開く' });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });
    expect(document.activeElement).toBe(toggle);
    expect(document.body.classList.contains('menu-open')).toBe(false);
  });

  it('閉じるボタンと、引き出しの外（本文を覆う面）を押しても閉じ、フォーカスを ☰ に戻す', async () => {
    stubViewport(true);
    renderApp();
    await screen.findByRole('heading', { name: '安全性' });
    const toggle = screen.getByRole('button', { name: 'メニューを開く' });

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'メニューを閉じる' }));
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });
    fireEvent.click(must(document.querySelector('.menu-scrim')));
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });
  });

  it('メニューの項目を選んで画面を移動すると、引き出しを閉じる', async () => {
    stubViewport(true);
    renderApp();
    await screen.findByRole('heading', { name: '安全性' });
    const toggle = screen.getByRole('button', { name: 'メニューを開く' });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'メニュー' })).getByRole('link', {
        name: '取り込み済みデータ',
      }),
    );

    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });
  });

  it('Tab の移動を、引き出しの中に閉じ込める（最後の次は最初、最初の前は最後）', async () => {
    stubViewport(true);
    renderApp();
    await screen.findByRole('heading', { name: '安全性' });
    fireEvent.click(screen.getByRole('button', { name: 'メニューを開く' }));
    const sidebar = must(document.getElementById('app-sidebar'));
    await waitFor(() => {
      expect(sidebar.contains(document.activeElement)).toBe(true);
    });
    const items = Array.from(sidebar.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = must(items.at(0));
    const last = must(items.at(-1));

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('広い幅では、引き出しの操作（フォーカスの移動・Esc の処理）を行わない', async () => {
    stubViewport(false);
    renderApp();
    await screen.findByRole('heading', { name: '安全性' });
    const toggle = screen.getByRole('button', { name: 'メニューを開く' });

    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: 'Escape' });

    // 広い幅は、メニューが常に見える。引き出しの状態は、出さない
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.app-shell')?.classList.contains('menu-is-open')).toBe(false);
    expect(document.body.classList.contains('menu-open')).toBe(false);
  });
});
