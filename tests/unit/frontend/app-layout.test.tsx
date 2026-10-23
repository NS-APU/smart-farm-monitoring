/**
 * 共通のレイアウト（サイドメニュー + 上部のバー）の単体テスト。
 * 狭い幅（900px 以下）では、メニューを、☰ で開閉する引き出しにする（ui-design-guidelines.md 8 章）。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function renderApp(unread = 0) {
  const routes = withBaseRoutes({
    'GET /equipment': () => jsonResponse(equipmentTree()),
    'GET /dashboard': () => jsonResponse(dashboard()),
    'GET /notifications/unread-count': () => jsonResponse({ unreadCount: unread }),
    'GET /notifications': () => jsonResponse({ items: [], nextCursor: null }),
  });
  const { fetchFn } = createFakeFetch(routes);
  return render(<App session={createMemorySession(WORKER_LOGIN)} fetchFn={fetchFn} />);
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
  it('メニューは、本文より前にあり、ブランドのリンクと件数の印は、メニュー（nav）の外に置く', async () => {
    renderApp(3);
    const menu = await screen.findByRole('navigation', { name: 'メニュー' });
    await screen.findByRole('heading', { name: '安全性' });

    // メニューの中のリンクは、9 つの項目だけ（名前は、文字のみ）
    expect(within(menu).getAllByRole('link')).toHaveLength(9);
    const main = must(document.getElementById('main'));
    expect(menu.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 未読の件数の印は、「通知」の項目の隣（リンクの外）。読み上げは、上部のリンクが担う
    await waitFor(() => {
      expect(menu.querySelector('.nav-badge')?.textContent).toBe('3');
    });
    expect(menu.querySelector('.nav-badge')?.getAttribute('aria-hidden')).toBe('true');
    expect(within(menu).getByRole('link', { name: '通知' }).textContent).toBe('通知');
  });

  it('未読が 0 件のときは、件数の印を表示しない', async () => {
    renderApp(0);
    const menu = await screen.findByRole('navigation', { name: 'メニュー' });
    await screen.findByRole('heading', { name: '安全性' });

    expect(menu.querySelector('.nav-badge')).toBeNull();
  });

  it('「設定」は、開閉できるまとまりで、既定では開いている。中は、設定の 5 項目', async () => {
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
      '通知の設定',
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
        name: '通知',
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
