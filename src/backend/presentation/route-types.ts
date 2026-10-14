/** ルートのハンドラの型（ルートのキー → ハンドラの表の値）。 */

import type { Context } from 'hono';
import type { AppEnv } from './api-deps.ts';

export type RouteHandler = (c: Context<AppEnv>) => Response | Promise<Response>;
