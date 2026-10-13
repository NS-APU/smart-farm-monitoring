/**
 * メディアクエリ（例: `(max-width: 480px)`）に一致するかを返す。画面の幅が変わると、読み直す。
 * matchMedia のない環境（テスト環境など）では、一致しない（false）。
 */

import { useEffect, useState } from 'react';

function matches(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const [current, setCurrent] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const list = window.matchMedia(query);
    const update = (): void => {
      setCurrent(list.matches);
    };
    update();
    list.addEventListener('change', update);
    return () => {
      list.removeEventListener('change', update);
    };
  }, [query]);
  return current;
}
