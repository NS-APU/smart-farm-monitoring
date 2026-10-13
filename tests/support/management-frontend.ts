/**
 * 通知・手動入力・設定・管理系の画面（SC-05〜SC-15）の単体テストの補助: API のスタブ（ルートごとのハンドラ）、
 * 応答のデータ（合成データ）、画面の描画。データはすべて合成データ（実データは使わない）。
 */

import { render } from '@testing-library/react';
import { createElement } from 'react';
import type { LoginResponse } from '../../src/shared/schemas/auth.ts';
import { toEquipmentId, toUserId } from '../../src/shared/schemas/common.ts';
import type { ManualEntry } from '../../src/shared/schemas/manual-entry.ts';
import type { NotificationItem } from '../../src/shared/schemas/notification.ts';
import { PERMISSIONS } from '../../src/shared/constants/permissions.ts';
import { App } from '../../src/frontend/app.tsx';
import type { PushBrowser } from '../../src/frontend/push/browser-push.ts';
import {
  createFakeFetch,
  createMemorySession,
  equipmentTree,
  jsonResponse,
  WORKER_LOGIN,
  type FakeHandler,
  type FakeRequest,
} from './frontend.ts';
import { STATUS_CODES_RESPONSE } from './viewpoint-fixtures.ts';

export type RouteHandler = (request: FakeRequest) => Response | Promise<Response> | undefined;
/** `METHOD /path` → ハンドラ。 */
export type Routes = Readonly<Record<string, RouteHandler>>;

/** 全権限を持つ利用者（農作業者）。 */
export const FULL_LOGIN: LoginResponse = {
  ...WORKER_LOGIN,
  user: { ...WORKER_LOGIN.user, permissions: [...PERMISSIONS] },
};

/** 権限のない利用者（閲覧者）。 */
export const READ_ONLY_LOGIN: LoginResponse = {
  ...FULL_LOGIN,
  user: { ...FULL_LOGIN.user, userName: '閲覧者B', role: 'viewer', permissions: [] },
};

/** 一部の権限だけを持つ利用者。 */
export function loginWith(permissions: LoginResponse['user']['permissions']): LoginResponse {
  return { ...FULL_LOGIN, user: { ...FULL_LOGIN.user, permissions } };
}

/** 共通のルート（設備の階層・未読の件数・ステータスコード）に、テストごとのルートを重ねる。 */
export function withBaseRoutes(routes: Routes = {}): FakeHandler {
  const base: Routes = {
    'GET /equipment': () => jsonResponse(equipmentTree()),
    'GET /notifications/unread-count': () => jsonResponse({ unreadCount: 0 }),
    'GET /status-codes': () => jsonResponse(STATUS_CODES_RESPONSE),
  };
  return (request) => {
    const key = `${request.method} ${request.path}`;
    return (routes[key] ?? base[key])?.(request);
  };
}

export interface RenderOptions {
  readonly login?: LoginResponse;
  readonly pushBrowser?: PushBrowser;
}

/** 指定したパスで、アプリを描画する。 */
export function renderApp(path: string, routes: Routes = {}, options: RenderOptions = {}) {
  window.history.pushState(null, '', path);
  const session = createMemorySession(options.login ?? FULL_LOGIN);
  const fake = createFakeFetch(withBaseRoutes(routes));
  const view = render(
    createElement(App, {
      session,
      fetchFn: fake.fetchFn,
      ...(options.pushBrowser === undefined ? {} : { pushBrowser: options.pushBrowser }),
    }),
  );
  return { ...fake, ...view };
}

/** 呼び出しの記録から、指定のメソッド・パスの呼び出しだけを返す。 */
export function callsOf(
  calls: readonly FakeRequest[],
  method: string,
  path: string,
): readonly FakeRequest[] {
  return calls.filter((call) => call.method === method && call.path === path);
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function notification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    notificationId: 'n-1' as NotificationItem['notificationId'],
    kind: 'STATUS_CHANGE',
    viewpointId: 'environmentalAdaptability',
    equipmentId: toEquipmentId('HOUSE-01'),
    status: 'ERROR',
    message: '【異常】環境適応性（ハウス1）: 環境適応性: 異常。温度 40.0℃（異常）',
    createdAt: '2026-10-09T02:00:00.000Z',
    readState: 'UNREAD',
    ...overrides,
  };
}

export function manualEntry(overrides: Partial<ManualEntry> = {}): ManualEntry {
  return {
    entryId: 'e-1',
    equipmentId: toEquipmentId('ROBOT-01'),
    category: 'FAILURE',
    observedAt: '2026-10-09T02:00:00.000Z',
    items: { failureCount: 2, recoveryMinutes: 90 },
    note: 'ケーブルを交換した',
    enteredBy: toUserId('worker-1'),
    createdAt: '2026-10-09T02:05:00.000Z',
    updatedAt: '2026-10-09T02:05:00.000Z',
    isDeleted: false,
    ...overrides,
  };
}

export function errorBody(
  status: number,
  code: string,
  message: string,
  fields: { name: string; message: string }[] = [],
): Response {
  return jsonResponse(
    { error: { code, message, ...(fields.length > 0 ? { fields } : {}) } },
    status,
  );
}

/** 配列の指定の位置の要素を返す。なければ、テストの前提が崩れているため、エラーにする。 */
export function at<Item>(items: readonly Item[], index: number): Item {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`テストの前提: ${String(index)} 番目の要素がある`);
  }
  return item;
}
