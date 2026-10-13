/**
 * 取り込み設定・状況、連携の状況のハンドラ（UC-15、UC-16。SC-11）。
 * 薄く保つ: 入力の検証 → ユースケースの呼び出し → 応答。
 */

import { z } from 'zod';
import { PageQuerySchema } from '@smart-farm/shared/schemas/api';
import { IngestionSettingsUpdateRequestSchema } from '@smart-farm/shared/schemas/ingestion';
import type { ApiDeps } from './api-deps.ts';
import { actorOf, pathParam } from './request-helpers.ts';
import { parseJsonBody, parseQuery } from './request-parsing.ts';
import type { RouteHandler } from './route-types.ts';

const IngestionLogQuerySchema = PageQuerySchema.extend({
  sourceId: z.string().min(1).max(100).optional(),
});

export function createIngestionHandlers(deps: ApiDeps): Readonly<Record<string, RouteHandler>> {
  return {
    async 'GET /ingestion/settings'(c) {
      return c.json(await deps.ingestionAdminService.describe());
    },
    async 'PUT /ingestion/settings'(c) {
      const input = await parseJsonBody(c, IngestionSettingsUpdateRequestSchema);
      return c.json(await deps.ingestionAdminService.update(input, actorOf(c)));
    },
    async 'POST /ingestion/:sourceId/test'(c) {
      return c.json(await deps.ingestionService.testConnection(pathParam(c, 'sourceId')));
    },
    async 'POST /ingestion/:sourceId/run'(c) {
      // ローカルでは、実行を待って、結果の概要を返す（本番は非同期に実行し、結果は取り込みログで確認する）
      return c.json(await deps.ingestionService.runSource(pathParam(c, 'sourceId')), 202);
    },
    async 'GET /ingestion/logs'(c) {
      const query = parseQuery(c, IngestionLogQuerySchema);
      return c.json(await deps.ingestionAdminService.listLogs(query));
    },
    async 'GET /federation/logs'(c) {
      const query = parseQuery(c, PageQuerySchema);
      return c.json(await deps.ingestionAdminService.listFederationLogs(query));
    },
  };
}
