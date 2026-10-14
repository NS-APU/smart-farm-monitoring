/** フロントエンドのテスト用の補助: API のスタブ（fetch）、応答のデータ（合成データ）、セッション。 */

import { vi } from 'vitest';
import type { LoginResponse } from '@smart-farm/shared/schemas/auth';
import { toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
import type { DashboardResponse, ViewpointCard } from '@smart-farm/shared/schemas/evaluation';
import type { EquipmentTreeResponse } from '@smart-farm/shared/schemas/equipment';
import type { SessionAccess } from '../../src/frontend/api/client.ts';

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly authorization: string | null;
  /** 条件つきの GET（前回の ETag）。 */
  readonly ifNoneMatch: string | null;
}

export type FakeHandler = (request: FakeRequest) => Response | Promise<Response> | undefined;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

/** API のスタブ。ハンドラが undefined を返したリクエストは、404 にする。呼び出しを記録する。 */
export function createFakeFetch(handler: FakeHandler) {
  const calls: FakeRequest[] = [];
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const address =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(address, 'http://localhost');
    const headers = new Headers(init?.headers);
    const request: FakeRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api\/v1/, ''),
      query: url.searchParams,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      authorization: headers.get('authorization'),
      ifNoneMatch: headers.get('if-none-match'),
    };
    calls.push(request);
    return Promise.resolve(handler(request) ?? errorResponse(404, 'NOT_FOUND', '見つかりません'));
  });
  return { fetchFn, calls };
}

export function createMemorySession(
  initial: LoginResponse | null = null,
): SessionAccess & { current: LoginResponse | null } {
  const state = { current: initial };
  return {
    get current() {
      return state.current;
    },
    get: () => state.current,
    set(session) {
      state.current = session;
    },
    clear() {
      state.current = null;
    },
  };
}

export const WORKER_LOGIN: LoginResponse = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  accessTokenExpiresAt: '2026-10-09T03:30:00.000Z',
  refreshTokenExpiresAt: '2026-10-16T03:00:00.000Z',
  user: {
    userId: toUserId('worker-1'),
    userName: '農作業者A',
    role: 'worker',
    permissions: ['equipment:manage', 'user:manage'],
  },
};

export const VIEWER_LOGIN: LoginResponse = {
  ...WORKER_LOGIN,
  user: { ...WORKER_LOGIN.user, userName: '閲覧者B', role: 'viewer', permissions: [] },
};

export function equipmentTree(): EquipmentTreeResponse {
  const createdAt = '2026-10-01T00:00:00.000Z';
  return {
    facilities: [
      {
        facility: {
          equipmentId: toEquipmentId('HOUSE-01'),
          equipmentType: 'FACILITY',
          name: 'ハウス1',
          isDeleted: false,
          createdAt,
        },
        children: [
          {
            equipmentId: toEquipmentId('ROBOT-01'),
            equipmentType: 'ROBOT',
            name: '収穫ロボット1',
            facilityId: toEquipmentId('HOUSE-01'),
            isDeleted: false,
            createdAt,
          },
          {
            equipmentId: toEquipmentId('SENSOR-01'),
            equipmentType: 'SENSOR',
            name: '環境センサー1',
            facilityId: toEquipmentId('HOUSE-01'),
            isDeleted: false,
            createdAt,
          },
        ],
      },
    ],
  };
}

export function card(overrides: Partial<ViewpointCard> = {}): ViewpointCard {
  return {
    viewpointId: 'safety',
    name: '安全性',
    status: 'NORMAL',
    statuses: { short: 'NORMAL', long: 'NORMAL' },
    metrics: { emergencyStopPerHour: 0, nearMissPerHour: null },
    metricStatuses: { emergencyStopPerHour: 'NORMAL' },
    statusDetail: null,
    diagnosticMessage: '安全性: 正常。緊急停止頻度 0.000回/時間（正常）',
    recommendedAction: '現在の状態を維持し、引き続き推移を確認してください',
    evaluatedFrom: '2026-10-02T03:00:00.000Z',
    evaluatedTo: '2026-10-09T03:00:00.000Z',
    isCustomCriteria: false,
    horizonUsed: 'LONG',
    ...overrides,
  };
}

export function dashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    equipmentId: toEquipmentId('HOUSE-01'),
    horizon: 'LONG',
    periodDays: 7,
    evaluatedAt: '2026-10-09T03:00:00.000Z',
    lastReceivedAt: '2026-10-09T02:55:00.000Z',
    dataFreshness: 'FRESH',
    staleThresholdMinutes: 45,
    summary: { NORMAL: 1, CAUTION: 1, ERROR: 0, UNKNOWN: 1 },
    viewpoints: [
      card(),
      card({
        viewpointId: 'harvestSpeed',
        name: '収穫速度',
        status: 'CAUTION',
        metrics: { averageSecondsPerFruit: 72, travelStoppedRatePercent: 2 },
        statusDetail: { code: 'HARVESTING', name: '収穫中', category: 'NORMAL' },
        isCustomCriteria: true,
      }),
      card({
        viewpointId: 'satisfaction',
        name: '満足度',
        status: 'UNKNOWN',
        statuses: { short: null, long: 'UNKNOWN' },
        metrics: {},
        metricStatuses: {},
        evaluatedFrom: null,
        evaluatedTo: null,
      }),
    ],
    ...overrides,
  };
}
