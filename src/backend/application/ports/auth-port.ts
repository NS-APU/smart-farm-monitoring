/**
 * 認証のポート（AuthPort。architecture.md 9章）。
 * 「誰か」の確認だけを担う。「何ができるか」（ロール → 権限）は、アプリケーション層の
 * AccessPolicy（設定）で決める。実装: ローカル（アプリ内のユーザーID・パスワード）。
 * Amazon Cognito 等への差し替えは、このポートの実装の追加で行う（Q-017）。
 */

import type { UserId } from '@smart-farm/shared/schemas/common';

export interface AuthPrincipal {
  readonly userId: UserId;
  readonly userName: string;
  readonly role: string;
}

export interface AuthSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshTokenExpiresAt: Date;
  readonly principal: AuthPrincipal;
}

export interface AuthPort {
  /**
   * ログインする。失敗は、原因を特定できない UNAUTHENTICATED（AppError）。
   * 同じ接続元（clientKey）の試行回数が制限を超えた場合は RATE_LIMITED（AppError）。
   */
  login(
    credentials: { readonly userId: string; readonly password: string },
    clientKey: string,
  ): Promise<AuthSession>;
  /** アクセストークンを検証する。無効・期限切れは null。 */
  verifyAccessToken(accessToken: string): Promise<AuthPrincipal | null>;
  /** リフレッシュトークンで、セッションを更新する。無効・期限切れは UNAUTHENTICATED（AppError）。 */
  refresh(refreshToken: string): Promise<AuthSession>;
  /** セッションを破棄する。 */
  logout(accessToken: string): Promise<void>;
  /**
   * そのユーザーのすべてのセッション（アクセス・リフレッシュ）を失効する。ユーザーの削除・パスワードの再設定で使う
   * （漏えいしたトークン・削除前のトークンが、再登録した同じ IDのユーザーのものとして有効にならないように）。
   * keepAccessToken を指定すると、そのトークンのセッションだけを残す（本人が、自分のパスワードを再設定した場合）。
   */
  revokeSessionsOf(userId: UserId, options?: { readonly keepAccessToken?: string }): Promise<void>;
}
