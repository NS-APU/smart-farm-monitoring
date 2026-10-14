import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// 非同期の待ち（waitFor・findBy）の上限。既定の1秒は、テスト全体の負荷が高いと、画面の更新が間に合わず、まれに失敗するため（V-101）、余裕を持たせる
configure({ asyncUtilTimeout: 5000 });

/**
 * ブラウザの保存領域（localStorage）の代わり。Node の実験的な localStorage が jsdom のものを隠すことがあるため、
 * テストごとに、空のメモリ上の実装に差し替える（テストを互いに独立させる）。
 */
function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => {
      data.clear();
    },
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
});

// コンポーネントのテストごとに、描画した内容を片付ける（テストを互いに独立させる）
afterEach(() => {
  cleanup();
});
