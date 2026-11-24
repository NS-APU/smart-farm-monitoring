/** API のエンドポイントごとの呼び出し（型つき）。パス・クエリ・応答のスキーマを1か所にまとめる。 */

import type { ObservationSortKey, SortDirection } from '@smart-farm/shared/constants/sorting';
import type { Horizon, PeriodDays } from '@smart-farm/shared/constants/status';
import { LoginResponseSchema, PublicUserSchema } from '@smart-farm/shared/schemas/auth';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import {
  DashboardResponseSchema,
  SeriesResponseSchema,
  ViewpointDetailResponseSchema,
} from '@smart-farm/shared/schemas/evaluation';
import {
  MeasurementListResponseSchema,
  ObservationListResponseSchema,
} from '@smart-farm/shared/schemas/observation';
import {
  StatusCodeListResponseSchema,
  UnregisteredStatusCodeListResponseSchema,
} from '@smart-farm/shared/schemas/status-code';
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

/** 本人によるパスワードの変更。成功すると、新しいセッション（ほかの端末のセッションは、失効する）を返す。 */
export function changePassword(api: ApiClient, currentPassword: string, newPassword: string) {
  return api.request('/auth/password', {
    method: 'POST',
    body: { currentPassword, newPassword },
    schema: LoginResponseSchema,
  });
}

/** 自身のユーザー名の変更（ロール・ユーザー ID は、変えられない）。 */
export function updateOwnProfile(api: ApiClient, userName: string) {
  return api.request('/auth/profile', {
    method: 'PUT',
    body: { userName },
    schema: PublicUserSchema,
  });
}

export function getEquipmentTree(api: ApiClient) {
  return api.request('/equipment', { schema: EquipmentTreeResponseSchema });
}

export function getDashboard(
  api: ApiClient,
  params: { equipmentId: EquipmentId; horizon: Horizon; periodDays?: PeriodDays | undefined },
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
  /** 'true' なら、「問題あり」（有効でない観測値）だけ。期間（31 日以内）が必須（SC-09-3）。 */
  readonly problemOnly?: 'true';
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

/** 計測単位の一覧の条件（日時順だけ。Issue #363）。 */
export interface MeasurementListParams {
  readonly equipmentId?: string;
  readonly category?: string;
  readonly source?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  /** 'true' なら、有効でない項目を含む計測だけ。期間（31 日以内）が必須（SC-09-3）。 */
  readonly problemOnly?: 'true';
  readonly direction?: SortDirection;
  readonly limit?: number;
  readonly cursor?: string;
}

export function listMeasurements(api: ApiClient, params: MeasurementListParams) {
  return api.request('/observations/measurements', {
    query: { ...params },
    schema: MeasurementListResponseSchema,
  });
}

export function getStatusCodes(api: ApiClient) {
  return api.request('/status-codes', { schema: StatusCodeListResponseSchema });
}

/** 未登録のコード値（取り込みで、定義にないコード値として記録した値）。管理者のみ（SC-12-5）。 */
export function getUnregisteredStatusCodes(api: ApiClient) {
  return api.request('/status-codes/unregistered', {
    schema: UnregisteredStatusCodeListResponseSchema,
  });
}
