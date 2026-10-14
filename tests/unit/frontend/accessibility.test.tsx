/**
 * アクセシビリティ・表示の改善（レビュー V-149・V-151・V-154・V-163・V-173・V-182）の単体テスト。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/frontend/app.tsx';
import { ConfirmDialog } from '../../../src/frontend/components/form-controls.tsx';
import {
  WORKER_LOGIN,
  createFakeFetch,
  createMemorySession,
  dashboard,
  equipmentTree,
  errorResponse,
  jsonResponse,
} from '../../support/frontend.ts';
import { withBaseRoutes } from '../../support/management-frontend.ts';
import { detail } from '../../support/viewpoint-fixtures.ts';

describe('確認のダイアログ（V-149）', () => {
  function Host(props: { onConfirm?: () => void }): ReactNode {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          削除する
        </button>
        {open ? (
          <ConfirmDialog
            title="削除しますか"
            message="取り消せません"
            confirmLabel="削除"
            onConfirm={props.onConfirm ?? (() => undefined)}
            onCancel={() => {
              setOpen(false);
            }}
          />
        ) : null}
      </div>
    );
  }

  function open() {
    render(<Host />);
    const opener = screen.getByRole('button', { name: '削除する' });
    opener.focus();
    fireEvent.click(opener);
    return opener;
  }

  it('開くと、キャンセルにフォーカスがある。Esc でキャンセルし、フォーカスを、開く前のボタンへ戻す', () => {
    const opener = open();

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'キャンセル' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('開発ビルド（StrictMode。効果を、いったん解除して再実行する）でも、開くと、キャンセルにフォーカスがあり、背景のボタンへ戻らない', () => {
    render(
      <StrictMode>
        <Host />
      </StrictMode>,
    );
    const opener = screen.getByRole('button', { name: '削除する' });
    opener.focus();

    fireEvent.click(opener);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'キャンセル' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
  });

  it('Tab は、ダイアログの中で循環する（最後から最初へ、Shift+Tab で最初から最後へ）。背景へ移らない', () => {
    open();
    const dialog = screen.getByRole('alertdialog');
    const cancel = screen.getByRole('button', { name: 'キャンセル' });
    const confirm = screen.getByRole('button', { name: '削除' });

    confirm.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    // 途中の要素では、既定の動作に任せる（フォーカスを動かさない）
    cancel.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(dialog, { key: 'a' });
    expect(screen.getByRole('alertdialog')).toBeDefined();
  });

  it('実行中（確認のボタンが押せない）でも、Tab の循環は、押せる要素だけを対象にする', () => {
    render(
      <ConfirmDialog
        title="t"
        message="m"
        confirmLabel="削除"
        busy
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const cancel = screen.getByRole('button', { name: 'キャンセル' });

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Tab' });

    expect(document.activeElement).toBe(cancel);
  });
});

describe('フォーカスの表示（V-151）', () => {
  const css = readFileSync(
    resolve(import.meta.dirname, '../../../src/frontend/styles/app.css'),
    'utf8',
  );

  function colorOf(name: string): string {
    const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
    if (match?.[1] === undefined) {
      throw new Error(`色が見つかりません: ${name}`);
    }
    return match[1];
  }

  /** WCAG の相対輝度。 */
  function luminance(hex: string): number {
    const [red = 0, green = 0, blue = 0] = [1, 3, 5].map((index) => {
      const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }

  function contrast(first: string, second: string): number {
    const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
  }

  it('フォーカスの枠の色は、白の面・ページの背景の双方に対して、3:1 以上のコントラスト（WCAG 1.4.11）', () => {
    const focus = colorOf('color-focus');

    expect(contrast(focus, colorOf('color-surface'))).toBeGreaterThanOrEqual(3);
    expect(contrast(focus, colorOf('color-bg'))).toBeGreaterThanOrEqual(3);
  });

  it('フォーカスの枠は、色のトークンを使い、内側に白い縁取りを付ける（濃い背景でも、位置が分かる）', () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--color-focus\)/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*box-shadow:\s*0 0 0 2px var\(--color-surface\)/);
  });
});

describe('画面のタイトル・見出し・通知の件数（V-154・V-163・V-173・V-182）', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/');
    document.title = '稼働モニタリング';
  });

  function renderApp(options: { unread?: () => number; detailError?: boolean } = {}) {
    const routes = withBaseRoutes({
      'GET /equipment': () => jsonResponse(equipmentTree()),
      'GET /dashboard': () => jsonResponse(dashboard()),
      'GET /notifications/unread-count': () =>
        jsonResponse({ unreadCount: options.unread?.() ?? 0 }),
      'GET /viewpoints/environmentalAdaptability': () =>
        options.detailError === true
          ? errorResponse(404, 'NOT_FOUND', '観点が見つかりません')
          : jsonResponse(detail()),
    });
    const { fetchFn } = createFakeFetch(routes);
    return render(<App session={createMemorySession(WORKER_LOGIN)} fetchFn={fetchFn} />);
  }

  it('タブのタイトルを、本文の見出しに合わせる。画面を移動すると、移動先の見出しに変わる', async () => {
    renderApp();
    await screen.findByRole('heading', { name: '安全性' });
    expect(document.title).toBe('ダッシュボード - 稼働モニタリング');

    fireEvent.click(screen.getByRole('link', { name: '通知' }));

    await waitFor(() => {
      expect(document.title).toBe('通知 - 稼働モニタリング');
    });
  });

  it('観点の詳細は、観点の名称（状態のバッジの文字は含めない）をタイトルにする', async () => {
    window.history.pushState(null, '', '/viewpoints/environmentalAdaptability');
    renderApp();

    await waitFor(() => {
      expect(document.title).toBe('環境適応性 - 稼働モニタリング');
    });
  });

  it('ダッシュボードに、観点の一覧の見出し（h2）がある。件数の意味は、見えない文字で補う', async () => {
    renderApp();

    await screen.findByRole('heading', { name: '安全性' });

    expect(screen.getByRole('heading', { level: 2, name: '観点ごとの状態' })).toBeDefined();
    expect(screen.getByTestId('summary-NORMAL').textContent).toContain('正常の観点の数');
  });

  it('評価しない観点（NOT_FOUND）を開いても、見出し・パンくずに、観点の名称を表示する', async () => {
    window.history.pushState(null, '', '/viewpoints/environmentalAdaptability');
    renderApp({ detailError: true });

    await screen.findByTestId('not-applicable');

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('環境適応性');
    expect(document.title).toBe('環境適応性 - 稼働モニタリング');
  });

  it('未読の通知が増えたときだけ、「新しい通知が N 件あります」を、読み上げ領域に出す', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let unread = 0;
      const { container } = renderApp({ unread: () => unread });
      await screen.findByRole('heading', { name: '安全性' });
      const region = container.querySelector('[aria-live="polite"]');
      expect(region?.textContent).toBe('');

      unread = 3;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await waitFor(() => {
        expect(region?.textContent).toBe('新しい通知が3件あります');
      });

      unread = 1;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await waitFor(() => {
        expect(region?.textContent).toBe('');
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
