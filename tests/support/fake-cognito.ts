/**
 * 偽の Cognito（テスト用）。Cognito のクライアントの `send` だけを持つ。実際の AWS には、接続しない。
 * Cognito のユーザー・パスワード・アクセストークン・リフレッシュトークンの、有効期限と失効を、再現する
 * （エラーの名前は、実際の Cognito と同じ。アダプタは、名前で判定する）。
 *
 * 再現している範囲: 管理者の操作（ユーザーの作成・パスワードの設定・削除・全端末のログアウト）、パスワードでの認証、
 * リフレッシュトークンでの更新、アクセストークンでのユーザーの取得とログアウト。再現していないもの:
 * ユーザーごとの一時的なロック、チャレンジ（追加の認証）、トークンの回転。
 * トークンの長さは、実際の Cognito に近い（アクセストークン 約 1,000 文字、リフレッシュトークン 約 1,500 文字）。
 * 短いトークンでは、入力の長さの上限（API の検証）の不具合を、見つけられない（Issue #95）。
 * AWS SDK は、`src/backend` の依存で、`tests/` からは読み込めないため、コマンドは、クラス名で見分ける。
 */

import { randomBytes } from 'node:crypto';

export interface FakeCognitoOptions {
  readonly userPoolId: string;
  readonly clientId: string;
  /** 現在の時刻（トークンの期限の判定）。 */
  readonly now: () => Date;
}

export interface RecordedCall {
  readonly command: string;
  readonly input: Record<string, unknown>;
}

interface FakeUser {
  password: string | undefined;
}

interface FakeToken {
  readonly username: string;
  readonly expiresAt: number;
  revoked: boolean;
}

const ACCESS_TOKEN_SECONDS = 30 * 60;
const REFRESH_TOKEN_SECONDS = 7 * 24 * 60 * 60;
const PASSWORD_MIN_LENGTH = 8;

class FakeCognitoError extends Error {
  constructor(name: string, message = name) {
    super(message);
    this.name = name;
  }
}

/** 実際の Cognito に近い長さ（base64url で、約 1,000 文字・約 1,500 文字）。 */
const ACCESS_TOKEN_BYTES = 750;
const REFRESH_TOKEN_BYTES = 1125;

function newToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function satisfiesPolicy(password: string): boolean {
  return (
    password.length >= PASSWORD_MIN_LENGTH &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

export interface FakeCognito {
  send(command: {
    readonly constructor: { readonly name: string };
    readonly input: unknown;
  }): Promise<unknown>;
  /** 受け取った呼び出し（古い順）。 */
  readonly calls: RecordedCall[];
  /** 次の、指定したコマンドを、エラーにする（1 回だけ）。 */
  failNext(commandName: string, error: Error): void;
  hasUser(username: string): boolean;
  /** パスワードが設定されているか（ユーザーがいなければ、false）。 */
  hasPassword(username: string): boolean;
  /** 有効な（失効・期限切れでない）アクセストークンの数。 */
  activeAccessTokens(username: string): number;
  /** パスワードなしでユーザーを作る（記録のない、残ったユーザーを、再現する）。 */
  addOrphanUser(username: string): void;
}

export function createFakeCognito(options: FakeCognitoOptions): FakeCognito {
  const users = new Map<string, FakeUser>();
  const accessTokens = new Map<string, FakeToken>();
  const refreshTokens = new Map<string, FakeToken>();
  const calls: RecordedCall[] = [];
  const failures = new Map<string, Error>();

  function nowMs(): number {
    return options.now().getTime();
  }

  function isActive(token: FakeToken | undefined): token is FakeToken {
    return (
      token !== undefined &&
      !token.revoked &&
      nowMs() < token.expiresAt &&
      users.has(token.username)
    );
  }

  function revokeAll(username: string): void {
    for (const token of [...accessTokens.values(), ...refreshTokens.values()]) {
      if (token.username === username) {
        token.revoked = true;
      }
    }
  }

  function issueAccessToken(username: string): string {
    const token = newToken(ACCESS_TOKEN_BYTES);
    accessTokens.set(token, {
      username,
      expiresAt: nowMs() + ACCESS_TOKEN_SECONDS * 1000,
      revoked: false,
    });
    return token;
  }

  function requireUser(username: unknown): string {
    if (typeof username !== 'string' || !users.has(username)) {
      throw new FakeCognitoError('UserNotFoundException');
    }
    return username;
  }

  function checkPool(input: Record<string, unknown>): void {
    if (input.UserPoolId !== undefined && input.UserPoolId !== options.userPoolId) {
      throw new FakeCognitoError('ResourceNotFoundException');
    }
    if (input.ClientId !== undefined && input.ClientId !== options.clientId) {
      throw new FakeCognitoError('ResourceNotFoundException');
    }
  }

  const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
    AdminInitiateAuthCommand(input) {
      const parameters = (input.AuthParameters ?? {}) as Record<string, string>;
      if (input.AuthFlow === 'ADMIN_USER_PASSWORD_AUTH') {
        const username = parameters.USERNAME ?? '';
        const user = users.get(username);
        // ユーザーの存在を、推測させない（PreventUserExistenceErrors）
        if (user?.password === undefined || user.password !== parameters.PASSWORD) {
          throw new FakeCognitoError('NotAuthorizedException', 'Incorrect username or password.');
        }
        const refreshToken = newToken(REFRESH_TOKEN_BYTES);
        refreshTokens.set(refreshToken, {
          username,
          expiresAt: nowMs() + REFRESH_TOKEN_SECONDS * 1000,
          revoked: false,
        });
        return {
          AuthenticationResult: {
            AccessToken: issueAccessToken(username),
            RefreshToken: refreshToken,
            ExpiresIn: ACCESS_TOKEN_SECONDS,
          },
        };
      }
      if (input.AuthFlow === 'REFRESH_TOKEN_AUTH') {
        const token = refreshTokens.get(parameters.REFRESH_TOKEN ?? '');
        if (!isActive(token)) {
          throw new FakeCognitoError('NotAuthorizedException', 'Invalid Refresh Token');
        }
        return {
          AuthenticationResult: {
            AccessToken: issueAccessToken(token.username),
            ExpiresIn: ACCESS_TOKEN_SECONDS,
          },
        };
      }
      throw new FakeCognitoError('InvalidParameterException');
    },
    GetUserCommand(input) {
      const token = accessTokens.get(String(input.AccessToken));
      if (!isActive(token)) {
        throw new FakeCognitoError('NotAuthorizedException', 'Invalid Access Token');
      }
      return { Username: token.username };
    },
    GlobalSignOutCommand(input) {
      const token = accessTokens.get(String(input.AccessToken));
      if (!isActive(token)) {
        throw new FakeCognitoError('NotAuthorizedException', 'Invalid Access Token');
      }
      revokeAll(token.username);
      return {};
    },
    AdminUserGlobalSignOutCommand(input) {
      revokeAll(requireUser(input.Username));
      return {};
    },
    AdminCreateUserCommand(input) {
      const username = String(input.Username);
      if (users.has(username)) {
        throw new FakeCognitoError('UsernameExistsException');
      }
      users.set(username, { password: undefined });
      return { User: { Username: username } };
    },
    AdminSetUserPasswordCommand(input) {
      const username = requireUser(input.Username);
      const password = String(input.Password);
      if (!satisfiesPolicy(password)) {
        throw new FakeCognitoError('InvalidPasswordException');
      }
      const user = users.get(username);
      if (user !== undefined) {
        user.password = password;
      }
      return {};
    },
    AdminDeleteUserCommand(input) {
      const username = requireUser(input.Username);
      revokeAll(username);
      users.delete(username);
      return {};
    },
  };

  return {
    calls,
    send(command) {
      const name = command.constructor.name;
      const input = command.input as Record<string, unknown>;
      calls.push({ command: name, input });
      const injected = failures.get(name);
      if (injected !== undefined) {
        failures.delete(name);
        return Promise.reject(injected);
      }
      const handler = handlers[name];
      if (handler === undefined) {
        return Promise.reject(new FakeCognitoError('InvalidParameterException', `未対応: ${name}`));
      }
      try {
        checkPool(input);
        return Promise.resolve(handler(input));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    failNext(commandName, error) {
      failures.set(commandName, error);
    },
    hasUser: (username) => users.has(username),
    hasPassword: (username) => users.get(username)?.password !== undefined,
    activeAccessTokens: (username) =>
      [...accessTokens.values()].filter((token) => token.username === username && isActive(token))
        .length,
    addOrphanUser(username) {
      users.set(username, { password: undefined });
    },
  };
}

/** 実際の Cognito と同じ名前の、エラー（テストで、注入する）。 */
export function cognitoError(name: string, message = name): Error {
  return new FakeCognitoError(name, message);
}
