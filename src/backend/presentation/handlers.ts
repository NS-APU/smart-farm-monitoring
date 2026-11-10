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
import {
  ChangePasswordRequestSchema,
  OwnProfileUpdateRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
} from '@smart-farm/shared/schemas/auth';
import { NotificationIdSchema } from '@smart-farm/shared/schemas/common';
import {
  NotificationMemoInputSchema,
  NotificationReadRangeSchema,
  ReadAllRequestSchema,
} from '@smart-farm/shared/schemas/notification';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import type { ApiDeps } from './api-deps.ts';
import { createAdminHandlers } from './admin-handlers.ts';
import { bearerTokenOf } from './auth-guards.ts';
import { clientAddressOf } from './client-address.ts';
import { jsonWithEtag } from './etag.ts';
import { createManualEntryHandlers } from './manual-entry-handlers.ts';
import { HorizonQuerySchema, NotificationFilterSchema, toOptionalDate } from './query-schemas.ts';
import { actorOf, resolveEquipmentId } from './request-helpers.ts';
import { parseInput, parseJsonBody, parseQuery } from './request-parsing.ts';
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
        clientAddressOf(c, deps.trustedProxyHops, deps.clientIpHeader) ??
        `user-without-address:${body.userId}`;
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

    async 'POST /auth/password'(c) {
      const body = await parseJsonBody(c, ChangePasswordRequestSchema);
      const user = actorOf(c);
      // 現在のパスワードの誤りは、ログインの失敗と同じ制限に数える（接続元を取得できない環境では、ユーザーID単位）
      const clientKey =
        clientAddressOf(c, deps.trustedProxyHops, deps.clientIpHeader) ??
        `user-without-address:${user}`;
      const session = await deps.userService.changeOwnPassword(user, body, clientKey);
      return c.json(deps.authService.toLoginResponse(session));
    },

    async 'PUT /auth/profile'(c) {
      const body = await parseJsonBody(c, OwnProfileUpdateRequestSchema);
      return c.json(await deps.userService.updateOwnProfile(actorOf(c), body));
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
      // 範囲（種別・読み込んだ時点）の指定があれば、その範囲の未読の件数（一括既読の確認の件数）。なければ、すべての未読
      const range = parseQuery(c, NotificationReadRangeSchema.partial());
      return c.json({
        unreadCount: await deps.notificationService.unreadCount(actorOf(c), {
          kind: range.kind,
          until: toOptionalDate(range.until),
        }),
      });
    },

    async 'POST /notifications/read-all'(c) {
      // 読み込んだ時点（until）は必須（画面を開いたあとに届いた通知まで、既読にしない。D-39）
      const request = await parseJsonBody(c, ReadAllRequestSchema);
      const markedCount = await deps.notificationService.markAllRead(
        actorOf(c),
        omitUndefined({
          kind: request.kind,
          readState: request.readState,
          until: new Date(request.until),
        }),
      );
      return c.json({ markedCount });
    },

    // 通知のメモ（ADR-0019 の D-42。#239）。追記と一覧のみ（編集・削除はない）
    async 'POST /notifications/:notificationId/memos'(c) {
      const notificationId = parseInput(NotificationIdSchema, c.req.param('notificationId'));
      const input = await parseJsonBody(c, NotificationMemoInputSchema);
      const memo = await deps.notificationService.addMemo(notificationId, actorOf(c), input);
      if (memo === undefined) {
        throw new AppError('NOT_FOUND', '通知が見つかりません');
      }
      return c.json(memo, 201);
    },

    async 'GET /notifications/:notificationId/memos'(c) {
      const notificationId = parseInput(NotificationIdSchema, c.req.param('notificationId'));
      const items = await deps.notificationService.listMemos(notificationId);
      if (items === undefined) {
        throw new AppError('NOT_FOUND', '通知が見つかりません');
      }
      return c.json({ items });
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
