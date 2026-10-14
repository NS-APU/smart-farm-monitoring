/**
 * 観点の詳細・推移・観測値の一覧のハンドラ（UC-01〜UC-04、UC-21。SC-02〜SC-04）。
 * 薄く保つ: 入力の検証 → ユースケース（参照）の呼び出し → 応答。
 */

import type { Context } from 'hono';
import { z } from 'zod';
import { OBSERVATION_SORT_KEYS } from '@smart-farm/shared/constants/sorting';
import { PageQuerySchema } from '@smart-farm/shared/schemas/api';
import {
  CategorySchema,
  EquipmentIdSchema,
  IsoDateTimeSchema,
  ObservationSourceSchema,
} from '@smart-farm/shared/schemas/common';
import type { ApiDeps, AppEnv } from './api-deps.ts';
import { HorizonQuerySchema, SortDirectionSchema, toOptionalDate } from './query-schemas.ts';
import { resolveEquipmentId } from './request-helpers.ts';
import { parseQuery } from './request-parsing.ts';
import type { RouteHandler } from './route-types.ts';

const ObservationListQuerySchema = PageQuerySchema.extend({
  equipmentId: EquipmentIdSchema.optional(),
  viewpointId: z.string().min(1).max(100).optional(),
  category: CategorySchema.optional(),
  itemKey: z.string().min(1).max(100).optional(),
  source: ObservationSourceSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  /** キーワード（項目・カテゴリ・設備・取得元・状態の表示名、値の部分一致）。 */
  q: z.string().max(100).optional(),
  sort: z.enum(OBSERVATION_SORT_KEYS).default('observedAt'),
  direction: SortDirectionSchema,
});

export function createViewpointHandlers(deps: ApiDeps): Readonly<Record<string, RouteHandler>> {
  async function viewpointParams(c: Context<AppEnv>) {
    const query = parseQuery(c, HorizonQuerySchema);
    return {
      equipmentId: await resolveEquipmentId(deps, query.equipmentId),
      viewpointId: c.req.param('viewpointId') ?? '',
      horizon: query.horizon,
      periodDays: query.periodDays,
    };
  }

  return {
    async 'GET /viewpoints/:viewpointId'(c) {
      return c.json(await deps.viewpointQuery.detail(await viewpointParams(c)));
    },

    async 'GET /viewpoints/:viewpointId/series'(c) {
      return c.json(await deps.viewpointQuery.series(await viewpointParams(c)));
    },

    async 'GET /observations'(c) {
      const query = parseQuery(c, ObservationListQuerySchema);
      return c.json(
        await deps.observationQuery.list({
          equipmentId: query.equipmentId,
          viewpointId: query.viewpointId,
          category: query.category,
          itemKey: query.itemKey,
          source: query.source,
          from: toOptionalDate(query.from),
          to: toOptionalDate(query.to),
          keyword: query.q,
          sort: query.sort,
          direction: query.direction,
          limit: query.limit,
          cursor: query.cursor,
        }),
      );
    },
  };
}
