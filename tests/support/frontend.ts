/** フロントエンドのテスト用の補助: API のスタブ（fetch）、応答のデータ（合成データ）、セッション。 */

import { afterEach, beforeEach, vi } from 'vitest';
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
  /** 本文の文字列そのもの（JSON を包まずに送る本文の確認用。本文がなければ undefined）。 */
  readonly rawBody: string | undefined;
  /** 本文の Content-Type。 */
  readonly contentType: string | null;
  readonly authorization: string | null;
  /** 条件つきの GET（前回の ETag）。 */
  readonly ifNoneMatch: string | null;
  /** 版つき更新の条件（読み込んだ時点の ETag）。 */
  readonly ifMatch: string | null;
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

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
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
      body: typeof init?.body === 'string' ? parseJsonOrUndefined(init.body) : undefined,
      rawBody: typeof init?.body === 'string' ? init.body : undefined,
      contentType: headers.get('content-type'),
      authorization: headers.get('authorization'),
      ifNoneMatch: headers.get('if-none-match'),
      ifMatch: headers.get('if-match'),
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
    permissions: ['equipment:manage', 'equipment:view-all', 'ingestion:read', 'user:manage'],
    mustChangePassword: false,
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

/** ハウスが 2 つ（HOUSE-01・HOUSE-02。それぞれ、配下にロボットを持つ）。ダッシュボードの「対象のハウス」の確認用。 */
export function twoFacilityTree(): EquipmentTreeResponse {
  const createdAt = '2026-10-01T00:00:00.000Z';
  const base = equipmentTree();
  return {
    facilities: [
      ...base.facilities,
      {
        facility: {
          equipmentId: toEquipmentId('HOUSE-02'),
          equipmentType: 'FACILITY',
          name: 'ハウス2',
          isDeleted: false,
          createdAt,
        },
        children: [
          {
            equipmentId: toEquipmentId('ROBOT-02'),
            equipmentType: 'ROBOT',
            name: '収穫ロボット2',
            facilityId: toEquipmentId('HOUSE-02'),
            isDeleted: false,
            createdAt,
          },
        ],
      },
    ],
  };
}

export function card(overrides: Partial<ViewpointCard> = {}): ViewpointCard {
  // 短期・長期のステータスは、指定がなければ、カードのステータスと同じにする（短期が悪い、という食い違いを、勝手に作らない）
  const status = overrides.status ?? 'NORMAL';
  return {
    viewpointId: 'safety',
    name: '安全性',
    status: 'NORMAL',
    statuses: { short: status === 'UNKNOWN' ? null : status, long: status },
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

/**
 * 現在の時刻（Date だけ。タイマーは、そのまま）を、`dashboard()` の最終の評価（2026-10-09T03:00:00Z）の 5 分後に固定する
 * （各テストの前後で。評価が更新されていない警告〔最終の評価から 15 分以上。Issue #158〕が、実際の現在の時刻で出ないように）。
 */
export function pinClockToDashboardFixture(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T03:05:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

export function dashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    equipmentId: toEquipmentId('HOUSE-01'),
    horizon: 'LONG',
    periodDays: 7,
    evaluatedAt: '2026-10-09T03:00:00.000Z',
    lastReceivedAt: '2026-10-09T02:55:00.000Z',
    dataFreshness: 'FRESH',
    staleEquipment: [],
    lastManualInputAt: null,
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
