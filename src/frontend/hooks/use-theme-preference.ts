/**
 * テーマ（システム・ライト・ダーク）の設定（Issue #352。ユーザーメニューの中の項目で使う。#353）。
 * 起動時に、この端末のブラウザに保存された設定を読み、画面（html 要素の data-theme）に適用する。選ぶと、すぐ切り替わり、保存する。
 * 保存・適用の詳細は、lib/theme.ts。描画の前の最初の適用は、public/theme-init.js。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  applyThemePreference,
  readThemePreference,
  resolveThemeStorage,
  saveThemePreference,
  type ThemePreference,
} from '../lib/theme.ts';

export function useThemePreference(): {
  readonly preference: ThemePreference;
  readonly select: (value: ThemePreference) => void;
} {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    readThemePreference(resolveThemeStorage()),
  );

  // 設定を、画面に適用する（描画の前の適用は、public/theme-init.js が行う。ここは、設定を選んだときと、起動時の整合）
  useEffect(() => {
    applyThemePreference(document.documentElement, preference);
  }, [preference]);

  const select = useCallback((value: ThemePreference) => {
    setPreference(value);
    saveThemePreference(resolveThemeStorage(), value);
  }, []);

  return { preference, select };
}
