/**
 * 設定・管理系のハンドラの組み立て。領域ごとのファイルのハンドラを、1つの表にまとめる:
 * 設備（equipment-handlers.ts）、ステータスコード（status-code-handlers.ts）、判断基準（criteria-handlers.ts）、
 * ユーザー（user-handlers.ts）、取り込み設定・状況（ingestion-handlers.ts）、Web Push の購読（push-subscription-handlers.ts）。
 */

import type { ApiDeps } from './api-deps.ts';
import { createCriteriaHandlers } from './criteria-handlers.ts';
import { createEquipmentHandlers } from './equipment-handlers.ts';
import { createIngestionHandlers } from './ingestion-handlers.ts';
import { createPushSubscriptionHandlers } from './push-subscription-handlers.ts';
import type { RouteHandler } from './route-types.ts';
import { createStatusCodeHandlers } from './status-code-handlers.ts';
import { createUserHandlers } from './user-handlers.ts';

export function createAdminHandlers(deps: ApiDeps): Readonly<Record<string, RouteHandler>> {
  return {
    ...createEquipmentHandlers(deps),
    ...createStatusCodeHandlers(deps),
    ...createCriteriaHandlers(deps),
    ...createUserHandlers(deps),
    ...createIngestionHandlers(deps),
    ...createPushSubscriptionHandlers(deps),
  };
}
