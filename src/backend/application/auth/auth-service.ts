/**
 * 認証・認可のユースケース（UC-13）。AuthPort（誰か）と AccessPolicy（何ができるか）を組み合わせる。
 */

import { AppError } from '@smart-farm/shared/errors';
import type { AuthenticatedUser, LoginResponse } from '@smart-farm/shared/schemas/auth';
import { NULL_LOGGER, type Logger } from '../ports/logger-port.ts';
import type { AuthPort, AuthPrincipal, AuthSession } from '../ports/auth-port.ts';
import type { AccessPolicy } from './access-policy.ts';

export interface AuthService {
  login(userId: string, password: string, clientKey: string): Promise<LoginResponse>;
  refresh(refreshToken: string): Promise<LoginResponse>;
  logout(accessToken: string): Promise<void>;
  /** アクセストークンから、認証済みの利用者（権限つき）を返す。無効なトークンは null。 */
  authenticate(accessToken: string): Promise<AuthenticatedUser | null>;
}

/**
 * 認証・認可のユースケース。ログインの成功・失敗・制限、ログアウト、セッションの更新の失敗は、構造化ログに残す
 * （パスワード・トークンは残さない。不正なログインの試行・成功を、後から調べられるように。V-013）。
 */
export function createAuthService(deps: {
  auth: AuthPort;
  policy: AccessPolicy;
  logger?: Logger;
}): AuthService {
  const { auth, policy } = deps;
  const logger = deps.logger ?? NULL_LOGGER;

  function toAuthenticatedUser(principal: AuthPrincipal): AuthenticatedUser {
    return {
      userId: principal.userId,
      userName: principal.userName,
      role: principal.role,
      permissions: [...policy.permissionsOf(principal.role)],
    };
  }

  function toLoginResponse(session: AuthSession): LoginResponse {
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: session.refreshTokenExpiresAt.toISOString(),
      user: toAuthenticatedUser(session.principal),
    };
  }

  return {
    async login(userId, password, clientKey) {
      try {
        const response = toLoginResponse(await auth.login({ userId, password }, clientKey));
        logger.info('ログインしました', { event: 'auth.login.succeeded', userId, clientKey });
        return response;
      } catch (error) {
        logger.warn('ログインに失敗しました', {
          event:
            error instanceof AppError && error.code === 'RATE_LIMITED'
              ? 'auth.login.locked'
              : 'auth.login.failed',
          userId,
          clientKey,
        });
        throw error;
      }
    },
    async refresh(refreshToken) {
      try {
        return toLoginResponse(await auth.refresh(refreshToken));
      } catch (error) {
        logger.warn('セッションの更新に失敗しました', { event: 'auth.refresh.failed' });
        throw error;
      }
    },
    async logout(accessToken) {
      const principal = await auth.verifyAccessToken(accessToken);
      await auth.logout(accessToken);
      logger.info('ログアウトしました', {
        event: 'auth.logout',
        ...(principal === null ? {} : { userId: principal.userId }),
      });
    },
    async authenticate(accessToken) {
      const principal = await auth.verifyAccessToken(accessToken);
      return principal === null ? null : toAuthenticatedUser(principal);
    },
  };
}
