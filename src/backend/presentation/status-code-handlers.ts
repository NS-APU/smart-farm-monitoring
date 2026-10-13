/**
 * ステータスコードのハンドラ（UC-17。SC-12）。一覧の取得（GET /status-codes）は handlers.ts にある。
 * 薄く保つ: 入力の検証 → ユースケースの呼び出し → 応答。
 */

import {
  StatusCodeCreateRequestSchema,
  StatusCodeUpdateRequestSchema,
} from '@smart-farm/shared/schemas/status-code';
import type { ApiDeps } from './api-deps.ts';
import { actorOf, pathParam } from './request-helpers.ts';
import { parseJsonBody } from './request-parsing.ts';
import type { RouteHandler } from './route-types.ts';

export function createStatusCodeHandlers(deps: ApiDeps): Readonly<Record<string, RouteHandler>> {
  return {
    async 'POST /status-codes'(c) {
      const input = await parseJsonBody(c, StatusCodeCreateRequestSchema);
      return c.json(await deps.statusCodeService.create(input, actorOf(c)), 201);
    },
    async 'PUT /status-codes/:code'(c) {
      const input = await parseJsonBody(c, StatusCodeUpdateRequestSchema);
      return c.json(await deps.statusCodeService.update(pathParam(c, 'code'), input, actorOf(c)));
    },
    async 'DELETE /status-codes/:code'(c) {
      await deps.statusCodeService.delete(pathParam(c, 'code'), actorOf(c));
      return c.body(null, 204);
    },
  };
}
