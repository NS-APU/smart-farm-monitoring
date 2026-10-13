/** API のエンドポイントごとの呼び出し（型つき）。パス・クエリ・応答のスキーマを1か所にまとめる。 */

import type { ObservationSortKey, SortDirection } from '@smart-farm/shared/constants/sorting';
import type { Horizon, PeriodDays } from '@smart-farm/shared/constants/status';
import { LoginResponseSchema } from '@smart-farm/shared/schemas/auth';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import {
  DashboardResponseSchema,
  SeriesResponseSchema,
  ViewpointDetailResponseSchema,
} from '@smart-farm/shared/schemas/evaluation';
import { ObservationListResponseSchema } from '@smart-farm/shared/schemas/observation';
import { StatusCodeListResponseSchema } from '@smart-farm/shared/schemas/status-code';
import { EquipmentTreeResponseSchema } from '@smart-farm/shared/schemas/equipment';
import { UnreadCountResponseSchema } from '@smart-farm/shared/schemas/notification';
import type { ApiClient } from './client.ts';
import { API_PATHS } from './paths.ts';

export function login(api: ApiClient, userId: string, password: string) {
  return api.request('/auth/login', {
    method: 'POST',
    body: { userId, password },
    schema: LoginResponseSchema,
    anonymous: true,
  });
}

export function logout(api: ApiClient) {
  return api.command('/auth/logout', { method: 'POST' });
}

export function getEquipmentTree(api: ApiClient) {
  return api.request('/equipment', { schema: EquipmentTreeResponseSchema });
}

export function getDashboard(
  api: ApiClient,
  params: { equipmentId: EquipmentId; horizon: Horizon; periodDays: PeriodDays },
) {
  return api.request('/dashboard', { query: params, schema: DashboardResponseSchema });
}

export function getUnreadCount(api: ApiClient) {
  return api.request('/notifications/unread-count', { schema: UnreadCountResponseSchema });
}

export interface ViewpointParams {
  readonly viewpointId: string;
  readonly equipmentId: EquipmentId;
  readonly horizon: Horizon;
  readonly periodDays: PeriodDays;
}

export function getViewpointDetail(api: ApiClient, params: ViewpointParams) {
  const { viewpointId, ...query } = params;
  return api.request(API_PATHS.viewpoint(viewpointId), {
    query,
    schema: ViewpointDetailResponseSchema,
  });
}

export function getViewpointSeries(api: ApiClient, params: ViewpointParams) {
  const { viewpointId, ...query } = params;
  return api.request(API_PATHS.viewpointSeries(viewpointId), {
    query,
    schema: SeriesResponseSchema,
  });
}

export interface ObservationListParams {
  readonly equipmentId?: string;
  readonly viewpointId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly sort?: ObservationSortKey;
  readonly direction?: SortDirection;
  readonly limit?: number;
  readonly cursor?: string;
}

export function listObservations(api: ApiClient, params: ObservationListParams) {
  return api.request('/observations', {
    query: { ...params },
    schema: ObservationListResponseSchema,
  });
}

export function getStatusCodes(api: ApiClient) {
  return api.request('/status-codes', { schema: StatusCodeListResponseSchema });
}
