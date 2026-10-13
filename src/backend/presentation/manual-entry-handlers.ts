/**
 * 手動入力・変更履歴のハンドラ（UC-06、UC-07、UC-18。SC-06〜SC-08）。
 * 薄く保つ: 入力の検証 → ユースケースの呼び出し → 応答。
 */

import type { Context } from 'hono';
import { z } from 'zod';
import { MANUAL_ENTRY_SORT_KEYS } from '@smart-farm/shared/constants/sorting';
import { PageQuerySchema } from '@smart-farm/shared/schemas/api';
import { AUDIT_OPERATIONS, AUDIT_TARGET_TYPES } from '@smart-farm/shared/schemas/audit';
import {
  CategorySchema,
  EquipmentIdSchema,
  IsoDateTimeSchema,
  UserIdSchema,
} from '@smart-farm/shared/schemas/common';
import { ManualEntryInputSchema } from '@smart-farm/shared/schemas/manual-entry';
import type { ApiDeps, AppEnv } from './api-deps.ts';
import { SortDirectionSchema, toOptionalDate } from './query-schemas.ts';
import { actorOf, pathParam } from './request-helpers.ts';
import { parseJsonBody, parseQuery } from './request-parsing.ts';
import type { RouteHandler } from './route-types.ts';

const ManualEntryListQuerySchema = PageQuerySchema.extend({
  /** キーワード（全入力項目・入力者などの部分一致）。 */
  q: z.string().max(100).optional(),
  category: CategorySchema.optional(),
  equipmentId: EquipmentIdSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  sort: z.enum(MANUAL_ENTRY_SORT_KEYS).default('observedAt'),
  direction: SortDirectionSchema,
});

const AuditLogQuerySchema = PageQuerySchema.extend({
  operation: z.enum(AUDIT_OPERATIONS).optional(),
  actor: UserIdSchema.optional(),
  targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  direction: SortDirectionSchema,
});

const entryIdOf = (c: Context<AppEnv>): string =>
  pathParam(c, 'entryId', '入力データが見つかりません');

export function createManualEntryHandlers(deps: ApiDeps): Readonly<Record<string, RouteHandler>> {
  return {
    async 'POST /manual-entries'(c) {
      const input = await parseJsonBody(c, ManualEntryInputSchema);
      return c.json(await deps.manualEntryService.create(input, actorOf(c)), 201);
    },

    async 'GET /manual-entries'(c) {
      const query = parseQuery(c, ManualEntryListQuerySchema);
      return c.json(
        await deps.manualEntryService.list({
          keyword: query.q,
          category: query.category,
          equipmentId: query.equipmentId,
          from: toOptionalDate(query.from),
          to: toOptionalDate(query.to),
          sort: query.sort,
          direction: query.direction,
          limit: query.limit,
          cursor: query.cursor,
        }),
      );
    },

    async 'PUT /manual-entries/:entryId'(c) {
      const input = await parseJsonBody(c, ManualEntryInputSchema);
      return c.json(await deps.manualEntryService.update(entryIdOf(c), input, actorOf(c)));
    },

    async 'DELETE /manual-entries/:entryId'(c) {
      await deps.manualEntryService.delete(entryIdOf(c), actorOf(c));
      return c.body(null, 204);
    },

    async 'GET /audit-logs'(c) {
      const query = parseQuery(c, AuditLogQuerySchema);
      return c.json(
        await deps.auditService.list({
          operation: query.operation,
          actor: query.actor,
          targetType: query.targetType,
          from: toOptionalDate(query.from),
          to: toOptionalDate(query.to),
          direction: query.direction,
          limit: query.limit,
          cursor: query.cursor,
        }),
      );
    },
  };
}
