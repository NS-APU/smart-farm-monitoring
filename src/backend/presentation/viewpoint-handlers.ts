/**
 * 観点の詳細・推移・観測値の一覧のハンドラ（UC-01〜UC-04、UC-21。SC-02〜SC-04）。
 * 薄く保つ: 入力の検証 → ユースケース（参照）の呼び出し → 応答。
 */

import type { Context } from 'hono';
import { z } from 'zod';
import { OBSERVATION_SORT_KEYS } from '@smart-farm/shared/constants/sorting';
import {
  checkListPeriod,
  listPeriodGuidance,
  MAX_LIST_PERIOD_DAYS,
  requiresListPeriod,
} from '@smart-farm/shared/observation-list-period';
import { PageQuerySchema } from '@smart-farm/shared/schemas/api';
import {
  CategorySchema,
  EquipmentIdSchema,
  IsoDateTimeSchema,
  ObservationSourceSchema,
} from '@smart-farm/shared/schemas/common';
import type { ApiDeps, AppEnv } from './api-deps.ts';
import {
  HorizonQuerySchema,
  IncludeUsageQuerySchema,
  ProblemOnlyQuerySchema,
  SortDirectionSchema,
  toOptionalDate,
} from './query-schemas.ts';
import { resolveEquipmentId, scopeOfRequest } from './request-helpers.ts';
import { parseQuery } from './request-parsing.ts';
import type { RouteHandler } from './route-types.ts';

/** 期間（31 日以内）が必須の操作で、期間の指定を検証する（観測値の一覧・計測ごとの一覧で共通）。 */
function refineListPeriod(
  query: {
    readonly from?: string | undefined;
    readonly to?: string | undefined;
    readonly problemOnly?: boolean | undefined;
  },
  context: z.core.$RefinementCtx,
): void {
  const problem = checkListPeriod(query);
  if (problem === 'TOO_LONG') {
    for (const field of ['from', 'to'] as const) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `期間は ${String(MAX_LIST_PERIOD_DAYS)} 日以内にしてください`,
      });
    }
  } else if (problem === 'MISSING') {
    for (const [field, label] of [
      ['from', '開始'],
      ['to', '終了'],
    ] as const) {
      if (query[field] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `期間の${label}を指定してください。${listPeriodGuidance(query)}`,
        });
      }
    }
  }
}

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
  /** true なら、「問題あり」（有効でない観測値）だけ。 */
  problemOnly: ProblemOnlyQuerySchema,
  /** true なら、合計の項目の手動入力の行に、「評価に使われるか」（`usage`）を付ける（SC-09-4）。 */
  includeUsage: IncludeUsageQuerySchema,
  sort: z.enum(OBSERVATION_SORT_KEYS).default('observedAt'),
  direction: SortDirectionSchema,
}).superRefine((query, context) => {
  // 値・カテゴリの順の並べ替えと、キーワード検索と、「問題あり」の絞り込みは、期間（31 日以内）が必須（ADR-0007 の判断。#91・SC-09-3）
  if (requiresListPeriod({ sort: query.sort, keyword: query.q, problemOnly: query.problemOnly })) {
    refineListPeriod(query, context);
  }
});

/** GET /observations/measurements の条件（計測単位の一覧。日時順だけ。観点・項目の絞り込みはない。Issue #363）。 */
const MeasurementListQuerySchema = PageQuerySchema.extend({
  equipmentId: EquipmentIdSchema.optional(),
  category: CategorySchema.optional(),
  source: ObservationSourceSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  q: z.string().max(100).optional(),
  problemOnly: ProblemOnlyQuerySchema,
  includeUsage: IncludeUsageQuerySchema,
  direction: SortDirectionSchema,
}).superRefine((query, context) => {
  // キーワード検索と、「問題あり」の絞り込みは、期間（31 日以内）が必須（ADR-0007 の判断。#91・SC-09-3）。観測値の一覧と同じ
  if (
    requiresListPeriod({ sort: 'observedAt', keyword: query.q, problemOnly: query.problemOnly })
  ) {
    refineListPeriod(query, context);
  }
});

export function createViewpointHandlers(deps: ApiDeps): Readonly<Record<string, RouteHandler>> {
  async function viewpointParams(c: Context<AppEnv>) {
    const query = parseQuery(c, HorizonQuerySchema);
    return {
      equipmentId: await resolveEquipmentId(deps, query.equipmentId, await scopeOfRequest(c, deps)),
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

    async 'GET /observations/measurements'(c) {
      const query = parseQuery(c, MeasurementListQuerySchema);
      return c.json(
        await deps.observationQuery.listMeasurements({
          equipmentId: query.equipmentId,
          scope: await scopeOfRequest(c, deps),
          category: query.category,
          source: query.source,
          from: toOptionalDate(query.from),
          to: toOptionalDate(query.to),
          keyword: query.q,
          problemOnly: query.problemOnly,
          includeUsage: query.includeUsage,
          direction: query.direction,
          limit: query.limit,
          cursor: query.cursor,
        }),
      );
    },

    async 'GET /observations'(c) {
      const query = parseQuery(c, ObservationListQuerySchema);
      return c.json(
        await deps.observationQuery.list({
          equipmentId: query.equipmentId,
          scope: await scopeOfRequest(c, deps),
          viewpointId: query.viewpointId,
          category: query.category,
          itemKey: query.itemKey,
          source: query.source,
          from: toOptionalDate(query.from),
          to: toOptionalDate(query.to),
          keyword: query.q,
          problemOnly: query.problemOnly,
          includeUsage: query.includeUsage,
          sort: query.sort,
          direction: query.direction,
          limit: query.limit,
          cursor: query.cursor,
        }),
      );
    },
  };
}
