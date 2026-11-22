/**
 * 結果の通知（保存・修正・削除などの完了メッセージ）が、表示されたとき（現れた・変わったとき）に、画面内へスクロールする（Issue #150）。
 * すでに画面内にあれば、動かない（`block: 'nearest'`）。動きを減らす設定（prefers-reduced-motion）のときは、アニメーションしない。
 * **フォーカスは動かさない**（結果の通知は、操作できる要素を持たないため。フォーカスを奪うと、押したボタンの位置を失う）。
 * `scrollIntoView` のない環境（jsdom など）では、何もしない。
 *
 * 戻り値の ref を、通知の要素に付ける。`signal` が変わるたび（最初の表示を含む）にスクロールする（同じ値のままの描き直しでは、しない）。
 */

import { useLayoutEffect, useRef, type RefObject } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function useRevealOnChange<T extends HTMLElement>(signal: unknown): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  // 描画の直後（画面に出る前）に実行する。表示と同時にスクロールが決まり、通知が現れた直後に、位置を確かめられる
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof element.scrollIntoView !== 'function') {
      return;
    }
    element.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [signal]);
  return ref;
}
