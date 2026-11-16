/**
 * ヘッダーのユーザーメニュー（Issue #353。functional-specification.md 2.3・ui-design-guidelines.md 8 章）。
 * ユーザーアイコン・ユーザー名・ロールを 1 つのボタンにし、押すと、個人に関する操作を開く:
 * ユーザー名の変更・パスワードの変更・通知の設定（画面へ移るリンク）、テーマ（システム・ライト・ダーク。選ぶとすぐ切り替わる。#352）、ログアウト。
 * 狭い幅（900px 以下）では、アイコンだけにする（名前・ロールは、ボタンの名前で読み上げる）。長いユーザー名は、省略する（全文は、ボタンの名前・ツールチップ）。
 * 開閉・キーボード（↑↓・Home・End・Esc）・位置の補正は、hooks/use-popup-menu.ts。
 */

import { useId, type ReactNode } from 'react';
import { useAuth } from '../auth/auth-context.tsx';
import { usePopupMenu } from '../hooks/use-popup-menu.ts';
import { useThemePreference } from '../hooks/use-theme-preference.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { roleDisplayName } from '../lib/role-name.ts';
import type { ThemePreference } from '../lib/theme.ts';
import { PATHS } from '../router/paths.ts';
import { Link, useLocation } from '../router/router.tsx';
import { Icon, type IconName } from './icon.tsx';

/** 個人に関する画面（ユーザー名・パスワード・通知の設定）。 */
const PERSONAL_LINKS: readonly { readonly to: string; readonly label: string }[] = [
  { to: PATHS.profile, label: MESSAGES.profile.link },
  { to: PATHS.changePassword, label: MESSAGES.changePassword.link },
  { to: PATHS.settingsPush, label: MESSAGES.nav.pushSettings },
];

const THEME_OPTIONS: readonly {
  readonly value: ThemePreference;
  readonly label: string;
  readonly icon: IconName;
}[] = [
  { value: 'system', label: MESSAGES.theme.systemDefault, icon: 'theme-system' },
  { value: 'light', label: MESSAGES.theme.light, icon: 'theme-light' },
  { value: 'dark', label: MESSAGES.theme.dark, icon: 'theme-dark' },
];

export function UserMenu(): ReactNode {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const { open, toggle, close, wrapperRef, triggerRef, listRef, onMenuKeyDown, onBlur } =
    usePopupMenu();
  const { preference, select } = useThemePreference();
  const themeHeadingId = useId();
  if (user === null) {
    return null;
  }

  const roleName = roleDisplayName(user.role);
  const roleText = roleName === undefined ? '' : `（${roleName}）`;
  // 個人に関する画面にいる間は、ボタンと、メニューの該当の項目で、現在の画面を示す（メニューに、これらの項目がないため）
  const onPersonalPage = PERSONAL_LINKS.some((link) => link.to === pathname);

  return (
    <div ref={wrapperRef} className="popup-menu user-menu" onBlur={onBlur}>
      <button
        type="button"
        ref={triggerRef}
        className="user-trigger"
        aria-label={`${MESSAGES.layout.user}: ${user.userName}${roleText}`}
        title={`${user.userName}${roleText}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={onPersonalPage ? 'page' : undefined}
        onClick={toggle}
      >
        <Icon name="user" size={18} />
        <span className="user-label">
          <span className="user-name" data-testid="user-name">
            {user.userName}
          </span>
          {roleName === undefined ? null : (
            <span className="user-role" data-testid="user-role">
              {roleText}
            </span>
          )}
        </span>
      </button>
      {open ? (
        <div
          ref={listRef}
          role="menu"
          tabIndex={-1}
          aria-label={MESSAGES.layout.userMenu}
          className="popup-list"
          onKeyDown={onMenuKeyDown}
        >
          {PERSONAL_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              role="menuitem"
              className="popup-item"
              aria-current={pathname === link.to ? 'page' : undefined}
              onClick={() => {
                close();
              }}
            >
              {link.label}
            </Link>
          ))}
          <div role="separator" className="popup-separator" />
          <div role="group" aria-labelledby={themeHeadingId}>
            <div id={themeHeadingId} className="popup-heading">
              {MESSAGES.theme.label}
            </div>
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === preference}
                className="popup-item"
                onClick={() => {
                  select(option.value);
                  close(true);
                }}
              >
                <Icon name={option.icon} size={18} />
                <span>{option.label}</span>
                <span className="popup-check" aria-hidden="true">
                  {option.value === preference ? <Icon name="check" size={16} /> : null}
                </span>
              </button>
            ))}
          </div>
          <div role="separator" className="popup-separator" />
          <button
            type="button"
            role="menuitem"
            className="popup-item"
            onClick={() => {
              close();
              void logout();
            }}
          >
            {MESSAGES.layout.logout}
          </button>
        </div>
      ) : null}
    </div>
  );
}
