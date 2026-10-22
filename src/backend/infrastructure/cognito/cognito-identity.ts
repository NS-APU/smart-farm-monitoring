/**
 * 認証・資格情報の Cognito 実装（AuthPort・CredentialPort。ADR-0008）。
 *
 * 役割分担:
 * - Cognito: ユーザーID（ユーザー名）・パスワード・ログイン・トークンの発行と更新・セッションの失効
 * - アプリ（DynamoDB の USER）: ユーザー名・ロール・最終ログイン日時・作成日時。ロールの変更・ユーザーの削除は、
 *   記録を引くため、次のリクエストから反映される（ローカルの実装と同じ）
 *
 * 方式:
 * - 画面は、これまでどおり、API のログイン（ユーザーID・パスワード）を使う。API が、サーバー側（IAM の権限）で
 *   Cognito を呼ぶ（AdminInitiateAuth）。アプリクライアントは、画面（ブラウザ）には出ない
 * - アクセストークンの検証は、リクエストごとに、Cognito へ問い合わせる（GetUser）。パスワードの再設定・ログアウト・
 *   ユーザーの削除が、アクセストークンにも、すぐ効く（署名のローカル検証では、期限まで有効のまま）
 * - ログインの試行回数の制限（同じ接続元。FR-9.2）は、複数の実行環境で共有するため、ポート（LoginThrottlePort）の実装に任せる。
 *   Cognito 自身の、ユーザーごとの一時的なロックも、働く
 * - リフレッシュトークンは、更新しても、同じものを返す（回転しない設定）。有効期限は、Cognito が検証する
 *
 * ローカルの実装との違い（ADR-0008）:
 * - ログアウト・パスワードの再設定は、そのユーザーの、すべての端末のセッションを終了する（Cognito は、端末ごとに選べない）。
 *   本人が自分のパスワードを再設定した場合も、現在のセッションは残らず、再ログインになる（keepAccessToken は使わない）
 */

import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  GetUserCommand,
  GlobalSignOutCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { AppError, validationError } from '@smart-farm/shared/errors';
import { UserIdSchema, type UserId } from '@smart-farm/shared/schemas/common';
import { MS_PER_DAY } from '@smart-farm/shared/time';
import type { AuthPort, AuthPrincipal, AuthSession } from '../../application/ports/auth-port.ts';
import type { ClockPort } from '../../application/ports/clock-port.ts';
import type { CredentialPort, StoredCredential } from '../../application/ports/credential-port.ts';
import type { LoginThrottlePort } from '../../application/ports/login-throttle-port.ts';
import type { UserRecord } from '../../application/ports/records.ts';
import type { UserRepository } from '../../application/ports/repositories.ts';
import {
  LOGIN_FAILED_MESSAGE,
  LOGIN_LOCKED_MESSAGE,
  REFRESH_TOKEN_TTL_DAYS,
  SESSION_INVALID_MESSAGE,
} from '../common/auth-policy.ts';

export interface CognitoIdentityDeps {
  /** Cognito のクライアント（テストでは、偽のクライアントを渡す）。 */
  readonly client: Pick<CognitoIdentityProviderClient, 'send'>;
  readonly userPoolId: string;
  readonly clientId: string;
  readonly users: UserRepository;
  readonly clock: ClockPort;
  readonly throttle: LoginThrottlePort;
}

export interface CognitoIdentity {
  readonly auth: AuthPort;
  readonly credentials: CredentialPort;
}

/** 認証・トークンが、受け付けられなかった（資格情報の誤り・存在しない・失効・期限切れ）ことを示す Cognito のエラー。 */
const REJECTED = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'PasswordResetRequiredException',
  'UserNotConfirmedException',
]);
/** 形式が不正なトークン（利用者の入力）も、受け付けられなかったものとして扱う。 */
const REJECTED_TOKEN = new Set([...REJECTED, 'InvalidParameterException']);
/** Cognito の API の呼び出しが、多すぎる。 */
const THROTTLED = new Set(['TooManyRequestsException', 'LimitExceededException']);

function errorNameOf(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function isOneOf(error: unknown, names: ReadonlySet<string>): boolean {
  const name = errorNameOf(error);
  return name !== undefined && names.has(name);
}

function isNamed(error: unknown, name: string): boolean {
  return errorNameOf(error) === name;
}

export function createCognitoIdentity(deps: CognitoIdentityDeps): CognitoIdentity {
  const { client, userPoolId, clientId, users, clock, throttle } = deps;

  function toPrincipal(user: UserRecord): AuthPrincipal {
    return { userId: user.userId, userName: user.userName, role: user.role };
  }

  /** アクセストークンの持ち主（Cognito が検証）の記録（ロール）。トークンが無効、または記録がなければ null。 */
  async function userOfToken(accessToken: string): Promise<UserRecord | null> {
    let username: string | undefined;
    try {
      username = (await client.send(new GetUserCommand({ AccessToken: accessToken }))).Username;
    } catch (error) {
      if (isOneOf(error, REJECTED_TOKEN)) {
        return null;
      }
      throw error;
    }
    const userId = UserIdSchema.safeParse(username);
    // 記録のないユーザー（Cognito にだけいる）は、ロールがなく、使えない
    return userId.success ? ((await users.get(userId.data)) ?? null) : null;
  }

  function sessionOf(
    tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number },
    user: UserRecord,
  ): AuthSession {
    const nowMs = clock.now().getTime();
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: new Date(nowMs + tokens.expiresInSeconds * 1000),
      // リフレッシュトークンの期限は、Cognito が検証する。ここは、発行・更新の時点からの目安（画面は、使わない）
      refreshTokenExpiresAt: new Date(nowMs + REFRESH_TOKEN_TTL_DAYS * MS_PER_DAY),
      principal: toPrincipal(user),
    };
  }

  /** Cognito に、パスワードなしのユーザーを作る。すでにいれば（記録のない、残った資格情報）、false。 */
  async function createUser(userId: UserId): Promise<boolean> {
    try {
      await client.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: userId,
          // 招待のメール・SMS は送らない（利用者のメールアドレスを持たない）
          MessageAction: 'SUPPRESS',
        }),
      );
      return true;
    } catch (error) {
      if (isNamed(error, 'UsernameExistsException')) {
        return false;
      }
      throw error;
    }
  }

  async function setPassword(userId: UserId, password: string): Promise<void> {
    try {
      await client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: userId,
          Password: password,
          Permanent: true,
        }),
      );
    } catch (error) {
      if (isNamed(error, 'InvalidPasswordException')) {
        throw validationError([
          { name: 'password', message: 'パスワードが、パスワードの条件を満たしていません' },
        ]);
      }
      throw error;
    }
  }

  async function signOutEverywhere(userId: UserId): Promise<void> {
    try {
      await client.send(
        new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: userId }),
      );
    } catch (error) {
      if (!isNamed(error, 'UserNotFoundException')) {
        throw error;
      }
    }
  }

  async function remove(userId: UserId): Promise<void> {
    try {
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: userId }));
    } catch (error) {
      if (!isNamed(error, 'UserNotFoundException')) {
        throw error;
      }
    }
  }

  async function register(userId: UserId, password: string): Promise<StoredCredential> {
    const created = await createUser(userId);
    try {
      await setPassword(userId, password);
    } catch (error) {
      if (created) {
        // パスワードを設定できなかったら、作ったユーザーを戻す（パスワードのないユーザーを、残さない）
        await remove(userId).catch(() => undefined);
      }
      throw error;
    }
    if (!created) {
      // 記録のないまま残っていた資格情報を引き継ぐときは、古いセッションを失効する
      await signOutEverywhere(userId);
    }
    return {};
  }

  const auth: AuthPort = {
    async login(credentials, clientKey) {
      if (await throttle.isLocked(clientKey)) {
        throw new AppError('RATE_LIMITED', LOGIN_LOCKED_MESSAGE);
      }
      const userId = UserIdSchema.safeParse(credentials.userId);
      if (!userId.success) {
        await throttle.recordFailure(clientKey);
        throw new AppError('UNAUTHENTICATED', LOGIN_FAILED_MESSAGE);
      }
      let result;
      try {
        result = await client.send(
          new AdminInitiateAuthCommand({
            UserPoolId: userPoolId,
            ClientId: clientId,
            AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
            AuthParameters: { USERNAME: userId.data, PASSWORD: credentials.password },
          }),
        );
      } catch (error) {
        if (isOneOf(error, THROTTLED)) {
          throw new AppError('RATE_LIMITED', LOGIN_LOCKED_MESSAGE);
        }
        if (isOneOf(error, REJECTED)) {
          await throttle.recordFailure(clientKey);
          throw new AppError('UNAUTHENTICATED', LOGIN_FAILED_MESSAGE);
        }
        throw error;
      }
      const tokens = result.AuthenticationResult;
      const user = await users.get(userId.data);
      if (
        tokens?.AccessToken === undefined ||
        tokens.RefreshToken === undefined ||
        user === undefined
      ) {
        // 追加の認証（チャレンジ）が必要・記録（ロール）のないユーザーは、ログインさせない
        await throttle.recordFailure(clientKey);
        throw new AppError('UNAUTHENTICATED', LOGIN_FAILED_MESSAGE);
      }
      await throttle.reset(clientKey);
      await users.save({ ...user, lastLoginAt: clock.now().toISOString() });
      return sessionOf(
        {
          accessToken: tokens.AccessToken,
          refreshToken: tokens.RefreshToken,
          expiresInSeconds: tokens.ExpiresIn ?? 0,
        },
        user,
      );
    },

    async verifyAccessToken(accessToken) {
      const user = await userOfToken(accessToken);
      return user === null ? null : toPrincipal(user);
    },

    async refresh(refreshToken) {
      let result;
      try {
        result = await client.send(
          new AdminInitiateAuthCommand({
            UserPoolId: userPoolId,
            ClientId: clientId,
            AuthFlow: 'REFRESH_TOKEN_AUTH',
            AuthParameters: { REFRESH_TOKEN: refreshToken },
          }),
        );
      } catch (error) {
        if (isOneOf(error, REJECTED_TOKEN)) {
          throw new AppError('UNAUTHENTICATED', SESSION_INVALID_MESSAGE);
        }
        throw error;
      }
      const tokens = result.AuthenticationResult;
      const user = tokens?.AccessToken === undefined ? null : await userOfToken(tokens.AccessToken);
      if (tokens?.AccessToken === undefined || user === null) {
        throw new AppError('UNAUTHENTICATED', SESSION_INVALID_MESSAGE);
      }
      return sessionOf(
        {
          accessToken: tokens.AccessToken,
          // 回転しない設定では、更新しても、同じリフレッシュトークンを使い続ける
          refreshToken: tokens.RefreshToken ?? refreshToken,
          expiresInSeconds: tokens.ExpiresIn ?? 0,
        },
        user,
      );
    },

    async logout(accessToken) {
      try {
        await client.send(new GlobalSignOutCommand({ AccessToken: accessToken }));
      } catch (error) {
        // すでに無効なトークンは、ログアウト済みと同じ
        if (!isOneOf(error, REJECTED_TOKEN)) {
          throw error;
        }
      }
    },

    // keepAccessToken は、使わない（Cognito は、端末ごとに、セッションを選べない。本人も、再ログインになる）
    revokeSessionsOf: (userId) => signOutEverywhere(userId),
  };

  const credentials: CredentialPort = {
    register,
    async reset(userId, password) {
      try {
        await setPassword(userId, password);
      } catch (error) {
        if (!isNamed(error, 'UserNotFoundException')) {
          throw error;
        }
        // 記録はあるのに、Cognito にいないユーザーは、作り直す
        return register(userId, password);
      }
      return {};
    },
    remove,
  };

  return { auth, credentials };
}
