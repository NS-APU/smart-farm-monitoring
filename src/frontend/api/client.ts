/**
 * API クライアント。`/api/v1` を呼び出し、応答をスキーマで検証する（境界での検証。coding-standards.md）。
 * - 認証トークン（Bearer）を付ける。401 の場合は、リフレッシュトークンで1度だけ更新して再試行する
 * - エラー応答（共通形式）を ApiError に変換する
 * - 応答に ETag があれば、次の同じ GET に If-None-Match を付ける。304（変化なし）なら、前回の本文を使う
 *   （約10秒間隔の読み直しを、小さな応答にする。functional-specification.md 3.1）
 */

import type { z } from 'zod';
import { API_BASE_PATH, ErrorResponseSchema } from '@smart-farm/shared/schemas/api';
import { LoginResponseSchema, type LoginResponse } from '@smart-farm/shared/schemas/auth';
import type { ErrorCode, FieldError } from '@smart-farm/shared/errors';
import { MESSAGES } from '../i18n/messages.ts';
import { createEtagCache } from './etag-cache.ts';

/** サーバーのエラー応答、または通信の失敗。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE';
  readonly fields: readonly FieldError[];

  constructor(
    status: number,
    code: ApiError['code'],
    message: string,
    fields: readonly FieldError[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export interface SessionAccess {
  get(): LoginResponse | null;
  set(session: LoginResponse): void;
  clear(): void;
}

/** 1回の通信の待ち時間の上限（ミリ秒）の既定。応答がなければ、中止して、通信エラーにする。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export interface ApiClientOptions {
  readonly fetchFn: typeof fetch;
  readonly session: SessionAccess;
  /** セッションを更新できず、再ログインが必要になったときに呼ぶ。 */
  readonly onSessionExpired: () => void;
  /** セッションを更新（リフレッシュ）できたときに呼ぶ。サーバーの最新のロール・権限を、画面の表示へ反映する。 */
  readonly onSessionRefreshed?: (session: LoginResponse) => void;
  /** 1回の通信の待ち時間の上限（ミリ秒）。省略すると 20 秒。 */
  readonly timeoutMs?: number;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  /** 認証トークンを付けない（ログイン・更新）。 */
  readonly anonymous?: boolean;
}

export interface ApiClient {
  /** 応答の本文（JSON）を、スキーマで検証して返す。 */
  request<Schema extends z.ZodType>(
    path: string,
    options: RequestOptions & { readonly schema: Schema },
  ): Promise<z.infer<Schema>>;
  /** 応答の本文がない（204）操作。 */
  command(path: string, options?: RequestOptions): Promise<void>;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const queryString = search.toString();
  return `${API_BASE_PATH}${path}${queryString === '' ? '' : `?${queryString}`}`;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const parsed = ErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      const { code, message, fields } = parsed.data.error;
      return new ApiError(response.status, code, message, fields ?? []);
    }
  } catch {
    // 本文が JSON でない場合は、汎用のエラーにする
  }
  return new ApiError(response.status, 'INTERNAL_ERROR', MESSAGES.common.unexpectedError);
}

/** 応答の本文を JSON として読む。JSON でない（プロキシの HTML のエラーページ・空の本文など）場合は undefined。 */
async function readJsonOrUndefined(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const etagCache = createEtagCache();

  async function send(
    path: string,
    requestOptions: RequestOptions,
    accessToken: string | undefined,
    etag?: string,
  ): Promise<Response> {
    const headers = new Headers({ accept: 'application/json' });
    if (accessToken !== undefined) {
      headers.set('authorization', `Bearer ${accessToken}`);
    }
    if (etag !== undefined) {
      headers.set('if-none-match', etag);
    }
    if (requestOptions.body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    // 応答のないサーバーで、画面が読み込み中のまま止まらないよう、待ち時間に上限を設ける（V-060）
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      return await options.fetchFn(buildUrl(path, requestOptions.query), {
        method: requestOptions.method ?? 'GET',
        headers,
        signal: controller.signal,
        ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', MESSAGES.common.networkError);
    } finally {
      clearTimeout(timer);
    }
  }

  /** リフレッシュトークンでセッションを更新する。成功すれば true。 */
  async function refreshSession(): Promise<boolean> {
    const current = options.session.get();
    if (current === null) {
      return false;
    }
    const response = await send(
      '/auth/refresh',
      { method: 'POST', body: { refreshToken: current.refreshToken }, anonymous: true },
      undefined,
    );
    const parsed = response.ok
      ? LoginResponseSchema.safeParse(await readJsonOrUndefined(response))
      : undefined;
    if (parsed?.success !== true) {
      return false;
    }
    options.session.set(parsed.data);
    options.onSessionRefreshed?.(parsed.data);
    return true;
  }

  /**
   * セッションの更新は、同時に1つだけ行う。アクセストークンの期限が切れたとき、複数の読み込み（約10秒の更新）が
   * 同時に 401 になるため、それぞれが更新すると、使用済みのリフレッシュトークンで失敗し、ログアウトになってしまう。
   */
  let pendingRefresh: Promise<boolean> | undefined;
  function refreshSessionOnce(): Promise<boolean> {
    pendingRefresh ??= refreshSession().finally(() => {
      pendingRefresh = undefined;
    });
    return pendingRefresh;
  }

  /** 認証つきで送る。401 は、セッションを更新して、1度だけ再試行する。エラー応答は ApiError にする。 */
  async function execute(
    path: string,
    requestOptions: RequestOptions,
    cachedFor?: (accessToken: string | undefined) => string | undefined,
  ): Promise<Response> {
    const accessToken =
      requestOptions.anonymous === true ? undefined : options.session.get()?.accessToken;
    let response = await send(path, requestOptions, accessToken, cachedFor?.(accessToken));
    if (response.status === 401 && requestOptions.anonymous !== true && accessToken !== undefined) {
      if (await refreshSessionOnce()) {
        const refreshedToken = options.session.get()?.accessToken;
        response = await send(path, requestOptions, refreshedToken, cachedFor?.(refreshedToken));
      } else {
        options.session.clear();
        options.onSessionExpired();
      }
    }
    if (!response.ok && response.status !== 304) {
      throw await toApiError(response);
    }
    return response;
  }

  return {
    async request(path, requestOptions) {
      const isGet = (requestOptions.method ?? 'GET') === 'GET';
      const url = buildUrl(path, requestOptions.query);
      const cached = isGet ? etagCache.lookup(url) : undefined;
      // 更新したトークンで再試行するときも、そのトークンで、前回の ETag を使えるかを判断する
      const response = await execute(path, requestOptions, (accessToken) =>
        cached?.etagFor(accessToken),
      );
      let body: unknown;
      if (response.status === 304) {
        // 変化なし。If-None-Match を付けたときだけ返るので、前回の本文がある
        body = cached?.body;
      } else {
        body = await readJsonOrUndefined(response);
        if (body === undefined) {
          // JSON でない本文（配信経路の障害など）は、構文エラーではなく、不正な応答として扱う
          throw new ApiError(response.status, 'INVALID_RESPONSE', MESSAGES.common.unexpectedError);
        }
        const etag = response.headers.get('etag');
        if (isGet && etag !== null) {
          etagCache.store(url, options.session.get()?.accessToken, etag, body);
        }
      }
      const parsed = requestOptions.schema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError(response.status, 'INVALID_RESPONSE', MESSAGES.common.unexpectedError);
      }
      return parsed.data;
    },
    async command(path, requestOptions = {}) {
      await execute(path, requestOptions);
    },
  };
}
