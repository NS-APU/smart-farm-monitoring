/**
 * テーマ（システム・ライト・ダーク）の設定の保存と適用（Issue #352。ui-design-guidelines.md 5 章）。
 *
 * - 設定は、この端末のブラウザ（localStorage）に保存する（サーバーには送らない。個人情報ではない）。
 * - 適用は、`html` 要素の `data-theme` で行う。ライト・ダークは、その値を設定する。システムは、外す（ブラウザの設定
 *   〔prefers-color-scheme〕に従う。CSS: styles/app.css）。
 * - 描画の前の最初の適用は、`public/theme-init.js`（同じ保存先・同じ値。CSP でインラインのスクリプトを使えないため、別ファイル）が行う。
 *   保存先・値を変えるときは、双方を更新する（tests/unit/frontend/theme.test.ts が、一致を確認する）。
 */

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** 保存先のキー（public/theme-init.js と同じ）。 */
export const THEME_STORAGE_KEY = 'smart-farm.theme';

export type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** 保存された値を、設定として読む。ない・不正な値は、システム。 */
export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  return THEME_PREFERENCES.find((preference) => preference === raw) ?? 'system';
}

/** ブラウザの localStorage を返す。アクセスが禁止されている環境では undefined。 */
export function resolveThemeStorage(): ThemeStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** 保存された設定を読む。保存領域が使えないときは、システム（例外にしない）。 */
export function readThemePreference(storage: ThemeStorage | undefined): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

/** 設定を保存する。保存領域が使えないときは、保存せずに続ける（その画面の間は、切り替わる）。 */
export function saveThemePreference(
  storage: ThemeStorage | undefined,
  preference: ThemePreference,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 保存できなくても、画面の切り替えは行う
  }
}

/** 設定を、`html` 要素に適用する（システムは、`data-theme` を外す）。 */
export function applyThemePreference(root: Element, preference: ThemePreference): void {
  if (preference === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', preference);
  }
}
