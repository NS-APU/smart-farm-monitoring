/**
 * 画面の幅が狭いか（メニューを、☰ で開閉する引き出しにする幅）。
 * 幅の境目（900px）は、CSS のメディアクエリ（app.css）と同じ値にする。
 * matchMedia がない環境（jsdom など）では、広い幅として扱う。
 */

import { useEffect, useState } from 'react';

export const NARROW_QUERY = '(max-width: 900px)';

function matchesNarrow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
}

export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(matchesNarrow);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const list = window.matchMedia(NARROW_QUERY);
    const update = (): void => {
      setNarrow(list.matches);
    };
    update();
    list.addEventListener('change', update);
    return () => {
      list.removeEventListener('change', update);
    };
  }, []);
  return narrow;
}
