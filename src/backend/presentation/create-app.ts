/**
 * Hono アプリの組み立て。Node サーバー（ローカル）と Lambda のハンドラ（本番）で、同じアプリを使う。
 * 構成: 構造化ログ → 共通エラー形式 → `/health`（公開）→ `/api/v1`（認証・認可つき）。
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { API_BASE_PATH } from '@smart-farm/shared/schemas/api';
import type { ApiDeps, AppEnv } from './api-deps.ts';
import { createDevRoutes } from './dev-routes.ts';
import { buildErrorBody, handleError, handleNotFound } from './errors.ts';
import { authenticateRequest, requirePermission } from './auth-guards.ts';
import { createHandlers } from './handlers.ts';
import { requestContext } from './middleware.ts';
import { MAX_BODY_BYTES } from './request-parsing.ts';
import { ROUTE_TABLE, routeKey, type RouteSpec } from './route-table.ts';
import type { RouteHandler } from './route-types.ts';

/**
 * Hono アプリを組み立てる。ルート一覧（route-table.ts）のすべてに、ハンドラがなければならない
 * （ハンドラのないルートがある場合は、起動時にエラーにする。認証・認可の宣言だけが残ることを防ぐ）。
 */
export function createApp(deps: ApiDeps, routes: readonly RouteSpec[] = ROUTE_TABLE): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requestContext(deps.logger));
  app.onError(handleError);
  app.notFound(handleNotFound);

  // ヘルスチェック。農業情報基盤など外部の状態には依存しない（停止でアプリケーションを異常とみなさない）
  app.get('/health', (c) => c.json({ status: 'ok', time: deps.clock.now().toISOString() }));

  const api = new Hono<AppEnv>();
  api.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(buildErrorBody('VALIDATION_ERROR', 'リクエストが大きすぎます'), 413),
    }),
  );

  const handlers = createHandlers(deps);
  function guarded(spec: RouteSpec, handler: RouteHandler): RouteHandler {
    return async (c) => {
      if (spec.access !== 'PUBLIC') {
        await authenticateRequest(c, deps.authService);
        if (spec.access !== 'LOGIN') {
          requirePermission(c, spec.access);
        }
      }
      return handler(c);
    };
  }
  for (const spec of routes) {
    const handler = handlers[routeKey(spec)];
    if (handler === undefined) {
      throw new Error(`ルートのハンドラが定義されていません: ${routeKey(spec)}`);
    }
    api.on(spec.method, spec.path, guarded(spec, handler));
  }
  if (deps.dev !== undefined) {
    api.route('/dev', createDevRoutes(deps, deps.dev));
  }

  app.route(API_BASE_PATH, api);
  return app;
}
