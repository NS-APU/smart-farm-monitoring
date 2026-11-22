/**
 * Web Push の購読のハンドラ（UC-23。SC-15）。
 * 薄く保つ: 入力の検証 → ユースケースの呼び出し → 応答。
 */

import {
  PushSubscriptionRequestSchema,
  PushTestRequestSchema,
} from '@smart-farm/shared/schemas/notification';
import type { ApiDeps } from './api-deps.ts';
import { EndpointOnlySchema } from './query-schemas.ts';
import { actorOf } from './request-helpers.ts';
import { parseJsonBody, parseOptionalJsonBody, parseQuery } from './request-parsing.ts';
import type { RouteHandler } from './route-types.ts';

export function createPushSubscriptionHandlers(
  deps: ApiDeps,
): Readonly<Record<string, RouteHandler>> {
  return {
    // 端末（endpoint）を指定すると、その端末の購読が有効かを返す
    async 'GET /push-subscription'(c) {
      const query = parseQuery(c, EndpointOnlySchema);
      return c.json(await deps.pushSubscriptionService.status(actorOf(c), query.endpoint));
    },
    async 'PUT /push-subscription'(c) {
      const input = await parseJsonBody(c, PushSubscriptionRequestSchema);
      await deps.pushSubscriptionService.subscribe(actorOf(c), input.endpoint, input.keys);
      return c.body(null, 204);
    },
    // この端末へのテスト通知（自分の購読だけ。1 分に 1 回まで。通知の記録は作らない。#159 SC-15-2）
    async 'POST /push-subscription/test'(c) {
      const input = await parseJsonBody(c, PushTestRequestSchema);
      await deps.pushSubscriptionService.sendTest(actorOf(c), input.endpoint);
      return c.body(null, 204);
    },
    async 'DELETE /push-subscription'(c) {
      const input = await parseOptionalJsonBody(c, EndpointOnlySchema);
      await deps.pushSubscriptionService.unsubscribe(actorOf(c), input.endpoint);
      return c.body(null, 204);
    },
  };
}
