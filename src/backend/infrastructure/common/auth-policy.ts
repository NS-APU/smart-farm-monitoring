/**
 * 認証の方針の値（ローカルの実装と Cognito の実装で共通）。FR-9.2・FR-9.3。
 * Cognito のアプリクライアントの有効期限（IaC。infra/lib/data-stack.ts）も、この値に合わせる。
 */

export const ACCESS_TOKEN_TTL_MINUTES = 30;
export const REFRESH_TOKEN_TTL_DAYS = 7;
/** 接続元ごとのログインの失敗の制限の、既定の値（失敗 5 回 / 15 分。環境変数で変えられる。Issue #244。D-44）。 */
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MINUTES = 15;
/**
 * 設定できる範囲（これを超える値は、設定の誤りとみなす）。回数の上限は、失敗の時刻を、回数の分だけ DynamoDB に持つため、
 * 記録が大きくならない値にする。時間の上限は、24 時間。
 */
export const MIN_LOGIN_FAILURE_LIMIT = 1;
export const MAX_LOGIN_FAILURE_LIMIT = 100;
export const MIN_LOGIN_FAILURE_WINDOW_MINUTES = 1;
export const MAX_LOGIN_FAILURE_WINDOW_MINUTES = 1440;

/** 接続元ごとのログインの失敗の制限: 同じ接続元から、`windowMinutes` 分のうちに、失敗が `limit` 回に達したら、一時的に拒否する。 */
export interface LoginFailurePolicy {
  readonly limit: number;
  readonly windowMinutes: number;
}

export const DEFAULT_LOGIN_FAILURE_POLICY: LoginFailurePolicy = {
  limit: LOGIN_FAILURE_LIMIT,
  windowMinutes: LOGIN_FAILURE_WINDOW_MINUTES,
};

/** ログインの失敗の理由は、利用者に特定させない（ユーザーIDの存在を推測させない）。 */
export const LOGIN_FAILED_MESSAGE = 'ユーザーIDまたはパスワードが正しくありません';
export const SESSION_INVALID_MESSAGE = 'セッションが無効です。もう一度ログインしてください';
export const LOGIN_LOCKED_MESSAGE =
  'ログインの試行回数が上限を超えました。しばらくしてからやり直してください';
