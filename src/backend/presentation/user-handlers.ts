/**
 * ユーザーのハンドラ（UC-14。SC-14）。
 * 薄く保つ: 入力の検証 → ユースケースの呼び出し → 応答。
 */

import { UserCreateRequestSchema, UserUpdateRequestSchema } from '@smart-farm/shared/schemas/auth';
import { UserIdSchema } from '@smart-farm/shared/schemas/common';
import type { ApiDeps } from './api-deps.ts';
import { bearerTokenOf } from './auth-guards.ts';
import { actorOf, pathParam } from './request-helpers.ts';
import { parseInput, parseJsonBody } from './request-parsing.ts';
import type { RouteHandler } from './route-types.ts';

export function createUserHandlers(deps: ApiDeps): Readonly<Record<string, RouteHandler>> {
  return {
    async 'GET /users'(c) {
      return c.json(await deps.userService.list());
    },
    async 'POST /users'(c) {
      const input = await parseJsonBody(c, UserCreateRequestSchema);
      return c.json(await deps.userService.create(input, actorOf(c)), 201);
    },
    async 'PUT /users/:userId'(c) {
      const userId = parseInput(UserIdSchema, pathParam(c, 'userId'));
      const input = await parseJsonBody(c, UserUpdateRequestSchema);
      const currentAccessToken = bearerTokenOf(c);
      return c.json(
        await deps.userService.update(
          userId,
          input,
          actorOf(c),
          currentAccessToken === undefined ? {} : { currentAccessToken },
        ),
      );
    },
    async 'DELETE /users/:userId'(c) {
      const userId = parseInput(UserIdSchema, pathParam(c, 'userId'));
      await deps.userService.delete(userId, actorOf(c));
      return c.body(null, 204);
    },
  };
}
