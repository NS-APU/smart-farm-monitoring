/**
 * ルートごとの実装（ハンドラ）。ハンドラは薄く保つ: 入力の検証 → ユースケースの呼び出し → 応答の変換。
 * 業務のロジックは、アプリケーション層・ドメイン層に置く（ADR-0001）。
 * 領域ごとにファイルを分けている: 観点・観測値（viewpoint-handlers.ts）、手動入力・変更履歴（manual-entry-handlers.ts）、
 * 設定・管理（admin-handlers.ts が、設備・ステータスコード・判断基準・ユーザー・取り込み・購読のファイルをまとめる）。
 * ここには、認証・設備の階層・ダッシュボード・ステータスコードの一覧・通知を置く。
 * ルート一覧（route-table.ts）のすべてにハンドラがなければならない（なければ、起動時にエラー。create-app.ts）。
 */

import { AppError } from '@smart-farm/shared/errors';
import { PageQuerySchema } from '@smart-farm/shared/schemas/api';
import { LoginRequestSchema, RefreshRequestSchema } from '@smart-farm/shared/schemas/auth';
import { NotificationIdSchema } from '@smart-farm/shared/schemas/common';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import type { ApiDeps } from './api-deps.ts';
import { createAdminHandlers } from './admin-handlers.ts';
import { bearerTokenOf } from './auth-guards.ts';
import { clientAddressOf } from './client-address.ts';
import { jsonWithEtag } from './etag.ts';
import { createManualEntryHandlers } from './manual-entry-handlers.ts';
import { HorizonQuerySchema, NotificationFilterSchema } from './query-schemas.ts';
import { actorOf, resolveEquipmentId } from './request-helpers.ts';
import { parseInput, parseJsonBody, parseOptionalJsonBody, parseQuery } from './request-parsing.ts';
import type { RouteHandler } from './route-types.ts';
import { createViewpointHandlers } from './viewpoint-handlers.ts';

const NotificationListQuerySchema = PageQuerySchema.extend(NotificationFilterSchema.shape);

/** ルートのキー（`GET /equipment` の形式）→ ハンドラ。 */
export function createHandlers(deps: ApiDeps): Readonly<Record<string, RouteHandler>> {
  return {
    ...createViewpointHandlers(deps),
    ...createManualEntryHandlers(deps),
    ...createAdminHandlers(deps),

    async 'POST /auth/login'(c) {
      const body = await parseJsonBody(c, LoginRequestSchema);
      // 接続元を取得できない環境では、ユーザーID単位で数える（1人の失敗が、全員のログインを止めない）
      const clientKey =
        clientAddressOf(c, deps.trustedProxyHops) ?? `user-without-address:${body.userId}`;
      return c.json(await deps.authService.login(body.userId, body.password, clientKey));
    },

    async 'POST /auth/refresh'(c) {
      const body = await parseJsonBody(c, RefreshRequestSchema);
      return c.json(await deps.authService.refresh(body.refreshToken));
    },

    async 'POST /auth/logout'(c) {
      const token = bearerTokenOf(c);
      if (token !== undefined) {
        await deps.authService.logout(token);
      }
      return c.body(null, 204);
    },

    async 'GET /equipment'(c) {
      return c.json(await deps.equipmentService.getTree());
    },

    async 'GET /dashboard'(c) {
      const query = parseQuery(c, HorizonQuerySchema);
      return jsonWithEtag(
        c,
        await deps.dashboardQuery.get({
          // 省略時は、最初のハウス（ヘッダーで選択中の設備がない場合）
          equipmentId: await resolveEquipmentId(deps, query.equipmentId),
          horizon: query.horizon,
          periodDays: query.periodDays,
        }),
      );
    },

    async 'GET /status-codes'(c) {
      return c.json(await deps.statusCodeService.list());
    },

    async 'GET /notifications'(c) {
      const query = parseQuery(c, NotificationListQuerySchema);
      return c.json(await deps.notificationService.list(actorOf(c), query));
    },

    async 'GET /notifications/unread-count'(c) {
      return c.json({
        unreadCount: await deps.notificationService.unreadCount(actorOf(c)),
      });
    },

    async 'POST /notifications/read-all'(c) {
      // 絞り込みの範囲（任意）を、本文で受ける。本文がなければ、全件
      const filter = await parseOptionalJsonBody(c, NotificationFilterSchema);
      await deps.notificationService.markAllRead(
        actorOf(c),
        omitUndefined({
          kind: filter.kind,
          readState: filter.readState,
        }),
      );
      return c.body(null, 204);
    },

    async 'POST /notifications/:notificationId/read'(c) {
      const notificationId = parseInput(NotificationIdSchema, c.req.param('notificationId'));
      const found = await deps.notificationService.markRead(notificationId, actorOf(c));
      if (!found) {
        throw new AppError('NOT_FOUND', '通知が見つかりません');
      }
      return c.body(null, 204);
    },
  };
}
