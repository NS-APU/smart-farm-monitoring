/**
 * ヘッダーのテーマのメニュー（システム・ライト・ダーク。Issue #352。ui-design-guidelines.md 8 章）。
 * ボタンのアイコンは、現在の設定を表す。押すと 3 項目が開き、選ぶとすぐ切り替わる（設定は、この端末のブラウザに保存する。lib/theme.ts）。
 * キーボード: 開くと、現在の項目にフォーカスが移る。↑↓・Home・End で項目を移り、Esc・外側の操作で閉じる（Esc は、ボタンにフォーカスを戻す）。
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { MESSAGES } from '../i18n/messages.ts';
import {
  applyThemePreference,
  readThemePreference,
  resolveThemeStorage,
  saveThemePreference,
  type ThemePreference,
} from '../lib/theme.ts';
import { Icon, type IconName } from './icon.tsx';

interface ThemeOption {
  readonly value: ThemePreference;
  /** ボタンの名前（現在の設定）に使う名前。 */
  readonly name: string;
  /** メニューの項目の表示。 */
  readonly label: string;
  readonly icon: IconName;
}

const OPTIONS: readonly ThemeOption[] = [
  {
    value: 'system',
    name: MESSAGES.theme.system,
    label: MESSAGES.theme.systemDefault,
    icon: 'theme-system',
  },
  { value: 'light', name: MESSAGES.theme.light, label: MESSAGES.theme.light, icon: 'theme-light' },
  { value: 'dark', name: MESSAGES.theme.dark, label: MESSAGES.theme.dark, icon: 'theme-dark' },
];

function optionOf(value: ThemePreference): ThemeOption {
  return OPTIONS.find((option) => option.value === value) ?? OPTIONS[0] ?? fallbackOption();
}

/** 型の上の保険（OPTIONS は、空にならない）。 */
function fallbackOption(): ThemeOption {
  return {
    value: 'system',
    name: MESSAGES.theme.system,
    label: MESSAGES.theme.systemDefault,
    icon: 'theme-system',
  };
}

export function ThemeMenu(): ReactNode {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    readThemePreference(resolveThemeStorage()),
  );
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 開いたとき、画面の幅からはみ出す分だけ、位置をずらす（ボタンが、行の左寄り・右寄りのどちらにあっても、収める）
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
    const margin = 8;
    const shift =
      Math.max(0, margin - rect.left) - Math.max(0, rect.right - (window.innerWidth - margin));
    if (shift !== 0) {
      list.style.transform = `translateX(${String(shift)}px)`;
    }
  }, [open]);

  // 設定を、画面に適用する（描画の前の適用は、public/theme-init.js が行う。ここは、設定を選んだときと、起動時の整合）
  useEffect(() => {
    applyThemePreference(document.documentElement, preference);
  }, [preference]);

  // 開いたら、現在の設定の項目にフォーカスを移す
  useEffect(() => {
    if (open) {
      itemRefs.current[OPTIONS.findIndex((option) => option.value === preference)]?.focus();
    }
    // 開いた直後だけ。開いている間に設定が変わることはない（選ぶと閉じる）
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const select = (value: ThemePreference): void => {
    setPreference(value);
    saveThemePreference(resolveThemeStorage(), value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null);
    const current = items.findIndex((item) => item === document.activeElement);
    const moves: Record<string, number> = {
      ArrowDown: (current + 1) % items.length,
      ArrowUp: (current - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    };
    const next = moves[event.key];
    if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus();
    }
  };

  const current = optionOf(preference);
  return (
    <div
      ref={wrapperRef}
      className="theme-menu"
      onBlur={(event) => {
        // Tab などで、メニューの外へフォーカスが移ったら、閉じる
        if (open && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className="theme-trigger"
        aria-label={`${MESSAGES.theme.label}: ${current.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <Icon name={current.icon} size={22} />
      </button>
      {open ? (
        <div
          ref={listRef}
          role="menu"
          tabIndex={-1}
          aria-label={MESSAGES.theme.label}
          className="theme-list"
          onKeyDown={onMenuKeyDown}
        >
          {OPTIONS.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === preference}
              className="theme-item"
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              onClick={() => {
                select(option.value);
              }}
            >
              <Icon name={option.icon} size={18} />
              <span>{option.label}</span>
              <span className="theme-check" aria-hidden="true">
                {option.value === preference ? <Icon name="check" size={16} /> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
