/**
 * 通知・手動入力・設定・管理系の API の呼び出し（型つき）。ダッシュボード・観点の詳細・設備の階層・ステータスコード・未読件数は endpoints.ts。
 * パス・クエリ・応答のスキーマを1か所にまとめる。
 */

import type { Category } from '@smart-farm/shared/constants/items';
import type { ManualEntrySortKey, SortDirection } from '@smart-farm/shared/constants/sorting';
import type { NotificationKind, ReadState } from '@smart-farm/shared/constants/status';
import { AuditLogListResponseSchema, type AuditOperation } from '@smart-farm/shared/schemas/audit';
import {
  FederationSettingsResponseSchema,
  FederationTestResponseSchema,
  type FederationSettingsUpdateRequest,
} from '@smart-farm/shared/schemas/federation-connection';
import {
  PublicUserSchema,
  UserListResponseSchema,
  type UserCreateRequest,
  type UserUpdateRequest,
} from '@smart-farm/shared/schemas/auth';
import {
  FacilityAccessEntrySchema,
  FacilityAccessResponseSchema,
} from '@smart-farm/shared/schemas/facility-access';
import { EvaluationWriteResponseSchema } from '@smart-farm/shared/schemas/common';
import {
  CriteriaPreviewResponseSchema,
  CriteriaSaveResponseSchema,
  CriteriaViewSchema,
  type CriteriaUpdateRequest,
} from '@smart-farm/shared/schemas/criteria';
import {
  EquipmentSaveResponseSchema,
  type EquipmentCreateRequest,
  type EquipmentUpdateRequest,
} from '@smart-farm/shared/schemas/equipment';
import {
  ConnectionTestResponseSchema,
  EquipmentConnectionResponseSchema,
  FacilityFederationLogListResponseSchema,
  FacilityIngestionLogListResponseSchema,
  FederationLogListResponseSchema,
  IngestionCredentialStatusSchema,
  IngestionLogListResponseSchema,
  IngestionRunResponseSchema,
  IngestionSettingsResponseSchema,
  SourceFileInspectionSchema,
  SourceFilePlacedSchema,
  type FileServerConnection,
  type IngestionCredentialsInput,
  type IngestionSettingsUpdateRequest,
} from '@smart-farm/shared/schemas/ingestion';
import {
  ManualEntryListResponseSchema,
  ManualEntrySaveResponseSchema,
  type ManualEntryInput,
} from '@smart-farm/shared/schemas/manual-entry';
import {
  NotificationListResponseSchema,
  NotificationMemoListResponseSchema,
  NotificationMemoViewSchema,
  PushStatusResponseSchema,
  ReadAllResponseSchema,
  UnreadCountResponseSchema,
  type NotificationMemoInput,
  type ReadAllRequest,
} from '@smart-farm/shared/schemas/notification';
import {
  StatusCodeSaveResponseSchema,
  type StatusCodeCreateRequest,
  type StatusCodeUpdateRequest,
} from '@smart-farm/shared/schemas/status-code';
import type { PushSubscriptionDetails } from '../push/browser-push.ts';
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

/** 通知のメモ（入力の古い順。全件。共有。ADR-0019 の D-42）。 */
export function listNotificationMemos(api: ApiClient, notificationId: string) {
  return api.request(API_PATHS.notificationMemos(notificationId), {
    schema: NotificationMemoListResponseSchema,
  });
}

/** 通知にメモを追記する（追記のみ。編集・削除はない。手動入力と同じ権限）。 */
export function addNotificationMemo(
  api: ApiClient,
  notificationId: string,
  input: NotificationMemoInput,
) {
  return api.request(API_PATHS.notificationMemos(notificationId), {
    method: 'POST',
    body: input,
    schema: NotificationMemoViewSchema,
  });
}

/** 一括既読の範囲（種別・読み込んだ時点まで）の未読の件数（確認ダイアログの件数。D-39）。 */
export function countUnreadNotifications(
  api: ApiClient,
  range: { readonly kind?: NotificationKind; readonly until: string },
) {
  return api.request('/notifications/unread-count', {
    query: { ...range },
    schema: UnreadCountResponseSchema,
  });
}

/** 読み込んだ時点（`until`）までの未読を、既読にする。新しく既読にした件数を返す。 */
export function markAllNotificationsRead(api: ApiClient, request: ReadAllRequest) {
  return api.request('/notifications/read-all', {
    method: 'POST',
    body: request,
    schema: ReadAllResponseSchema,
  });
}

// Web Push（SC-15）
/** 購読の状態。端末の購読の宛先（endpoint）を指定すれば、その端末が有効かを返す。 */
export function getPushStatus(api: ApiClient, endpoint?: string) {
  return api.request('/push-subscription', {
    query: { endpoint },
    schema: PushStatusResponseSchema,
  });
}

/** 購読を登録する。暗号鍵（keys）は、サーバーが本文つきで配信するために保存する（なければ、本文なし）。 */
export function subscribePush(api: ApiClient, subscription: PushSubscriptionDetails) {
  return api.command('/push-subscription', { method: 'PUT', body: subscription });
}

/** この端末（購読の宛先）へ、テスト通知を送る（通知の記録は作らない。1 分に 1 回まで。#159 SC-15-2）。 */
export function sendTestPush(api: ApiClient, endpoint: string) {
  return api.command('/push-subscription/test', { method: 'POST', body: { endpoint } });
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
  return api.request(API_PATHS.manualEntry(entryId), {
    method: 'DELETE',
    schema: ManualEntrySaveResponseSchema,
  });
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
  /** 対象の ID（その対象の履歴だけを返す。#155）。 */
  readonly targetId?: string;
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
  return api.request('/equipment', {
    method: 'POST',
    body: input,
    schema: EquipmentSaveResponseSchema,
  });
}

export function updateEquipment(
  api: ApiClient,
  equipmentId: string,
  input: EquipmentUpdateRequest,
) {
  return api.request(API_PATHS.equipment(equipmentId), {
    method: 'PUT',
    body: input,
    schema: EquipmentSaveResponseSchema,
  });
}

/** 設備を削除する。応答は、評価の状態（ADR-0014）。 */
export function deleteEquipment(api: ApiClient, equipmentId: string) {
  return api.request(API_PATHS.equipment(equipmentId), {
    method: 'DELETE',
    schema: EvaluationWriteResponseSchema,
  });
}

// ステータスコード（SC-12）
export function createStatusCode(api: ApiClient, input: StatusCodeCreateRequest) {
  return api.request('/status-codes', {
    method: 'POST',
    body: input,
    schema: StatusCodeSaveResponseSchema,
  });
}

export function updateStatusCode(api: ApiClient, code: string, input: StatusCodeUpdateRequest) {
  return api.request(API_PATHS.statusCode(code), {
    method: 'PUT',
    body: input,
    schema: StatusCodeSaveResponseSchema,
  });
}

/** ステータスコードを削除する。応答は、評価の状態（ADR-0014）。 */
export function deleteStatusCode(api: ApiClient, code: string) {
  return api.request(API_PATHS.statusCode(code), {
    method: 'DELETE',
    schema: EvaluationWriteResponseSchema,
  });
}

// 判断基準（SC-13）
/** 判断基準と、その版（ETag）。版は、更新・既定値へ戻す操作の If-Match に付ける（同時編集の検出。SC-13-1）。 */
export function getCriteria(api: ApiClient, viewpointId: string) {
  return api.requestWithEtag(API_PATHS.viewpointCriteria(viewpointId), {
    schema: CriteriaViewSchema,
  });
}

export function updateCriteria(
  api: ApiClient,
  viewpointId: string,
  input: CriteriaUpdateRequest,
  etag: string | undefined,
) {
  return api.request(API_PATHS.viewpointCriteria(viewpointId), {
    method: 'PUT',
    body: input,
    ...(etag === undefined ? {} : { ifMatch: etag }),
    schema: CriteriaSaveResponseSchema,
  });
}

/** 入力途中の閾値の影響（保存済みの評価結果に当てた再判定。保存しない。SC-13-2）。 */
export function previewCriteria(api: ApiClient, viewpointId: string, input: CriteriaUpdateRequest) {
  return api.request(API_PATHS.viewpointCriteriaPreview(viewpointId), {
    method: 'POST',
    body: input,
    schema: CriteriaPreviewResponseSchema,
  });
}

export function resetCriteria(api: ApiClient, viewpointId: string, etag: string | undefined) {
  return api.request(API_PATHS.viewpointCriteriaReset(viewpointId), {
    method: 'POST',
    ...(etag === undefined ? {} : { ifMatch: etag }),
    schema: CriteriaSaveResponseSchema,
  });
}

// 閲覧の割り当て（ハウスごと。SC-14。Issue #330）
export function getFacilityAccess(api: ApiClient) {
  return api.request('/facility-access', { schema: FacilityAccessResponseSchema });
}

export function setFacilityAccess(api: ApiClient, facilityId: string, userIds: readonly string[]) {
  return api.request(`/facility-access/${encodeURIComponent(facilityId)}`, {
    method: 'PUT',
    body: { userIds },
    schema: FacilityAccessEntrySchema,
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

// 連携先の設定（SC-11。ADR-0024。接続先は書き込み専用）
export function getFederationSettings(api: ApiClient) {
  return api.request('/federation/settings', { schema: FederationSettingsResponseSchema });
}

export function updateFederationSettings(api: ApiClient, input: FederationSettingsUpdateRequest) {
  return api.request('/federation/settings', {
    method: 'PUT',
    body: input,
    schema: FederationSettingsResponseSchema,
  });
}

export function testFederation(api: ApiClient) {
  return api.request('/federation/test', {
    method: 'POST',
    schema: FederationTestResponseSchema,
  });
}

// 取り込み（SC-11）
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

/** 設備ごとの接続を保存する（Issue #367。ADR-0026）。認証情報の値は含めない。 */
export function saveEquipmentConnection(
  api: ApiClient,
  equipmentId: string,
  connection: FileServerConnection,
) {
  return api.request(API_PATHS.ingestionEquipmentConnection(equipmentId), {
    method: 'PUT',
    body: { connection },
    schema: EquipmentConnectionResponseSchema,
  });
}

/** 設備ごとの接続を削除する（削除のあとは、未設定。応答の接続は省略）。 */
export function deleteEquipmentConnection(api: ApiClient, equipmentId: string) {
  return api.request(API_PATHS.ingestionEquipmentConnection(equipmentId), {
    method: 'DELETE',
    schema: EquipmentConnectionResponseSchema,
  });
}

/** 設備ごとの認証情報を登録・上書きする（書き込み専用。応答は、状態だけ）。 */
export function saveEquipmentCredentials(
  api: ApiClient,
  equipmentId: string,
  input: IngestionCredentialsInput,
) {
  return api.request(API_PATHS.ingestionEquipmentCredentials(equipmentId), {
    method: 'PUT',
    body: input,
    schema: IngestionCredentialStatusSchema,
  });
}

/** その設備だけの接続テスト。 */
export function testEquipmentConnection(api: ApiClient, equipmentId: string) {
  return api.request(API_PATHS.ingestionEquipmentTest(equipmentId), {
    method: 'POST',
    schema: ConnectionTestResponseSchema,
  });
}

/**
 * 取り込み用のファイルを、置く前に検査する（保存しない。Issue #565）。本文は、ファイルの内容そのもの（JSON の包みは付けない）。
 * 置けない内容は、エラーでなく、`ok: false` と理由（problems）で返る。
 */
export function checkSourceFile(api: ApiClient, equipmentId: string, content: string) {
  return api.request(API_PATHS.ingestionSourceFileCheck(equipmentId), {
    method: 'POST',
    textBody: content,
    schema: SourceFileInspectionSchema,
  });
}

/** 取り込み用のファイルを、設備のファイルのパスに置く（検査して置く。置けない内容は 400）。 */
export function placeSourceFile(api: ApiClient, equipmentId: string, content: string) {
  return api.request(API_PATHS.ingestionSourceFile(equipmentId), {
    method: 'PUT',
    textBody: content,
    schema: SourceFilePlacedSchema,
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
  params: {
    readonly sourceId?: string;
    readonly equipmentId?: string;
    /** 成功（SUCCESS）／失敗（FAILURE。一部成功を含む）。 */
    readonly result?: 'SUCCESS' | 'FAILURE';
    /** 開始日時の範囲（両端を含む。日時）。 */
    readonly from?: string;
    readonly to?: string;
    readonly limit?: number;
    readonly cursor?: string;
  },
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

/** ハウス別の取り込みの記録（閲覧できるハウスの分だけ。一般ユーザー向け。Issue #332）。 */
export function listFacilityIngestionLogs(
  api: ApiClient,
  params: { readonly limit?: number; readonly cursor?: string },
) {
  return api.request('/ingestion/facility-logs', {
    query: { ...params },
    schema: FacilityIngestionLogListResponseSchema,
  });
}

/** ハウス別の連携の記録（閲覧できるハウスの分だけ。一般ユーザー向け。Issue #332）。 */
export function listFacilityFederationLogs(
  api: ApiClient,
  params: { readonly limit?: number; readonly cursor?: string },
) {
  return api.request('/federation/facility-logs', {
    query: { ...params },
    schema: FacilityFederationLogListResponseSchema,
  });
}
