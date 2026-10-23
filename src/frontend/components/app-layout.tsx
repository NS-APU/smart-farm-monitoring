/**
 * 共通のレイアウト（functional-specification.md 2.3。ui-design-guidelines.md 8 章）。
 * 左のサイドメニュー（アイコン + 文字）と、上部のバー（設備の選択・未読の通知の件数・最終のデータ取得日時・ログイン中のユーザー）。
 * 狭い幅（900px 以下）では、メニューを、☰ で開閉する引き出しにする。メニューの項目・名前・遷移先は、変えない。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Permission } from '@smart-farm/shared/constants/permissions';
import { getUnreadCount } from '../api/endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useNarrowViewport } from '../hooks/use-narrow-viewport.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link, useLocation } from '../router/router.tsx';
import { AppStateProvider, useAppState } from './app-state.tsx';
import { equipmentOptionLabel } from './equipment-options.ts';
import { formatDateTimeJst } from './format.ts';
import { Icon, type IconName } from './icon.tsx';
import { subscribeUnreadChanged } from './unread-events.ts';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
  /** 必要な権限。権限のないロールには、メニューに表示しない（暫定。Q-017）。 */
  readonly permission?: Permission;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: PATHS.dashboard, label: MESSAGES.nav.dashboard, icon: 'nav-dashboard' },
  { to: PATHS.dataEntry, label: MESSAGES.nav.dataEntry, icon: 'nav-entry' },
  { to: PATHS.notifications, label: MESSAGES.nav.notifications, icon: 'nav-notifications' },
  { to: PATHS.observations, label: MESSAGES.nav.observations, icon: 'nav-observations' },
];

/** 「設定」の下にまとめる項目（機能仕様書 2.3）。 */
const SETTINGS_ITEMS: readonly NavItem[] = [
  { to: PATHS.settingsEquipment, label: MESSAGES.nav.equipment, icon: 'nav-equipment' },
  { to: PATHS.settingsIngestion, label: MESSAGES.nav.ingestion, icon: 'nav-ingestion' },
  { to: PATHS.settingsStatusCodes, label: MESSAGES.nav.statusCodes, icon: 'nav-status-codes' },
  {
    to: PATHS.settingsUsers,
    label: MESSAGES.nav.users,
    icon: 'nav-users',
    permission: 'user:manage',
  },
  { to: PATHS.settingsPush, label: MESSAGES.nav.pushSettings, icon: 'nav-push' },
];

function EquipmentSelect(): ReactNode {
  const { equipmentList, selectedEquipmentId, selectEquipment } = useAppState();
  return (
    <label className="header-field">
      <span>{MESSAGES.layout.equipment}</span>
      <select
        value={selectedEquipmentId ?? ''}
        onChange={(event) => {
          // 選択肢にある設備だけを選ぶ（選択肢の値は、設備の識別子）
          const selected = equipmentList.find((item) => item.equipmentId === event.target.value);
          if (selected !== undefined) {
            selectEquipment(selected.equipmentId);
          }
        }}
        disabled={equipmentList.length === 0}
      >
        {equipmentList.map((item) => (
          <option key={item.equipmentId} value={item.equipmentId}>
            {equipmentOptionLabel(item)}
          </option>
        ))}
      </select>
    </label>
  );
}

function UnreadBadge(props: { readonly onCount: (count: number) => void }): ReactNode {
  const { api } = useAuth();
  const { onCount } = props;
  const fetchUnread = useCallback(() => getUnreadCount(api), [api]);
  const { data, reload } = usePolling(fetchUnread);
  // 通知を既読にした直後は、約10秒の更新を待たずに、件数を読み直す
  useEffect(() => subscribeUnreadChanged(reload), [reload]);
  const count = data?.unreadCount ?? 0;
  // メニューの「通知」の件数の印にも、同じ件数を使う（取得は、1 回だけ）
  useEffect(() => {
    onCount(count);
  }, [count, onCount]);
  // 未読が増えたことを、画面を見ていない利用者（スクリーンリーダー）にも知らせる（V-182）。減った・変わらないときは、知らせない
  const previousCount = useRef(count);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    setAnnouncement(count > previousCount.current ? MESSAGES.common.newNotifications(count) : '');
    previousCount.current = count;
  }, [count]);
  return (
    <>
      <Link
        to={PATHS.notifications}
        className="header-unread"
        aria-label={`${MESSAGES.layout.unreadNotifications}: ${String(count)}件`}
      >
        <Icon name="nav-notifications" size={18} />
        <span data-testid="unread-count">{count}</span>
      </Link>
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </>
  );
}

function DataStatusText(): ReactNode {
  const { dataStatus } = useAppState();
  if (dataStatus === undefined) {
    return null;
  }
  const text =
    dataStatus.freshness === 'NONE'
      ? MESSAGES.layout.notReceived
      : formatDateTimeJst(dataStatus.lastReceivedAt);
  return (
    <p className={`header-data-status data-${dataStatus.freshness.toLowerCase()}`}>
      <span>{MESSAGES.layout.lastReceived}: </span>
      <span>{text}</span>
      {dataStatus.freshness === 'STALE' ? <strong>（{MESSAGES.layout.stale}）</strong> : null}
    </p>
  );
}

function NavLinkItem(props: {
  readonly item: NavItem;
  readonly pathname: string;
  readonly unreadCount?: number | undefined;
}): ReactNode {
  const { item } = props;
  return (
    <li className="nav-item">
      <Link to={item.to} aria-current={props.pathname === item.to ? 'page' : undefined}>
        <Icon name={item.icon} size={19} />
        {item.label}
      </Link>
      {/* 件数の印は、リンクの外に置く（リンクの名前を、メニューの名前のままにする）。読み上げは、上部の「未読の通知」のリンクが担う */}
      {props.unreadCount === undefined || props.unreadCount === 0 ? null : (
        <span className="nav-badge" aria-hidden="true">
          {props.unreadCount}
        </span>
      )}
    </li>
  );
}

function NavMenu(props: { readonly unreadCount: number }): ReactNode {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const allowed = (item: NavItem): boolean =>
    item.permission === undefined || (user?.permissions.includes(item.permission) ?? false);
  return (
    <nav aria-label={MESSAGES.layout.menu} className="app-nav">
      <ul>
        {NAV_ITEMS.filter(allowed).map((item) => (
          <NavLinkItem
            key={item.to}
            item={item}
            pathname={pathname}
            unreadCount={item.to === PATHS.notifications ? props.unreadCount : undefined}
          />
        ))}
        <li className="nav-group">
          {/* 「設定」は、開閉できるまとまり。既定では、開いておく */}
          <details open>
            <summary>
              <Icon name="nav-settings" size={19} />
              <span>{MESSAGES.nav.settings}</span>
              <Icon name="chevron" size={16} />
            </summary>
            <ul>
              {SETTINGS_ITEMS.filter(allowed).map((item) => (
                <NavLinkItem key={item.to} item={item} pathname={pathname} />
              ))}
            </ul>
          </details>
        </li>
      </ul>
    </nav>
  );
}

/**
 * 画面のタイトル（ブラウザのタブ・履歴・スクリーンリーダー）を、本文の見出し（h1）に合わせる（V-154）。
 * 見出しは、データの読み込み後に変わる画面（観点の名称など）があるため、本文の変化を監視する。
 */
function usePageTitle(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    const main = document.getElementById('main');
    if (main === null) {
      return undefined;
    }
    const update = (): void => {
      const heading = main.querySelector('h1');
      // 見出しの直下の文字（状態のバッジなどの子要素の文字は含めない）
      const text = Array.from(heading?.childNodes ?? [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .trim();
      const title = text === '' ? (heading?.textContent ?? '').trim() : text;
      document.title = title === '' ? MESSAGES.appName : `${title} - ${MESSAGES.appName}`;
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(main, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
    };
  }, [pathname]);
}

/** フォーカスを受けられる要素（引き出しの中で、Tab の移動を閉じ込める範囲を決める）。 */
const FOCUSABLE = 'a[href], button:not([disabled]), summary, select:not([disabled])';

function AppShell(props: { readonly children: ReactNode }): ReactNode {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const narrow = useNarrowViewport();
  // 引き出しを開いた状況（画面・幅）を覚える。画面を移動したとき・幅が変わったときは、状況が合わなくなり、閉じた扱いになる
  const [opened, setOpened] = useState<{ pathname: string; narrow: boolean } | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const sidebarRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  usePageTitle();

  // 引き出しを開いている間: フォーカスを中へ移し、Esc で閉じ（☰ にフォーカスを戻す）、Tab の移動を中に閉じ込める
  const drawerOpen = narrow && opened?.pathname === pathname && opened.narrow;
  useEffect(() => {
    if (!drawerOpen) {
      return undefined;
    }
    const sidebar = sidebarRef.current;
    sidebar?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    document.body.classList.add('menu-open');
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpened(null);
        toggleRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab' || sidebar === null) {
        return;
      }
      const items = Array.from(sidebar.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items.at(0);
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('menu-open');
    };
  }, [drawerOpen]);

  const closeMenu = useCallback(() => {
    setOpened(null);
    toggleRef.current?.focus();
  }, []);

  return (
    <>
      <a className="skip-link" href="#main">
        {MESSAGES.layout.skipToContent}
      </a>
      <div className={`app-shell${drawerOpen ? ' menu-is-open' : ''}`}>
        <aside id="app-sidebar" ref={sidebarRef} className="app-sidebar">
          <div className="sidebar-head">
            <Link to={PATHS.dashboard} className="app-title">
              <Icon name="brand" size={24} />
              {MESSAGES.appName}
            </Link>
            <button
              type="button"
              className="menu-close"
              aria-label={MESSAGES.layout.closeMenu}
              onClick={closeMenu}
            >
              <Icon name="close" size={20} />
            </button>
          </div>
          <NavMenu unreadCount={unreadCount} />
        </aside>
        {/* 引き出しの外（本文）を押すと閉じる。キーボードでは、Esc と、閉じるボタンで閉じる */}
        <button
          type="button"
          className="menu-scrim"
          tabIndex={-1}
          aria-hidden="true"
          onClick={closeMenu}
        />
        <div className="app-body">
          <header className="app-header">
            <div className="app-header-row">
              <button
                type="button"
                ref={toggleRef}
                className="menu-toggle"
                aria-label={MESSAGES.layout.openMenu}
                aria-expanded={drawerOpen}
                aria-controls="app-sidebar"
                onClick={() => {
                  setOpened({ pathname, narrow });
                }}
              >
                <Icon name="menu" size={22} />
              </button>
              <span className="app-title-compact" aria-hidden="true">
                {MESSAGES.appName}
              </span>
              <EquipmentSelect />
              <UnreadBadge onCount={setUnreadCount} />
              <DataStatusText />
              <div className="header-user">
                <Icon name="user" size={18} />
                <span aria-label={MESSAGES.layout.user}>{user?.userName}</span>
                <button
                  type="button"
                  onClick={() => {
                    void logout();
                  }}
                >
                  {MESSAGES.layout.logout}
                </button>
              </div>
            </div>
          </header>
          <main id="main" className="app-main">
            {props.children}
          </main>
        </div>
      </div>
    </>
  );
}

export function AppLayout(props: { readonly children: ReactNode }): ReactNode {
  return (
    <AppStateProvider>
      <AppShell>{props.children}</AppShell>
    </AppStateProvider>
  );
}
