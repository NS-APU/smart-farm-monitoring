/**
 * `/api/v1` のルート一覧（functional-specification.md 4.1）。
 * 認証・認可の要件を、ルートごとに1か所へ宣言する（公開ルートは PUBLIC を明示）。
 * ルートごとの実装は handlers.ts（と、領域ごとのハンドラ）にある。ただし、開発用 API（dev-routes.ts）は、このルート表の対象外。すべてのルートにハンドラが必要。権限は、ロールへの割り当ての設定で決まる（Q-017）。
 */

import type { Permission } from '@smart-farm/shared/constants/permissions';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** PUBLIC: 認証不要／LOGIN: 要ログイン／権限: その権限を持つロールのみ。 */
export type RouteAccess = 'PUBLIC' | 'LOGIN' | Permission;

export interface RouteSpec {
  readonly method: HttpMethod;
  /** `/api/v1` からの相対パス。 */
  readonly path: string;
  readonly access: RouteAccess;
  /** 対応するユースケース（use-cases.md）。 */
  readonly useCases: readonly string[];
}

export function routeKey(spec: Pick<RouteSpec, 'method' | 'path'>): string {
  return `${spec.method} ${spec.path}`;
}

export const ROUTE_TABLE: readonly RouteSpec[] = [
  // 認証（SC-01）
  { method: 'POST', path: '/auth/login', access: 'PUBLIC', useCases: ['UC-13'] },
  { method: 'POST', path: '/auth/refresh', access: 'PUBLIC', useCases: ['UC-13'] },
  { method: 'POST', path: '/auth/logout', access: 'LOGIN', useCases: ['UC-13'] },
  // 設備（SC-10）
  { method: 'GET', path: '/equipment', access: 'LOGIN', useCases: ['UC-01', 'UC-12'] },
  { method: 'POST', path: '/equipment', access: 'equipment:manage', useCases: ['UC-12'] },
  {
    method: 'PUT',
    path: '/equipment/:equipmentId',
    access: 'equipment:manage',
    useCases: ['UC-12'],
  },
  {
    method: 'DELETE',
    path: '/equipment/:equipmentId',
    access: 'equipment:manage',
    useCases: ['UC-12'],
  },
  // ダッシュボード・評価（SC-02, SC-03, SC-04, SC-13）
  { method: 'GET', path: '/dashboard', access: 'LOGIN', useCases: ['UC-01'] },
  {
    method: 'GET',
    path: '/viewpoints/:viewpointId',
    access: 'LOGIN',
    useCases: ['UC-02', 'UC-04', 'UC-21'],
  },
  { method: 'GET', path: '/viewpoints/:viewpointId/series', access: 'LOGIN', useCases: ['UC-03'] },
  {
    method: 'GET',
    path: '/viewpoints/:viewpointId/criteria',
    access: 'LOGIN',
    useCases: ['UC-19'],
  },
  {
    method: 'PUT',
    path: '/viewpoints/:viewpointId/criteria',
    access: 'criteria:edit',
    useCases: ['UC-19'],
  },
  {
    method: 'POST',
    path: '/viewpoints/:viewpointId/criteria/reset',
    access: 'criteria:edit',
    useCases: ['UC-19'],
  },
  // 観測値（SC-09）
  { method: 'GET', path: '/observations', access: 'LOGIN', useCases: ['UC-02', 'UC-20'] },
  // 手動入力（SC-06, SC-07, SC-08）
  {
    method: 'POST',
    path: '/manual-entries',
    access: 'manual-entry:write',
    useCases: ['UC-06', 'UC-07'],
  },
  { method: 'GET', path: '/manual-entries', access: 'LOGIN', useCases: ['UC-18'] },
  {
    method: 'PUT',
    path: '/manual-entries/:entryId',
    access: 'manual-entry:write',
    useCases: ['UC-18'],
  },
  {
    method: 'DELETE',
    path: '/manual-entries/:entryId',
    access: 'manual-entry:write',
    useCases: ['UC-18'],
  },
  { method: 'GET', path: '/audit-logs', access: 'audit:read', useCases: ['UC-18'] },
  // ステータスコード（SC-12）
  { method: 'GET', path: '/status-codes', access: 'LOGIN', useCases: ['UC-17'] },
  { method: 'POST', path: '/status-codes', access: 'status-code:manage', useCases: ['UC-17'] },
  { method: 'PUT', path: '/status-codes/:code', access: 'status-code:manage', useCases: ['UC-17'] },
  {
    method: 'DELETE',
    path: '/status-codes/:code',
    access: 'status-code:manage',
    useCases: ['UC-17'],
  },
  // 通知（SC-05, SC-15）
  { method: 'GET', path: '/notifications', access: 'LOGIN', useCases: ['UC-05', 'UC-22'] },
  {
    method: 'GET',
    path: '/notifications/unread-count',
    access: 'LOGIN',
    useCases: ['UC-05', 'UC-22'],
  },
  { method: 'POST', path: '/notifications/read-all', access: 'LOGIN', useCases: ['UC-22'] },
  {
    method: 'POST',
    path: '/notifications/:notificationId/read',
    access: 'LOGIN',
    useCases: ['UC-05', 'UC-22'],
  },
  { method: 'GET', path: '/push-subscription', access: 'LOGIN', useCases: ['UC-23'] },
  { method: 'PUT', path: '/push-subscription', access: 'LOGIN', useCases: ['UC-23'] },
  { method: 'DELETE', path: '/push-subscription', access: 'LOGIN', useCases: ['UC-23'] },
  // 取り込み・連携（SC-11）
  { method: 'GET', path: '/ingestion/settings', access: 'LOGIN', useCases: ['UC-15'] },
  {
    method: 'PUT',
    path: '/ingestion/settings',
    access: 'ingestion:configure',
    useCases: ['UC-15'],
  },
  {
    method: 'POST',
    path: '/ingestion/:sourceId/test',
    access: 'ingestion:run',
    useCases: ['UC-15'],
  },
  {
    method: 'POST',
    path: '/ingestion/:sourceId/run',
    access: 'ingestion:run',
    useCases: ['UC-08', 'UC-09', 'UC-15', 'UC-24'],
  },
  { method: 'GET', path: '/ingestion/logs', access: 'LOGIN', useCases: ['UC-16'] },
  { method: 'GET', path: '/federation/logs', access: 'LOGIN', useCases: ['UC-11', 'UC-16'] },
  // ユーザー（SC-14）
  { method: 'GET', path: '/users', access: 'user:manage', useCases: ['UC-14'] },
  { method: 'POST', path: '/users', access: 'user:manage', useCases: ['UC-14'] },
  { method: 'PUT', path: '/users/:userId', access: 'user:manage', useCases: ['UC-14'] },
  { method: 'DELETE', path: '/users/:userId', access: 'user:manage', useCases: ['UC-14'] },
];
