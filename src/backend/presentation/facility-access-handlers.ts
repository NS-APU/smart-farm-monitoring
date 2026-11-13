/**
 * 閲覧の割り当て（ハウスごと）のハンドラ（Issue #330。SC-14）。
 * 薄く保つ: 入力の検証 → ユースケースの呼び出し → 応答。権限（user:manage）は、ルート表で宣言する。
 */

import { EquipmentIdSchema } from '@smart-farm/shared/schemas/common';
import { FacilityAccessUpdateRequestSchema } from '@smart-farm/shared/schemas/facility-access';
import type { ApiDeps } from './api-deps.ts';
import { actorOf, pathParam } from './request-helpers.ts';
import { parseInput, parseJsonBody } from './request-parsing.ts';
import type { RouteHandler } from './route-types.ts';

export function createFacilityAccessHandlers(
  deps: ApiDeps,
): Readonly<Record<string, RouteHandler>> {
  return {
    async 'GET /facility-access'(c) {
      return c.json(await deps.facilityAccessService.table());
    },
    async 'PUT /facility-access/:facilityId'(c) {
      const facilityId = parseInput(EquipmentIdSchema, pathParam(c, 'facilityId'));
      const input = await parseJsonBody(c, FacilityAccessUpdateRequestSchema);
      return c.json(
        await deps.facilityAccessService.setUsers(facilityId, input.userIds, actorOf(c)),
      );
    },
  };
}
