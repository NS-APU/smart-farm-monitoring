/**
 * 認証のローカル実装（AuthPort）。アプリ内のユーザーID・パスワードで認証する。
 * Amazon Cognito 等への差し替えは、AuthPort の別実装の追加で行う（architecture.md 9章、Q-017）。
 *
 * 暫定仕様（dev_spec.md 4章）:
 * - セッション: 不透明なランダムトークン（アクセス30分、リフレッシュ7日。FR-9.3）。サーバー側にはハッシュのみ保持する。
 *   セッションはメモリのみで保持する（再起動で再ログインが必要）
 * - ログインの試行回数の制限: 同じ接続元（clientKey）から、15分あたりの失敗が5回に達したら、一時的に拒否する。
 *   成功すると失敗の回数をリセットする（FR-9.2。構想時の値）
 * - 失敗の理由は、利用者に特定させない（ユーザーIDの存在を推測させない）
 * - ユーザーの削除・パスワードの再設定では、そのユーザーのセッションを失効する（revokeSessionsOf）。さらに、セッションは
 *   ユーザーの作成日時（世代）を持ち、同じ ID で再登録されたユーザーには、削除前のトークンが使えない
 * - メモリの上限: 期限切れのセッションは、発行のたびに掃除し、失敗の記録は、追跡する接続元の数に上限を設ける
 */

import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '@smart-farm/shared/errors';
import { UserIdSchema } from '@smart-farm/shared/schemas/common';
import { MS_PER_DAY, MS_PER_MINUTE } from '@smart-farm/shared/time';
import type { AuthPort, AuthPrincipal, AuthSession } from '../../application/ports/auth-port.ts';
import type { ClockPort } from '../../application/ports/clock-port.ts';
import type { UserRecord } from '../../application/ports/records.ts';
import type { UserRepository } from '../../application/ports/repositories.ts';
import {
  ACCESS_TOKEN_TTL_MINUTES,
  LOGIN_FAILED_MESSAGE,
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MINUTES,
  LOGIN_LOCKED_MESSAGE,
  REFRESH_TOKEN_TTL_DAYS,
  SESSION_INVALID_MESSAGE,
} from '../common/auth-policy.ts';
import { hashPassword, verifyPassword } from './password-hasher.ts';

export {
  ACCESS_TOKEN_TTL_MINUTES,
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MINUTES,
  REFRESH_TOKEN_TTL_DAYS,
};
/** 失敗の記録を保持する接続元の数の上限。超えたら、古い順に捨てる（キーの偽装によるメモリの消費を防ぐ。V-009）。 */
export const DEFAULT_MAX_TRACKED_CLIENTS = 10_000;

const TOKEN_BYTES = 32;

interface Session {
  readonly userId: UserRecord['userId'];
  /** セッションを発行したときの、ユーザーの作成日時（世代）。再登録されたユーザーを区別する。 */
  readonly userCreatedAt: string;
  readonly accessHash: string;
  readonly refreshHash: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export interface LocalAuthDeps {
  readonly users: UserRepository;
  readonly clock: ClockPort;
  /** 失敗の記録を保持する接続元の数の上限（テストで小さくする）。 */
  readonly maxTrackedClients?: number;
}

export function createLocalAuth(deps: LocalAuthDeps): AuthPort {
  const { users, clock } = deps;
  const maxTrackedClients = deps.maxTrackedClients ?? DEFAULT_MAX_TRACKED_CLIENTS;
  const sessionsByAccess = new Map<string, Session>();
  const sessionsByRefresh = new Map<string, Session>();
  const failures = new Map<string, number[]>();
  // ユーザーが存在しない場合も、同じ時間をかけて検証し、処理時間の差から存在を推測されないようにする
  const dummyHash = hashPassword(randomBytes(TOKEN_BYTES).toString('hex'));

  function recentFailures(clientKey: string): number[] {
    const threshold = clock.now().getTime() - LOGIN_FAILURE_WINDOW_MINUTES * MS_PER_MINUTE;
    const recent = (failures.get(clientKey) ?? []).filter((at) => at > threshold);
    if (recent.length === 0) {
      failures.delete(clientKey);
    } else {
      failures.set(clientKey, recent);
    }
    return recent;
  }

  function removeSession(session: Session): void {
    sessionsByAccess.delete(session.accessHash);
    sessionsByRefresh.delete(session.refreshHash);
  }

  /** リフレッシュの期限が切れたセッションを掃除する（参照されないまま、メモリに残り続けることを防ぐ）。 */
  function pruneExpiredSessions(): void {
    const nowMs = clock.now().getTime();
    for (const session of sessionsByRefresh.values()) {
      if (nowMs >= session.refreshExpiresAt) {
        removeSession(session);
      }
    }
  }

  function recordFailure(clientKey: string): void {
    const recent = recentFailures(clientKey);
    // 追跡する接続元の数に上限を設ける。Map は挿入順のため、先頭が最も古い
    failures.delete(clientKey);
    failures.set(clientKey, [...recent, clock.now().getTime()]);
    while (failures.size > maxTrackedClients) {
      const oldest = failures.keys().next();
      if (oldest.done === true) {
        break;
      }
      failures.delete(oldest.value);
    }
  }

  /** 世代が一致するユーザーだけを返す。削除後に、同じ ID で再登録されたユーザーは、別のユーザーとして扱う。 */
  async function userOfSession(session: Session): Promise<UserRecord | undefined> {
    const user = await users.get(session.userId);
    return user?.createdAt === session.userCreatedAt ? user : undefined;
  }

  function toPrincipal(user: UserRecord): AuthPrincipal {
    return { userId: user.userId, userName: user.userName, role: user.role };
  }

  function createSession(user: UserRecord): AuthSession {
    const nowMs = clock.now().getTime();
    const accessToken = newToken();
    const refreshToken = newToken();
    pruneExpiredSessions();
    const session: Session = {
      userId: user.userId,
      userCreatedAt: user.createdAt,
      accessHash: sha256(accessToken),
      refreshHash: sha256(refreshToken),
      accessExpiresAt: nowMs + ACCESS_TOKEN_TTL_MINUTES * MS_PER_MINUTE,
      refreshExpiresAt: nowMs + REFRESH_TOKEN_TTL_DAYS * MS_PER_DAY,
    };
    sessionsByAccess.set(session.accessHash, session);
    sessionsByRefresh.set(session.refreshHash, session);
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: new Date(session.accessExpiresAt),
      refreshTokenExpiresAt: new Date(session.refreshExpiresAt),
      principal: toPrincipal(user),
    };
  }

  return {
    async login(credentials, clientKey) {
      if (recentFailures(clientKey).length >= LOGIN_FAILURE_LIMIT) {
        throw new AppError('RATE_LIMITED', LOGIN_LOCKED_MESSAGE);
      }
      const parsedUserId = UserIdSchema.safeParse(credentials.userId);
      const user = parsedUserId.success ? await users.get(parsedUserId.data) : undefined;
      const passwordMatches = verifyPassword(credentials.password, user?.passwordHash ?? dummyHash);
      if (user === undefined || !passwordMatches) {
        recordFailure(clientKey);
        throw new AppError('UNAUTHENTICATED', LOGIN_FAILED_MESSAGE);
      }
      failures.delete(clientKey);
      await users.save({ ...user, lastLoginAt: clock.now().toISOString() });
      return createSession(user);
    },

    async verifyAccessToken(accessToken) {
      const session = sessionsByAccess.get(sha256(accessToken));
      if (session === undefined) {
        return null;
      }
      if (clock.now().getTime() >= session.accessExpiresAt) {
        // アクセストークンだけを無効にする。リフレッシュトークンは残し、画面が、更新して、使い続けられるようにする
        sessionsByAccess.delete(session.accessHash);
        return null;
      }
      // ロール・ユーザー名の変更、ユーザーの削除を、次のリクエストから反映する
      const user = await userOfSession(session);
      return user === undefined ? null : toPrincipal(user);
    },

    async refresh(refreshToken) {
      const session = sessionsByRefresh.get(sha256(refreshToken));
      if (session === undefined || clock.now().getTime() >= session.refreshExpiresAt) {
        if (session !== undefined) {
          removeSession(session);
        }
        throw new AppError('UNAUTHENTICATED', SESSION_INVALID_MESSAGE);
      }
      const user = await userOfSession(session);
      removeSession(session);
      if (user === undefined) {
        throw new AppError('UNAUTHENTICATED', SESSION_INVALID_MESSAGE);
      }
      return createSession(user);
    },

    logout(accessToken) {
      const session = sessionsByAccess.get(sha256(accessToken));
      if (session !== undefined) {
        removeSession(session);
      }
      return Promise.resolve();
    },

    revokeSessionsOf(userId, options = {}) {
      const keepHash =
        options.keepAccessToken === undefined ? undefined : sha256(options.keepAccessToken);
      for (const session of sessionsByRefresh.values()) {
        if (session.userId === userId && session.accessHash !== keepHash) {
          removeSession(session);
        }
      }
      return Promise.resolve();
    },
  };
}
