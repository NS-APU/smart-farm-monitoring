/**
 * ヘッダーのポップアップのメニュー（ユーザーメニュー。Issue #353。テーマの切り替えも、この中。#352）の動作。
 * - ボタンを押すと開閉する。外側を押す・フォーカスが外へ移る・Esc で閉じる（Esc は、ボタンにフォーカスを戻す）
 * - 開くと、最初の項目にフォーカスを移す。↑↓・Home・End で項目を移る（端で折り返す）
 * - 開いたとき、画面の幅（余白 8px）からはみ出す分だけ、位置をずらす（ボタンが、行の左寄り・右寄りのどちらでも収める）
 * 項目は、`role="menuitem"`・`role="menuitemradio"` の要素。メニュー本体に `listRef`・`onKeyDown` を、全体に `wrapperRef`・`onBlur` を付ける。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]';
const VIEWPORT_MARGIN_PX = 8;

export interface PopupMenu {
  readonly open: boolean;
  readonly toggle: () => void;
  /** 閉じる。`returnFocus` が true なら、ボタンにフォーカスを戻す。 */
  readonly close: (returnFocus?: boolean) => void;
  readonly wrapperRef: RefObject<HTMLDivElement | null>;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly onMenuKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onBlur: (event: FocusEvent<HTMLElement>) => void;
}

export function usePopupMenu(): PopupMenu {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);

  // 開いたとき、画面の幅からはみ出す分だけ、位置をずらす
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || list === null) {
      return;
    }
    list.style.transform = '';
    const rect = list.getBoundingClientRect();
    if (rect.width === 0) {
      return;
    }
    const shift =
      Math.max(0, VIEWPORT_MARGIN_PX - rect.left) -
      Math.max(0, rect.right - (window.innerWidth - VIEWPORT_MARGIN_PX));
    if (shift !== 0) {
      list.style.transform = `translateX(${String(shift)}px)`;
    }
  }, [open]);

  // 開いたら、最初の項目にフォーカスを移す
  useEffect(() => {
    if (open) {
      items()[0]?.focus();
    }
  }, [open]);

  // メニューの外側を押したら、閉じる
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onMouseDown = (event: MouseEvent): void => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open]);

  const toggle = useCallback(() => {
    setOpen((value) => !value);
  }, []);

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    const all = items();
    const current = all.findIndex((item) => item === document.activeElement);
    const moves: Record<string, number> = {
      ArrowDown: (current + 1) % all.length,
      ArrowUp: (current - 1 + all.length) % all.length,
      Home: 0,
      End: all.length - 1,
    };
    const next = moves[event.key];
    if (next !== undefined) {
      event.preventDefault();
      all[next]?.focus();
    }
  };

  // Tab などで、メニューの外へフォーカスが移ったら、閉じる
  const onBlur = (event: FocusEvent<HTMLElement>): void => {
    if (open && !event.currentTarget.contains(event.relatedTarget)) {
      setOpen(false);
    }
  };

  return { open, toggle, close, wrapperRef, triggerRef, listRef, onMenuKeyDown, onBlur };
}
