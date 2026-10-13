/**
 * 判断基準のハンドラ（UC-19。SC-13）。
 * 薄く保つ: 入力の検証 → ユースケースの呼び出し → 応答。
 */

import type { Context } from 'hono';
import { VIEWPOINT_IDS, type ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import { AppError } from '@smart-farm/shared/errors';
import { CriteriaUpdateRequestSchema } from '@smart-farm/shared/schemas/criteria';
import type { ApiDeps, AppEnv } from './api-deps.ts';
import { actorOf } from './request-helpers.ts';
import { parseJsonBody } from './request-parsing.ts';
import type { RouteHandler } from './route-types.ts';

function viewpointIdOf(c: Context<AppEnv>): ViewpointId {
  const viewpointId = VIEWPOINT_IDS.find((id) => id === c.req.param('viewpointId'));
  if (viewpointId === undefined) {
    throw new AppError('NOT_FOUND', '観点が見つかりません');
  }
  return viewpointId;
}

export function createCriteriaHandlers(deps: ApiDeps): Readonly<Record<string, RouteHandler>> {
  return {
    async 'GET /viewpoints/:viewpointId/criteria'(c) {
      return c.json(await deps.criteriaAdminService.get(viewpointIdOf(c)));
    },
    async 'PUT /viewpoints/:viewpointId/criteria'(c) {
      const viewpointId = viewpointIdOf(c);
      const input = await parseJsonBody(c, CriteriaUpdateRequestSchema);
      return c.json(await deps.criteriaAdminService.update(viewpointId, input, actorOf(c)));
    },
    async 'POST /viewpoints/:viewpointId/criteria/reset'(c) {
      return c.json(await deps.criteriaAdminService.reset(viewpointIdOf(c), actorOf(c)));
    },
  };
}
