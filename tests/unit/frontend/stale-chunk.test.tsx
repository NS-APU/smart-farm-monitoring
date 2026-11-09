/**
 * 古い画面の部品（遅延読み込みのチャンク）の取得の失敗（Issue #323）のテスト。
 * デプロイのあと、ブラウザが古い画面を使い続けると、削除済みの画面の部品の取得に失敗する
 * （`Failed to fetch dynamically imported module`）。汎用の「画面を表示できませんでした」ではなく、
 * 「新しい版に更新されました。再読み込みしてください」と案内し、1 回だけ、自動で再読み込みする（繰り返さない）。
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ErrorBoundary } from '../../../src/frontend/components/error-boundary.tsx';
import {
  AUTO_RELOAD_INTERVAL_MS,
  AUTO_RELOAD_STORAGE_KEY,
  isChunkLoadError,
  pageReloader,
  tryAutoReload,
} from '../../../src/frontend/lib/page-reload.ts';

const CHROME_MESSAGE =
  'Failed to fetch dynamically imported module: https://example.invalid/assets/status-codes-page-AAAA.js';
const FIREFOX_MESSAGE = 'error loading dynamically imported module';
const SAFARI_MESSAGE = 'Importing a module script failed.';

describe('isChunkLoadError: 画面の部品（チャンク）の取得の失敗か', () => {
  it.each([
    ['Chrome・Edge', CHROME_MESSAGE],
    ['Firefox', FIREFOX_MESSAGE],
    ['Safari', SAFARI_MESSAGE],
  ])('%s の、動的 import の失敗のメッセージは、true', (_browser, message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it.each([
    ['ふつうの描画の例外', new Error('描画の失敗')],
    ['別の TypeError', new TypeError("Cannot read properties of undefined (reading 'map')")],
    ['文字列', 'Failed to fetch dynamically imported module'],
    ['null', null],
  ])('%s は、false', (_name, error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});

describe('tryAutoReload: 1 回だけ、自動で再読み込みする（繰り返さない）', () => {
  let reload: MockInstance<() => void>;

  beforeEach(() => {
    window.sessionStorage.clear();
    reload = vi.spyOn(pageReloader, 'reload').mockImplementation(() => undefined);
  });

  afterEach(() => {
    reload.mockRestore();
    vi.restoreAllMocks();
  });

  it('初回は、再読み込みして true。直後の 2 回目は、再読み込みせず false（読み込みを繰り返さない）', () => {
    expect(tryAutoReload(1_000_000)).toBe(true);
    expect(tryAutoReload(1_000_000 + 5_000)).toBe(false);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('前回から、一定の時間（60 秒）が過ぎていれば、もう一度、再読み込みする', () => {
    tryAutoReload(1_000_000);

    expect(tryAutoReload(1_000_000 + AUTO_RELOAD_INTERVAL_MS)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('ブラウザの保存領域（sessionStorage）が使えないときは、読み込みの繰り返しを避けるため、自動で再読み込みしない', () => {
    // 保存領域が無効な設定のブラウザでは、sessionStorage へのアクセス自体が、例外になる
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('使えません');
      },
    });
    try {
      expect(tryAutoReload(1_000_000)).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      if (original !== undefined) {
        Object.defineProperty(window, 'sessionStorage', original);
      }
    }
  });

  it('保存の値が壊れていても（数値でない）、初回として扱う', () => {
    window.sessionStorage.setItem(AUTO_RELOAD_STORAGE_KEY, 'broken');

    expect(tryAutoReload(1_000_000)).toBe(true);
  });
});

describe('エラーバウンダリ: 画面の部品の取得の失敗', () => {
  let reload: MockInstance<() => void>;
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    window.sessionStorage.clear();
    reload = vi.spyOn(pageReloader, 'reload').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    reload.mockRestore();
    consoleError.mockRestore();
  });

  function ChunkFailure(): ReactNode {
    throw new TypeError(CHROME_MESSAGE);
  }

  it('初回は、自動で再読み込みする。案内（新しい版に更新された）と、再読み込みのボタンを表示する', () => {
    render(
      <ErrorBoundary>
        <ChunkFailure />
      </ErrorBoundary>,
    );

    expect(reload).toHaveBeenCalledTimes(1);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('新しい版に更新されました');
    expect(alert.textContent).not.toContain('画面を表示できませんでした');
    expect(screen.getByRole('button', { name: '再読み込み' })).toBeDefined();
  });

  it('自動で再読み込みしたあとも、同じ失敗が続くときは、繰り返さず、案内とボタンだけを表示する。ボタンで再読み込みできる', () => {
    window.sessionStorage.setItem(AUTO_RELOAD_STORAGE_KEY, String(Date.now()));

    render(
      <ErrorBoundary>
        <ChunkFailure />
      </ErrorBoundary>,
    );

    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ふつうの描画の例外は、これまでどおり（「画面を表示できませんでした」。再読み込みはしない）', () => {
    function Broken(): ReactNode {
      throw new Error('描画の失敗');
    }

    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert').textContent).toContain('画面を表示できませんでした');
    expect(screen.queryByRole('button', { name: '再読み込み' })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});
