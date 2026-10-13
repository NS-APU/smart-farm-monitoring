/**
 * 共通のヘッダー・ナビゲーション（functional-specification.md 2.3）。
 * 設備の選択、未読の通知の件数、最終のデータ取得日時、メニュー、ログイン中のユーザー。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Permission } from '@smart-farm/shared/constants/permissions';
import { getUnreadCount } from '../api/endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { usePolling } from '../hooks/use-polling.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link, useLocation } from '../router/router.tsx';
import { AppStateProvider, useAppState } from './app-state.tsx';
import { equipmentOptionLabel } from './equipment-options.ts';
import { formatDateTimeJst } from './format.ts';
import { subscribeUnreadChanged } from './unread-events.ts';

interface NavItem {
  readonly to: string;
  readonly label: string;
  /** 必要な権限。権限のないロールには、メニューに表示しない（暫定。Q-017）。 */
  readonly permission?: Permission;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: PATHS.dashboard, label: MESSAGES.nav.dashboard },
  { to: PATHS.dataEntry, label: MESSAGES.nav.dataEntry },
  { to: PATHS.notifications, label: MESSAGES.nav.notifications },
  { to: PATHS.observations, label: MESSAGES.nav.observations },
  { to: PATHS.settingsEquipment, label: MESSAGES.nav.equipment },
  { to: PATHS.settingsIngestion, label: MESSAGES.nav.ingestion },
  { to: PATHS.settingsStatusCodes, label: MESSAGES.nav.statusCodes },
  { to: PATHS.settingsUsers, label: MESSAGES.nav.users, permission: 'user:manage' },
  { to: PATHS.settingsPush, label: MESSAGES.nav.pushSettings },
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

function UnreadBadge(): ReactNode {
  const { api } = useAuth();
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
      >
        <span aria-hidden="true">🔔</span>
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

function NavMenu(): ReactNode {
  const { user } = useAuth();
  const { pathname } = useLocation();
  return (
    <nav aria-label={MESSAGES.layout.menu} className="app-nav">
      <ul>
        {NAV_ITEMS.filter(
          (item) =>
            item.permission === undefined || (user?.permissions.includes(item.permission) ?? false),
        ).map((item) => (
          <li key={item.to}>
            <Link to={item.to} aria-current={pathname === item.to ? 'page' : undefined}>
              {item.label}
            </Link>
          </li>
        ))}
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

export function AppLayout(props: { readonly children: ReactNode }): ReactNode {
  const { user, logout } = useAuth();
  usePageTitle();
  return (
    <AppStateProvider>
      <a className="skip-link" href="#main">
        {MESSAGES.layout.skipToContent}
      </a>
      <header className="app-header">
        <div className="app-header-row">
          <Link to={PATHS.dashboard} className="app-title">
            {MESSAGES.appName}
          </Link>
          <EquipmentSelect />
          <UnreadBadge />
          <DataStatusText />
          <div className="header-user">
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
        <NavMenu />
      </header>
      <main id="main" className="app-main">
        {props.children}
      </main>
    </AppStateProvider>
  );
}
