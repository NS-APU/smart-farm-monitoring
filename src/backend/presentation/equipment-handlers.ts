/**
 * 設備のハンドラ（UC-12。SC-10）。
 * 薄く保つ: 入力の検証 → ユースケースの呼び出し → 応答。
 */

import { EquipmentIdSchema } from '@smart-farm/shared/schemas/common';
import {
  EquipmentCreateRequestSchema,
  EquipmentUpdateRequestSchema,
} from '@smart-farm/shared/schemas/equipment';
import type { ApiDeps } from './api-deps.ts';
import { actorOf, pathParam } from './request-helpers.ts';
import { parseInput, parseJsonBody } from './request-parsing.ts';
import type { RouteHandler } from './route-types.ts';

export function createEquipmentHandlers(deps: ApiDeps): Readonly<Record<string, RouteHandler>> {
  return {
    async 'POST /equipment'(c) {
      const input = await parseJsonBody(c, EquipmentCreateRequestSchema);
      return c.json(await deps.equipmentService.create(input, actorOf(c)), 201);
    },
    async 'PUT /equipment/:equipmentId'(c) {
      const equipmentId = parseInput(EquipmentIdSchema, pathParam(c, 'equipmentId'));
      const input = await parseJsonBody(c, EquipmentUpdateRequestSchema);
      return c.json(await deps.equipmentService.update(equipmentId, input, actorOf(c)));
    },
    async 'DELETE /equipment/:equipmentId'(c) {
      const equipmentId = parseInput(EquipmentIdSchema, pathParam(c, 'equipmentId'));
      await deps.equipmentService.delete(equipmentId, actorOf(c));
      return c.body(null, 204);
    },
  };
}
