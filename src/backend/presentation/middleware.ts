/**
 * ミドルウェア: リクエストの文脈（識別子・構造化ログ）。
 * 認証・認可の補助は auth-guards.ts、本文・クエリの読み取りは request-parsing.ts、ETag は etag.ts にある。
 */

import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AuthenticatedUser } from '@smart-farm/shared/schemas/auth';
import type { Logger } from '../application/ports/logger-port.ts';
import type { AppEnv } from './api-deps.ts';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** リクエストの識別子を付け、アクセスログを構造化ログで出す（本文・クエリ・認証情報は出力しない）。 */
export function requestContext(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const supplied = c.req.header('x-request-id');
    const requestId =
      supplied !== undefined && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
    const requestLogger = logger.child({ requestId });
    c.set('requestId', requestId);
    c.set('logger', requestLogger);
    const startedAt = performance.now();
    await next();
    c.header('x-request-id', requestId);
    // 運用データは機密のため、キャッシュさせない
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    // API の応答は、JSON のみ（画面・スクリプトとして解釈させない）。他のサイトへの埋め込み・参照元の送信も禁止する（V-015）
    c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'no-referrer');
    // HTTPS での配信を前提とする（HTTP の応答では、ブラウザは無視する）
    c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    // 操作者（認証後にコンテキストへ設定される。未認証・公開ルートでは、ない）と、対象の設備を残す（本文・クエリの全体は残さない。V-099）
    // 認証前（公開ルート・認証の失敗）は、設定されていない。型は、認証後の前提のため、未設定の可能性を明示する
    const user = c.get('user') as AuthenticatedUser | undefined;
    const userId = user?.userId;
    const equipmentId = c.req.query('equipmentId');
    requestLogger.info('リクエスト', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - startedAt),
      ...(userId === undefined ? {} : { userId }),
      ...(equipmentId === undefined ? {} : { equipmentId }),
    });
  };
}
