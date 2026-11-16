/**
 * テーマ（システム・ライト・ダーク）の設定の読み書きと適用（Issue #352。ui-design-guidelines.md）。
 * 初期表示用のスクリプト（public/theme-init.js。描画の前に実行して、色のちらつきを防ぐ）が、アプリ本体（lib/theme.ts）と
 * 同じ保存先・同じ値を使うことも確認する。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  applyThemePreference,
  parseThemePreference,
  readThemePreference,
  saveThemePreference,
} from '../../../src/frontend/lib/theme.ts';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    data,
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error('アクセスできません');
  },
  setItem: () => {
    throw new Error('アクセスできません');
  },
};

describe('テーマの設定の読み取り（不正な値は、システム）', () => {
  it.each([
    ['system', 'system'],
    ['light', 'light'],
    ['dark', 'dark'],
  ])('保存された値 %s は、そのまま使う', (stored, expected) => {
    expect(parseThemePreference(stored)).toBe(expected);
  });

  it.each([null, undefined, '', 'Dark', 'LIGHT', 'blue', ' dark', '{"theme":"dark"}'])(
    '不正な値（%j）は、システムにする',
    (stored) => {
      expect(parseThemePreference(stored)).toBe('system');
    },
  );
});

describe('テーマの設定の保存（ブラウザの保存領域。この端末だけ）', () => {
  it('保存した値を、読み取れる', () => {
    const storage = fakeStorage();

    saveThemePreference(storage, 'dark');

    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark');
    expect(readThemePreference(storage)).toBe('dark');
  });

  it('保存がないときは、システム', () => {
    expect(readThemePreference(fakeStorage())).toBe('system');
  });

  it('保存領域が使えない（undefined・アクセスの例外）ときも、例外にせず、システムとして動く', () => {
    expect(readThemePreference(undefined)).toBe('system');
    expect(readThemePreference(throwingStorage)).toBe('system');
    expect(() => {
      saveThemePreference(undefined, 'light');
    }).not.toThrow();
    expect(() => {
      saveThemePreference(throwingStorage, 'light');
    }).not.toThrow();
  });
});

describe('テーマの適用（html 要素の data-theme）', () => {
  it('ライト・ダークは、data-theme に設定する。システムは、data-theme を外す（ブラウザの設定に従う）', () => {
    const root = document.createElement('html');

    applyThemePreference(root, 'dark');
    expect(root.getAttribute('data-theme')).toBe('dark');

    applyThemePreference(root, 'light');
    expect(root.getAttribute('data-theme')).toBe('light');

    applyThemePreference(root, 'system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});

describe('初期表示用のスクリプト（public/theme-init.js）', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../src/frontend/public/theme-init.js'),
    'utf8',
  );

  /** スクリプトを、ブラウザの `document`・`localStorage` を模した環境で実行する。 */
  function run(localStorage: unknown): ReturnType<typeof vi.fn> {
    const setAttribute = vi.fn();
    const context: Record<string, unknown> = {
      document: { documentElement: { setAttribute } },
    };
    Object.defineProperty(context, 'localStorage', {
      get: () => {
        if (localStorage instanceof Error) {
          throw localStorage;
        }
        return localStorage;
      },
    });
    runInNewContext(source, context);
    return setAttribute;
  }

  it.each(['light', 'dark'])(
    '保存された値（%s）を、描画の前に、data-theme に設定する（アプリ本体と同じ保存先）',
    (theme) => {
      const setAttribute = run(fakeStorage({ [THEME_STORAGE_KEY]: theme }));

      expect(setAttribute).toHaveBeenCalledWith('data-theme', theme);
    },
  );

  it.each([{}, { [THEME_STORAGE_KEY]: 'system' }, { [THEME_STORAGE_KEY]: 'blue' }])(
    'システム・保存なし・不正な値（%j）では、何も設定しない（ブラウザの設定に従う）',
    (stored) => {
      const setAttribute = run(fakeStorage(stored));

      expect(setAttribute).not.toHaveBeenCalled();
    },
  );

  it('保存領域が使えなくても、例外にしない', () => {
    expect(() => run(new Error('SecurityError'))).not.toThrow();
    expect(() => run(throwingStorage)).not.toThrow();
  });
});
