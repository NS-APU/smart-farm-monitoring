/**
 * 通知・手動入力・設定・管理系の API の呼び出し（型つき）。ダッシュボード・観点の詳細・設備の階層・ステータスコード・未読件数は endpoints.ts。
 * パス・クエリ・応答のスキーマを1か所にまとめる。
 */

import type { Category } from '@smart-farm/shared/constants/items';
import type { ManualEntrySortKey, SortDirection } from '@smart-farm/shared/constants/sorting';
import type { NotificationKind, ReadState } from '@smart-farm/shared/constants/status';
import { AuditLogListResponseSchema, type AuditOperation } from '@smart-farm/shared/schemas/audit';
import {
  PublicUserSchema,
  UserListResponseSchema,
  type UserCreateRequest,
  type UserUpdateRequest,
} from '@smart-farm/shared/schemas/auth';
import {
  CriteriaViewSchema,
  type CriteriaUpdateRequest,
} from '@smart-farm/shared/schemas/criteria';
import {
  EquipmentSchema,
  type EquipmentCreateRequest,
  type EquipmentUpdateRequest,
} from '@smart-farm/shared/schemas/equipment';
import {
  ConnectionTestResponseSchema,
  FederationLogListResponseSchema,
  IngestionLogListResponseSchema,
  IngestionRunResponseSchema,
  IngestionSettingsResponseSchema,
  type IngestionSettingsUpdateRequest,
} from '@smart-farm/shared/schemas/ingestion';
import {
  ManualEntryListResponseSchema,
  ManualEntrySaveResponseSchema,
  type ManualEntryInput,
} from '@smart-farm/shared/schemas/manual-entry';
import {
  NotificationListResponseSchema,
  PushStatusResponseSchema,
} from '@smart-farm/shared/schemas/notification';
import {
  StatusCodeDefinitionSchema,
  type StatusCodeCreateRequest,
  type StatusCodeUpdateRequest,
} from '@smart-farm/shared/schemas/status-code';
import type { ApiClient } from './client.ts';
import { API_PATHS } from './paths.ts';

// 通知（SC-05）
export interface NotificationListParams {
  readonly kind?: NotificationKind;
  readonly readState?: ReadState;
  readonly limit?: number;
  readonly cursor?: string;
}

export function listNotifications(api: ApiClient, params: NotificationListParams) {
  return api.request('/notifications', {
    query: { ...params },
    schema: NotificationListResponseSchema,
  });
}

export function markNotificationRead(api: ApiClient, notificationId: string) {
  return api.command(API_PATHS.notificationRead(notificationId), {
    method: 'POST',
  });
}

export function markAllNotificationsRead(
  api: ApiClient,
  filter: { readonly kind?: NotificationKind; readonly readState?: ReadState },
) {
  return api.command('/notifications/read-all', { method: 'POST', body: filter });
}

// Web Push（SC-15）
/** 購読の状態。端末の購読の宛先（endpoint）を指定すれば、その端末が有効かを返す。 */
export function getPushStatus(api: ApiClient, endpoint?: string) {
  return api.request('/push-subscription', {
    query: { endpoint },
    schema: PushStatusResponseSchema,
  });
}

export function subscribePush(api: ApiClient, endpoint: string) {
  return api.command('/push-subscription', { method: 'PUT', body: { endpoint } });
}

export function unsubscribePush(api: ApiClient, endpoint?: string) {
  return api.command('/push-subscription', {
    method: 'DELETE',
    ...(endpoint === undefined ? {} : { body: { endpoint } }),
  });
}

// 手動入力・変更履歴（SC-06〜SC-08）
export interface ManualEntryListParams {
  readonly q?: string;
  readonly category?: Category;
  readonly equipmentId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly sort?: ManualEntrySortKey;
  readonly direction?: SortDirection;
  readonly limit?: number;
  readonly cursor?: string;
}

export function createManualEntry(api: ApiClient, input: ManualEntryInput) {
  return api.request('/manual-entries', {
    method: 'POST',
    body: input,
    schema: ManualEntrySaveResponseSchema,
  });
}

export function updateManualEntry(api: ApiClient, entryId: string, input: ManualEntryInput) {
  return api.request(API_PATHS.manualEntry(entryId), {
    method: 'PUT',
    body: input,
    schema: ManualEntrySaveResponseSchema,
  });
}

export function deleteManualEntry(api: ApiClient, entryId: string) {
  return api.command(API_PATHS.manualEntry(entryId), { method: 'DELETE' });
}

export function listManualEntries(api: ApiClient, params: ManualEntryListParams) {
  return api.request('/manual-entries', {
    query: { ...params },
    schema: ManualEntryListResponseSchema,
  });
}

export interface AuditLogListParams {
  readonly operation?: AuditOperation;
  readonly actor?: string;
  readonly targetType?: string;
  readonly from?: string;
  readonly to?: string;
  readonly direction?: SortDirection;
  readonly limit?: number;
  readonly cursor?: string;
}

export function listAuditLogs(api: ApiClient, params: AuditLogListParams) {
  return api.request('/audit-logs', { query: { ...params }, schema: AuditLogListResponseSchema });
}

// 設備（SC-10）
export function createEquipment(api: ApiClient, input: EquipmentCreateRequest) {
  return api.request('/equipment', { method: 'POST', body: input, schema: EquipmentSchema });
}

export function updateEquipment(
  api: ApiClient,
  equipmentId: string,
  input: EquipmentUpdateRequest,
) {
  return api.request(API_PATHS.equipment(equipmentId), {
    method: 'PUT',
    body: input,
    schema: EquipmentSchema,
  });
}

export function deleteEquipment(api: ApiClient, equipmentId: string) {
  return api.command(API_PATHS.equipment(equipmentId), { method: 'DELETE' });
}

// ステータスコード（SC-12）
export function createStatusCode(api: ApiClient, input: StatusCodeCreateRequest) {
  return api.request('/status-codes', {
    method: 'POST',
    body: input,
    schema: StatusCodeDefinitionSchema,
  });
}

export function updateStatusCode(api: ApiClient, code: string, input: StatusCodeUpdateRequest) {
  return api.request(API_PATHS.statusCode(code), {
    method: 'PUT',
    body: input,
    schema: StatusCodeDefinitionSchema,
  });
}

export function deleteStatusCode(api: ApiClient, code: string) {
  return api.command(API_PATHS.statusCode(code), { method: 'DELETE' });
}

// 判断基準（SC-13）
export function getCriteria(api: ApiClient, viewpointId: string) {
  return api.request(API_PATHS.viewpointCriteria(viewpointId), {
    schema: CriteriaViewSchema,
  });
}

export function updateCriteria(api: ApiClient, viewpointId: string, input: CriteriaUpdateRequest) {
  return api.request(API_PATHS.viewpointCriteria(viewpointId), {
    method: 'PUT',
    body: input,
    schema: CriteriaViewSchema,
  });
}

export function resetCriteria(api: ApiClient, viewpointId: string) {
  return api.request(API_PATHS.viewpointCriteriaReset(viewpointId), {
    method: 'POST',
    schema: CriteriaViewSchema,
  });
}

// ユーザー（SC-14）
export function listUsers(api: ApiClient) {
  return api.request('/users', { schema: UserListResponseSchema });
}

export function createUser(api: ApiClient, input: UserCreateRequest) {
  return api.request('/users', { method: 'POST', body: input, schema: PublicUserSchema });
}

export function updateUser(api: ApiClient, userId: string, input: UserUpdateRequest) {
  return api.request(API_PATHS.user(userId), {
    method: 'PUT',
    body: input,
    schema: PublicUserSchema,
  });
}

export function deleteUser(api: ApiClient, userId: string) {
  return api.command(API_PATHS.user(userId), { method: 'DELETE' });
}

// 取り込み設定・状況（SC-11）
export function getIngestionSettings(api: ApiClient) {
  return api.request('/ingestion/settings', { schema: IngestionSettingsResponseSchema });
}

export function updateIngestionSettings(api: ApiClient, input: IngestionSettingsUpdateRequest) {
  return api.request('/ingestion/settings', {
    method: 'PUT',
    body: input,
    schema: IngestionSettingsResponseSchema,
  });
}

export function testIngestionConnection(api: ApiClient, sourceId: string) {
  return api.request(API_PATHS.ingestionTest(sourceId), {
    method: 'POST',
    schema: ConnectionTestResponseSchema,
  });
}

export function runIngestion(api: ApiClient, sourceId: string) {
  return api.request(API_PATHS.ingestionRun(sourceId), {
    method: 'POST',
    schema: IngestionRunResponseSchema,
  });
}

export function listIngestionLogs(
  api: ApiClient,
  params: { readonly sourceId?: string; readonly limit?: number; readonly cursor?: string },
) {
  return api.request('/ingestion/logs', {
    query: { ...params },
    schema: IngestionLogListResponseSchema,
  });
}

export function listFederationLogs(
  api: ApiClient,
  params: { readonly limit?: number; readonly cursor?: string },
) {
  return api.request('/federation/logs', {
    query: { ...params },
    schema: FederationLogListResponseSchema,
  });
}
