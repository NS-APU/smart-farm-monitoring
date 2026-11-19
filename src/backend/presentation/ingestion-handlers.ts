/**
 * 取り込み設定・状況、連携の状況のハンドラ（UC-15、UC-16。SC-11）。
 * 薄く保つ: 入力の検証 → ユースケースの呼び出し → 応答。
 */

import { z } from 'zod';
import { PageQuerySchema } from '@smart-farm/shared/schemas/api';
import { EquipmentIdSchema, IsoDateTimeSchema } from '@smart-farm/shared/schemas/common';
import { FederationSettingsUpdateRequestSchema } from '@smart-farm/shared/schemas/federation-connection';
import {
  EquipmentConnectionUpdateSchema,
  IngestionCredentialsInputSchema,
  IngestionSettingsUpdateRequestSchema,
} from '@smart-farm/shared/schemas/ingestion';
import type { ApiDeps } from './api-deps.ts';
import { actorOf, pathParam, scopeOfRequest } from './request-helpers.ts';
import { parseInput, parseJsonBody, parseQuery } from './request-parsing.ts';
import type { RouteHandler } from './route-types.ts';

/** 取り込みログの絞り込み（Issue #201）。結果: SUCCESS＝成功、FAILURE＝失敗（一部成功を含む）。期間: 開始日時（両端を含む）。 */
const IngestionLogQuerySchema = PageQuerySchema.extend({
  sourceId: z.string().min(1).max(100).optional(),
  equipmentId: z.string().min(1).max(100).optional(),
  result: z.enum(['SUCCESS', 'FAILURE']).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
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
    async 'PUT /ingestion/:sourceId/credentials'(c) {
      const input = await parseJsonBody(c, IngestionCredentialsInputSchema);
      return c.json(
        await deps.ingestionAdminService.setCredentials(
          pathParam(c, 'sourceId'),
          input,
          actorOf(c),
        ),
      );
    },
    // 設備ごとの接続（Issue #367。ADR-0026）
    async 'PUT /ingestion/equipment/:equipmentId/connection'(c) {
      const equipmentId = parseInput(EquipmentIdSchema, pathParam(c, 'equipmentId'));
      const input = await parseJsonBody(c, EquipmentConnectionUpdateSchema);
      return c.json(
        await deps.ingestionAdminService.setEquipmentConnection(
          equipmentId,
          input.connection,
          actorOf(c),
        ),
      );
    },
    async 'DELETE /ingestion/equipment/:equipmentId/connection'(c) {
      const equipmentId = parseInput(EquipmentIdSchema, pathParam(c, 'equipmentId'));
      return c.json(
        await deps.ingestionAdminService.clearEquipmentConnection(equipmentId, actorOf(c)),
      );
    },
    async 'PUT /ingestion/equipment/:equipmentId/credentials'(c) {
      const equipmentId = parseInput(EquipmentIdSchema, pathParam(c, 'equipmentId'));
      const input = await parseJsonBody(c, IngestionCredentialsInputSchema);
      return c.json(
        await deps.ingestionAdminService.setEquipmentCredentials(equipmentId, input, actorOf(c)),
      );
    },
    async 'POST /ingestion/equipment/:equipmentId/test'(c) {
      const equipmentId = parseInput(EquipmentIdSchema, pathParam(c, 'equipmentId'));
      return c.json(await deps.ingestionAdminService.testEquipmentConnection(equipmentId));
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
      return c.json(
        await deps.ingestionAdminService.listLogs({
          ...query,
          from: query.from === undefined ? undefined : new Date(query.from),
          to: query.to === undefined ? undefined : new Date(query.to),
        }),
      );
    },
    // 連携先の設定（接続先は書き込み専用。ADR-0024。Issue #177）
    async 'GET /federation/settings'(c) {
      return c.json(await deps.federationAdminService.describe());
    },
    async 'PUT /federation/settings'(c) {
      const input = await parseJsonBody(c, FederationSettingsUpdateRequestSchema);
      return c.json(await deps.federationAdminService.update(input, actorOf(c)));
    },
    async 'POST /federation/test'(c) {
      return c.json(await deps.federationAdminService.test());
    },
    async 'GET /federation/logs'(c) {
      const query = parseQuery(c, PageQuerySchema);
      return c.json(await deps.ingestionAdminService.listFederationLogs(query));
    },
    // ハウス別の記録（一般ユーザー向け。閲覧できるハウスの分だけ。Issue #332）
    async 'GET /ingestion/facility-logs'(c) {
      const query = parseQuery(c, PageQuerySchema);
      return c.json(
        await deps.facilityLogService.listIngestionLogs(await scopeOfRequest(c, deps), query),
      );
    },
    async 'GET /federation/facility-logs'(c) {
      const query = parseQuery(c, PageQuerySchema);
      return c.json(
        await deps.facilityLogService.listFederationLogs(await scopeOfRequest(c, deps), query),
      );
    },
  };
}
