/**
 * 共通のレイアウト（functional-specification.md 2.3。ui-design-guidelines.md 8 章）。
 * 左のサイドメニュー（アイコン + 文字）と、上部のバー（☰・タイトル・通知のアイコンと未読の件数のバッジ・ユーザーメニュー）。
 * 対象の設備の選択・最終のデータ取得日時は、ダッシュボードなどの画面の中へ移した（Issue #355）。
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
import { AppStateProvider } from './app-state.tsx';
import { Icon, type IconName } from './icon.tsx';
import { subscribeUnreadChanged } from './unread-events.ts';
import { UserMenu } from './user-menu.tsx';

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
  { to: PATHS.observations, label: MESSAGES.nav.observations, icon: 'nav-observations' },
];

/** 「設定」の下にまとめる項目（機能仕様書 2.3）。 */
const SETTINGS_ITEMS: readonly NavItem[] = [
  { to: PATHS.settingsEquipment, label: MESSAGES.nav.equipment, icon: 'nav-equipment' },
  // 取り込みの参照権限がない利用者（一般）には、閲覧できるハウスの記録だけを示す（Issue #332）。メニューは、全員に表示する
  { to: PATHS.settingsIngestion, label: MESSAGES.nav.ingestion, icon: 'nav-ingestion' },
  { to: PATHS.settingsStatusCodes, label: MESSAGES.nav.statusCodes, icon: 'nav-status-codes' },
  {
    to: PATHS.settingsUsers,
    label: MESSAGES.nav.users,
    icon: 'nav-users',
    permission: 'user:manage',
  },
];

/** バッジに表示する件数の上限。これを超える件数は「99+」と表示する（バッジの幅を、一定にする）。 */
const UNREAD_BADGE_MAX = 99;

/** 通知のアイコン（ヘッダー）。未読の件数のバッジを重ね、押すと通知の一覧を開く。通知の画面にいる間は、現在の画面を示す。 */
function NotificationLink(): ReactNode {
  const { api } = useAuth();
  const { pathname } = useLocation();
  const fetchUnread = useCallback(() => getUnreadCount(api), [api]);
  const { data, reload } = usePolling(fetchUnread);
  // 通知を既読にした直後は、約10秒の更新を待たずに、件数を読み直す
  useEffect(() => subscribeUnreadChanged(reload), [reload]);
  const count = data?.unreadCount ?? 0;
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
        aria-current={pathname === PATHS.notifications ? 'page' : undefined}
      >
        <Icon name="nav-notifications" size={22} />
        {/* バッジは、0 件のときは隠す（要素は残す）。読み上げは、リンクの名前が担う（実際の件数） */}
        <span
          className="unread-badge"
          data-testid="unread-count"
          hidden={count === 0}
          aria-hidden="true"
        >
          {count > UNREAD_BADGE_MAX ? `${String(UNREAD_BADGE_MAX)}+` : count}
        </span>
      </Link>
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </>
  );
}

/**
 * メニューの項目が、現在の画面か。パスの前方一致（区切りの `/` の単位。入力データ一覧・変更履歴でも「データ入力」を強調する。Issue #155）。
 * ダッシュボード（`/`）は、すべてのパスの前方になるため、完全一致のみ。
 */
function isCurrentPath(itemPath: string, pathname: string): boolean {
  if (itemPath === PATHS.dashboard) {
    return pathname === itemPath;
  }
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}

function NavLinkItem(props: { readonly item: NavItem; readonly pathname: string }): ReactNode {
  const { item } = props;
  return (
    <li className="nav-item">
      <Link to={item.to} aria-current={isCurrentPath(item.to, props.pathname) ? 'page' : undefined}>
        <Icon name={item.icon} size={19} />
        {item.label}
      </Link>
    </li>
  );
}

function NavMenu(): ReactNode {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const allowed = (item: NavItem): boolean =>
    item.permission === undefined || (user?.permissions.includes(item.permission) ?? false);
  return (
    <nav aria-label={MESSAGES.layout.menu} className="app-nav">
      <ul>
        {NAV_ITEMS.filter(allowed).map((item) => (
          <NavLinkItem key={item.to} item={item} pathname={pathname} />
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
  const { pathname } = useLocation();
  const narrow = useNarrowViewport();
  // 引き出しを開いた状況（画面・幅）を覚える。画面を移動したとき・幅が変わったときは、状況が合わなくなり、閉じた扱いになる
  const [opened, setOpened] = useState<{ pathname: string; narrow: boolean } | null>(null);
  // 広い幅で、サイドメニューを閉じているか（既定は、開いている。保存しない。Issue #354）
  const [collapsed, setCollapsed] = useState(false);
  const sidebarCollapsed = !narrow && collapsed;
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
      <div
        className={`app-shell${drawerOpen ? ' menu-is-open' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
      >
        <aside id="app-sidebar" ref={sidebarRef} className="app-sidebar" hidden={sidebarCollapsed}>
          <div className="sidebar-head">
            <button
              type="button"
              className="menu-close"
              aria-label={MESSAGES.layout.closeMenu}
              onClick={closeMenu}
            >
              <Icon name="close" size={20} />
            </button>
          </div>
          <NavMenu />
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
                aria-label={MESSAGES.layout.toggleMenu}
                aria-expanded={narrow ? drawerOpen : !collapsed}
                aria-controls="app-sidebar"
                onClick={() => {
                  if (!narrow) {
                    setCollapsed((value) => !value);
                  } else if (drawerOpen) {
                    closeMenu();
                  } else {
                    setOpened({ pathname, narrow });
                  }
                }}
              >
                <Icon name="menu" size={22} />
              </button>
              {/* タイトル（ダッシュボードへのリンク）。☰ とタイトルを、画面の幅に関わらず、ヘッダーの左に置く */}
              <Link to={PATHS.dashboard} className="app-title">
                <Icon name="brand" size={22} />
                <span>{MESSAGES.appName}</span>
              </Link>
              <NotificationLink />
              <UserMenu />
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
