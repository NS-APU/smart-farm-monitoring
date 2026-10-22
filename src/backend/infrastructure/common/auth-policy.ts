/**
 * 認証の方針の値（ローカルの実装と Cognito の実装で共通）。FR-9.2・FR-9.3。
 * Cognito のアプリクライアントの有効期限（IaC。infra/lib/data-stack.ts）も、この値に合わせる。
 */

export const ACCESS_TOKEN_TTL_MINUTES = 30;
export const REFRESH_TOKEN_TTL_DAYS = 7;
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MINUTES = 15;

/** ログインの失敗の理由は、利用者に特定させない（ユーザーIDの存在を推測させない）。 */
export const LOGIN_FAILED_MESSAGE = 'ユーザーIDまたはパスワードが正しくありません';
export const SESSION_INVALID_MESSAGE = 'セッションが無効です。もう一度ログインしてください';
export const LOGIN_LOCKED_MESSAGE =
  'ログインの試行回数が上限を超えました。しばらくしてからやり直してください';
