/**
 * 認証の状態（セッション）と、API クライアントの提供。
 * 未認証のアクセスは、ログイン画面へ誘導する（FR-9.1）。セッションの有効期限が切れた場合は、再ログインを求める。
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AuthenticatedUser } from '@smart-farm/shared/schemas/auth';
import { createApiClient, type ApiClient, type SessionAccess } from '../api/client.ts';
import { login as loginRequest, logout as logoutRequest } from '../api/endpoints.ts';

export interface AuthContextValue {
  readonly api: ApiClient;
  /** ログイン中の利用者。未ログインは null。 */
  readonly user: AuthenticatedUser | null;
  readonly login: (userId: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export interface AuthProviderProps {
  readonly session: SessionAccess;
  readonly fetchFn: typeof fetch;
  readonly children: ReactNode;
}

export function AuthProvider(props: AuthProviderProps): ReactNode {
  const { session, fetchFn, children } = props;
  const [user, setUser] = useState<AuthenticatedUser | null>(() => session.get()?.user ?? null);

  const value = useMemo<AuthContextValue>(() => {
    // セッションを更新できず、期限切れになった場合は、未ログインの状態に戻す
    const api = createApiClient({
      fetchFn,
      session,
      onSessionExpired: () => {
        setUser(null);
      },
      // セッションの更新で、サーバーの最新のロール・権限を受け取ったら、メニュー・ボタンの表示にも反映する
      // （内容が同じなら、状態を変えない。不要な再描画・API クライアントの作り直しを避ける）
      onSessionRefreshed: (refreshed) => {
        setUser((current) =>
          JSON.stringify(current) === JSON.stringify(refreshed.user) ? current : refreshed.user,
        );
      },
    });
    return {
      api,
      user,
      async login(userId, password) {
        const response = await loginRequest(api, userId, password);
        session.set(response);
        setUser(response.user);
      },
      async logout() {
        try {
          await logoutRequest(api);
        } catch {
          // サーバーへ届かなくても、この端末のセッションは破棄する
        }
        session.clear();
        setUser(null);
      },
    };
  }, [fetchFn, session, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === undefined) {
    throw new Error('AuthProvider の外では useAuth を使えません');
  }
  return value;
}
