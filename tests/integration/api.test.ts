/**
 * `/api/v1` の結合テスト（Hono アプリを `app.request` で呼び出す）。
 * 認証・認可（全ルート）、共通エラー形式、実装済みのルート、開発用 API を検証する。
 */

import { describe, expect, it, vi } from 'vitest';
import { DashboardResponseSchema } from '@smart-farm/shared/schemas/evaluation';
import { LoginResponseSchema } from '@smart-farm/shared/schemas/auth';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { EquipmentTreeResponseSchema } from '@smart-farm/shared/schemas/equipment';
import { NotificationListResponseSchema } from '@smart-farm/shared/schemas/notification';
import { createApp } from '../../src/backend/presentation/create-app.ts';
import { ROUTE_TABLE, routeKey } from '../../src/backend/presentation/route-table.ts';
import { LOGIN_FAILURE_LIMIT } from '../../src/backend/infrastructure/local/local-auth.ts';
import { createJsonLogger } from '../../src/backend/infrastructure/logging/json-logger.ts';
import { FACILITY_ID, observation, SENSOR_ID } from '../support/builders.ts';
import {
  addUserAndLogin,
  createTestContext,
  errorOf,
  TEST_NOW,
  TEST_USER,
  THREE_ROLES_JSON,
  withEquipment,
} from '../support/test-context.ts';

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('共通事項', () => {
  it('ヘルスチェックは認証なしで応答し、外部の状態に依存しない', async () => {
    const context = await createTestContext();
    context.container.dev?.faults.federation.set({ mode: 'DOWN' });
    context.container.dev?.faults.fileServer.set({ mode: 'DOWN' });

    const response = await context.app.request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', time: TEST_NOW.toISOString() });
  });

  it('応答に、リクエストの識別子を付け、運用データをキャッシュさせない', async () => {
    const context = await createTestContext();

    const generated = await context.app.request('/health');
    const echoed = await context.app.request('/health', {
      headers: { 'x-request-id': 'request-12345' },
    });
    const rejected = await context.app.request('/health', {
      headers: { 'x-request-id': 'bad id with spaces' },
    });

    expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(echoed.headers.get('x-request-id')).toBe('request-12345');
    expect(rejected.headers.get('x-request-id')).not.toBe('bad id with spaces');
    expect(generated.headers.get('cache-control')).toBe('no-store');
    expect(generated.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('存在しないパスは、共通のエラー形式で 404 を返す', async () => {
    const context = await createTestContext();

    const response = await context.app.request('/api/v1/nothing');

    expect(response.status).toBe(404);
    expect(await errorOf(response)).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('想定外のエラーは、500 と汎用のメッセージだけを返し、内部情報を含めない', async () => {
    const context = await createTestContext();
    vi.spyOn(context.container.repositories.equipment, 'list').mockRejectedValue(
      new Error('C:\\secret\\internal\\path.ts: SELECT * FROM users'),
    );

    const response = await context.request('/equipment');

    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain('secret');
    expect(text).not.toContain('SELECT');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('大きすぎるリクエストは、413 で拒否する', async () => {
    const context = await createTestContext();

    const response = await context.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) },
      body: 'x'.repeat(2 * 1024 * 1024),
    });

    expect(response.status).toBe(413);
    expect(await errorOf(response)).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('認証（UC-13）', () => {
  it('ログインすると、アクセストークン・リフレッシュトークン・有効期限・利用者（権限つき）を返す', async () => {
    const context = await createTestContext();

    const response = await context.app.request(
      '/api/v1/auth/login',
      json({ userId: TEST_USER.userId, password: TEST_USER.password }),
    );

    expect(response.status).toBe(200);
    const body = LoginResponseSchema.parse(await response.json());
    expect(body.user).toMatchObject({
      userId: TEST_USER.userId,
      userName: TEST_USER.userName,
      role: 'worker',
    });
    // 既定は1ロール（農作業者）で、全権限を持つ
    expect(body.user.permissions).toHaveLength(8);
    expect(body.accessTokenExpiresAt).toBe(
      new Date(TEST_NOW.getTime() + 30 * 60_000).toISOString(),
    );
  });

  it('認証に失敗したら、原因を特定できないメッセージで 401 を返す', async () => {
    const context = await createTestContext();

    const wrongPassword = await context.app.request(
      '/api/v1/auth/login',
      json({ userId: TEST_USER.userId, password: 'wrong' }),
    );
    const noSuchUser = await context.app.request(
      '/api/v1/auth/login',
      json({ userId: 'nobody', password: 'wrong' }),
    );

    expect(wrongPassword.status).toBe(401);
    const wrongPasswordError = await errorOf(wrongPassword);
    const noSuchUserError = await errorOf(noSuchUser);
    expect(wrongPasswordError).toEqual(noSuchUserError);
    expect(noSuchUserError.message).toBe('ユーザーIDまたはパスワードが正しくありません');
  });

  it('入力が不正なら、項目ごとのエラーつきの 400 を返す', async () => {
    const context = await createTestContext();

    const missing = await context.app.request('/api/v1/auth/login', json({}));
    const notJson = await context.app.request('/api/v1/auth/login', {
      method: 'POST',
      body: '{',
      headers: { 'content-type': 'application/json' },
    });

    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'userId' }),
        expect.objectContaining({ name: 'password' }),
      ]),
    );
    expect(notJson.status).toBe(400);
    expect(await errorOf(notJson)).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('同じ接続元（X-Forwarded-For）からの失敗が続くと、429 で一時的に拒否する', async () => {
    // 信頼するプロキシが1段（TRUSTED_PROXY_HOPS=1）: 末尾の値（プロキシが付けた接続元）で数える（V-007）
    const context = await createTestContext({ env: { TRUSTED_PROXY_HOPS: '1' } });
    const attempt = (password: string, address: string) =>
      context.app.request('/api/v1/auth/login', {
        ...json({ userId: TEST_USER.userId, password }),
        headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
      });
    for (let count = 0; count < LOGIN_FAILURE_LIMIT; count += 1) {
      expect((await attempt('wrong', `203.0.113.${String(count + 1)}, 192.0.2.1`)).status).toBe(
        401,
      );
    }

    const blocked = await attempt(TEST_USER.password, '198.51.100.7, 192.0.2.1');
    const otherClient = await attempt(TEST_USER.password, '198.51.100.7, 192.0.2.2');

    expect(blocked.status).toBe(429);
    expect(otherClient.status).toBe(200);
  });

  it('リフレッシュトークンでセッションを更新でき、ログアウトでトークンが無効になる', async () => {
    const context = await createTestContext();
    const login = LoginResponseSchema.parse(
      await (
        await context.app.request(
          '/api/v1/auth/login',
          json({ userId: TEST_USER.userId, password: TEST_USER.password }),
        )
      ).json(),
    );

    const refreshed = await context.app.request(
      '/api/v1/auth/refresh',
      json({ refreshToken: login.refreshToken }),
    );
    const refreshedBody = LoginResponseSchema.parse(await refreshed.json());
    const logout = await context.request('/auth/logout', {
      method: 'POST',
      token: refreshedBody.accessToken,
    });
    const afterLogout = await context.request('/equipment', { token: refreshedBody.accessToken });
    const reuse = await context.app.request(
      '/api/v1/auth/refresh',
      json({ refreshToken: login.refreshToken }),
    );

    expect(refreshed.status).toBe(200);
    expect(logout.status).toBe(204);
    expect(afterLogout.status).toBe(401);
    expect(reuse.status).toBe(401);
  });

  it('トークンなしでログアウトすると、401 を返す（ログアウトは要ログイン）', async () => {
    const context = await createTestContext();

    const response = await context.app.request('/api/v1/auth/logout', { method: 'POST' });

    expect(response.status).toBe(401);
  });

  it('ログ・応答に、パスワード・トークン・パスワードのハッシュを出力しない（ログインの成功・失敗・制限・更新・ログアウト・認証エラー）', async () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      sink: { write: (line) => lines.push(line) },
      minimumLevel: 'debug',
    });
    const context = await createTestContext({ logger, env: { TRUSTED_PROXY_HOPS: '1' } });
    const wrongPassword = 'Wrong-Passw0rd-dummy';
    const attempt = (password: string, address: string) =>
      context.app.request('/api/v1/auth/login', {
        ...json({ userId: TEST_USER.userId, password }),
        headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
      });
    for (let count = 0; count < LOGIN_FAILURE_LIMIT; count += 1) {
      await attempt(wrongPassword, '192.0.2.50');
    }
    await attempt(TEST_USER.password, '192.0.2.50');
    const loginResponse = await attempt(TEST_USER.password, '192.0.2.51');
    const loginText = await loginResponse.text();
    const login = LoginResponseSchema.parse(JSON.parse(loginText));
    const refreshResponse = await context.app.request(
      '/api/v1/auth/refresh',
      json({ refreshToken: login.refreshToken }),
    );
    const refreshText = await refreshResponse.text();
    const refreshed = LoginResponseSchema.parse(JSON.parse(refreshText));
    await context.request('/auth/logout', { method: 'POST', token: refreshed.accessToken });
    await context.request('/equipment', { token: refreshed.accessToken });
    await context.app.request('/api/v1/equipment', {
      headers: { authorization: 'Bearer invalid-token-dummy' },
    });

    const passwordHash =
      (await context.container.repositories.users.get(toUserId(TEST_USER.userId)))?.passwordHash ??
      '';
    const output = lines.join('');
    expect(lines.length).toBeGreaterThan(0);
    expect(passwordHash).not.toBe('');
    for (const secret of [
      TEST_USER.password,
      wrongPassword,
      login.accessToken,
      login.refreshToken,
      refreshed.accessToken,
      refreshed.refreshToken,
      'invalid-token-dummy',
      passwordHash,
    ]) {
      expect(output).not.toContain(secret);
    }
    // 応答にも、パスワードのハッシュを含めない
    expect(loginText).not.toContain(passwordHash);
    expect(refreshText).not.toContain(passwordHash);
    expect(loginText).not.toContain('scrypt');
  });

  it('アクセストークンの有効期限が切れたら 401 を返す', async () => {
    const context = await createTestContext();
    const token = await context.login();
    context.clock.advance(31 * 60_000);

    const response = await context.request('/equipment', { token });

    expect(response.status).toBe(401);
  });
});

describe('認証・認可（全ルート）', () => {
  const fill = (path: string) => path.replace(/:[A-Za-z]+/g, 'x');
  const protectedRoutes = ROUTE_TABLE.filter((spec) => spec.access !== 'PUBLIC');

  it('ルート一覧は、機能仕様書 4.1 の API（39件）と、購読の状態の取得（GET /push-subscription。端末ごとの状態を示すため追加）を網羅している（重複なし）', () => {
    const keys = ROUTE_TABLE.map(routeKey);

    expect(new Set(keys).size).toBe(keys.length);
    expect(ROUTE_TABLE).toHaveLength(40);
    expect(keys).toContain('GET /push-subscription');
    expect(ROUTE_TABLE.filter((spec) => spec.access === 'PUBLIC').map(routeKey)).toEqual([
      'POST /auth/login',
      'POST /auth/refresh',
    ]);
  });

  it.each(protectedRoutes.map((spec) => [routeKey(spec), spec] as const))(
    '%s: 未認証・無効なトークンは 401',
    async (_key, spec) => {
      const context = await createTestContext();
      const path = `/api/v1${fill(spec.path)}`;

      const anonymous = await context.app.request(path, { method: spec.method });
      const invalid = await context.app.request(path, {
        method: spec.method,
        headers: { authorization: 'Bearer invalid-token' },
      });
      const malformed = await context.app.request(path, {
        method: spec.method,
        headers: { authorization: 'Basic abc' },
      });

      for (const response of [anonymous, invalid, malformed]) {
        expect(response.status).toBe(401);
        expect(await errorOf(response)).toMatchObject({ code: 'UNAUTHENTICATED' });
      }
    },
  );

  describe('ロールごとの権限（3ロールの設定でも、設定の変更だけで成り立つ）', () => {
    async function threeRoles() {
      const context = await createTestContext({ env: { ROLE_DEFINITIONS_JSON: THREE_ROLES_JSON } });
      const admin = await context.login();
      const evaluator = await addUserAndLogin(context, {
        userId: 'evaluator-1',
        role: 'evaluator',
      });
      const viewer = await addUserAndLogin(context, { userId: 'viewer-1', role: 'viewer' });
      const stranger = await addUserAndLogin(context, {
        userId: 'stranger-1',
        role: 'unknown-role',
      });
      return { context, admin, evaluator, viewer, stranger };
    }

    it.each(protectedRoutes.map((spec) => [routeKey(spec), spec] as const))(
      '%s: 権限がないロールは 403、権限があるロールは認可を通る',
      async (_key, spec) => {
        const { context, admin, evaluator, viewer, stranger } = await threeRoles();
        const call = (token: string) =>
          context.request(fill(spec.path), { method: spec.method, token });
        const passes = (status: number) => status !== 401 && status !== 403;

        const adminStatus = (await call(admin)).status;
        const viewerStatus = (await call(viewer)).status;
        const strangerStatus = (await call(stranger)).status;
        const evaluatorStatus = (await call(evaluator)).status;

        // 管理者は、すべての権限を持つ
        expect(passes(adminStatus)).toBe(true);
        if (spec.access === 'LOGIN') {
          // 要ログインの操作は、権限のないロールでも使える
          expect(passes(viewerStatus)).toBe(true);
          expect(passes(strangerStatus)).toBe(true);
        } else {
          expect(viewerStatus).toBe(403);
          expect(strangerStatus).toBe(403);
          const evaluatorHasIt = [
            'manual-entry:write',
            'criteria:edit',
            'ingestion:run',
            'audit:read',
          ].includes(spec.access);
          expect(passes(evaluatorStatus)).toBe(evaluatorHasIt);
        }
      },
    );

    it('権限のない操作は、共通のエラー形式で 403 を返す', async () => {
      const { context, viewer } = await threeRoles();

      const response = await context.request('/equipment', { method: 'POST', token: viewer });

      expect(response.status).toBe(403);
      expect(await errorOf(response)).toMatchObject({
        code: 'FORBIDDEN',
        message: 'この操作を行う権限がありません',
      });
    });

    it('ログイン応答の権限は、ロールの設定に従う', async () => {
      const { context } = await threeRoles();
      const response = await context.app.request(
        '/api/v1/auth/login',
        json({ userId: 'viewer-1', password: 'Dummy-Passw0rd-extra' }),
      );

      expect(LoginResponseSchema.parse(await response.json()).user.permissions).toEqual([]);
    });
  });
});

describe('設備・ステータスコード（UC-12, UC-17 の参照）', () => {
  it('設備を、ハウス → ロボット／センサーの階層で返す', async () => {
    const context = await withEquipment();

    const body = EquipmentTreeResponseSchema.parse(
      await (await context.request('/equipment')).json(),
    );

    expect(body.facilities).toHaveLength(1);
    expect(body.facilities[0]?.facility.equipmentId).toBe(FACILITY_ID);
    expect(body.facilities[0]?.children.map((child) => child.equipmentType).sort()).toEqual([
      'ROBOT',
      'SENSOR',
    ]);
  });

  it('設備が未登録なら、空の階層を返す', async () => {
    const context = await createTestContext();

    expect(await (await context.request('/equipment')).json()).toEqual({ facilities: [] });
  });

  it('ステータスコードの初期の定義（8件）を、コード値順に返す', async () => {
    const context = await createTestContext();

    const body = (await (await context.request('/status-codes')).json()) as {
      items: { code: string; category: string }[];
    };

    expect(body.items.map((item) => item.code)).toEqual([
      'FALLEN',
      'HARVESTING',
      'HARVEST_ERROR',
      'LOW_BATTERY',
      'RUNNING',
      'RUNNING_ERROR',
      'STANDBY',
      'STOPPED',
    ]);
    expect(body.items.find((item) => item.code === 'FALLEN')?.category).toBe('ERROR');
  });
});

describe('ダッシュボード（UC-01）', () => {
  it('設備を省略すると、最初のハウスの全観点を、スキーマに合う形で返す', async () => {
    const context = await withEquipment();
    await context.container.repositories.observations.saveMany([
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 20,
        observedAt: new Date(TEST_NOW.getTime() - 60_000).toISOString(),
      }),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');

    const response = await context.request('/dashboard');

    expect(response.status).toBe(200);
    const body = DashboardResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      equipmentId: FACILITY_ID,
      horizon: 'LONG',
      periodDays: 7,
      dataFreshness: 'FRESH',
    });
    expect(body.viewpoints).toHaveLength(10);
  });

  it('設備・視点・長期の期間を、クエリで指定できる', async () => {
    const context = await withEquipment();
    await context.container.evaluationService.evaluateAll('DEV');

    const body = DashboardResponseSchema.parse(
      await (
        await context.request(`/dashboard?equipmentId=${SENSOR_ID}&horizon=SHORT&periodDays=30`)
      ).json(),
    );

    expect(body).toMatchObject({ equipmentId: SENSOR_ID, horizon: 'SHORT', periodDays: 30 });
    expect(body.viewpoints).toHaveLength(1);
  });

  it.each([
    ['horizon=MIDDLE'],
    ['periodDays=5'],
    ['periodDays=abc'],
    ['equipmentId=%E6%97%A5%E6%9C%AC'],
  ])('クエリが不正（%s）なら 400', async (query) => {
    const context = await withEquipment();

    const response = await context.request(`/dashboard?${query}`);

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('設備が未登録、または指定した設備がなければ 404', async () => {
    const empty = await createTestContext();
    const registered = await withEquipment();

    expect((await empty.request('/dashboard')).status).toBe(404);
    expect((await registered.request('/dashboard?equipmentId=NONE')).status).toBe(404);
  });

  describe('更新の読み直し（FR-6.7）: 変化がなければ、小さな応答（304）を返す', () => {
    async function withEvaluatedData() {
      const context = await withEquipment();
      await context.container.repositories.observations.saveMany([
        observation({
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: 20,
          observedAt: new Date(TEST_NOW.getTime() - 60_000).toISOString(),
        }),
      ]);
      await context.container.evaluationService.evaluateAll('DEV');
      return context;
    }

    it('応答に ETag を付け、同じ内容で If-None-Match を付けると、本文のない 304 を返す', async () => {
      const context = await withEvaluatedData();
      const first = await context.request('/dashboard');
      const etag = first.headers.get('etag');
      expect(etag).toMatch(/^"[0-9a-f]+"$/);

      const second = await context.request('/dashboard', {
        headers: { 'if-none-match': etag ?? '' },
      });

      expect(second.status).toBe(304);
      expect(await second.text()).toBe('');
      expect(second.headers.get('etag')).toBe(etag);
      expect(second.headers.get('cache-control')).toBe('no-store');
    });

    it('弱い比較（W/）・複数の値・ワイルドカードの If-None-Match でも、一致すれば 304 を返す', async () => {
      const context = await withEvaluatedData();
      const etag = (await context.request('/dashboard')).headers.get('etag') ?? '';

      for (const header of [`W/${etag}`, `"other", ${etag}`, '*']) {
        const response = await context.request('/dashboard', {
          headers: { 'if-none-match': header },
        });
        expect(response.status, header).toBe(304);
      }
    });

    it('一致しない、または評価結果が変わったときは、200 と新しい ETag を返す', async () => {
      const context = await withEvaluatedData();
      const before = (await context.request('/dashboard')).headers.get('etag') ?? '';

      const mismatch = await context.request('/dashboard', {
        headers: { 'if-none-match': '"unknown"' },
      });
      expect(mismatch.status).toBe(200);
      expect(mismatch.headers.get('etag')).toBe(before);

      await context.container.repositories.observations.saveMany([
        observation({
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: 40,
          observedAt: new Date(TEST_NOW.getTime() - 30_000).toISOString(),
        }),
      ]);
      await context.container.evaluationService.evaluateAll('DEV');
      const changed = await context.request('/dashboard', { headers: { 'if-none-match': before } });

      expect(changed.status).toBe(200);
      expect(changed.headers.get('etag')).not.toBe(before);
    });

    it('認証していなければ、If-None-Match があっても 401 を返す（304 で認証を回避できない）', async () => {
      const context = await withEvaluatedData();
      const etag = (await context.request('/dashboard')).headers.get('etag') ?? '';

      const response = await context.app.request('/api/v1/dashboard', {
        headers: { 'if-none-match': etag },
      });

      expect(response.status).toBe(401);
    });
  });
});

describe('通知（UC-05, UC-22）', () => {
  async function withNotifications() {
    const context = await withEquipment();
    await context.container.repositories.observations.saveMany([
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 30,
        observedAt: new Date(TEST_NOW.getTime() - 60_000).toISOString(),
      }),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');
    return context;
  }

  it('通知を新しい順に一覧し、未読の件数を返す', async () => {
    const context = await withNotifications();

    const list = NotificationListResponseSchema.parse(
      await (await context.request('/notifications')).json(),
    );
    const count = await (await context.request('/notifications/unread-count')).json();

    expect(list.items).toHaveLength(3);
    expect(list.items.every((item) => item.readState === 'UNREAD')).toBe(true);
    expect(list.items[0]).toMatchObject({ kind: 'STATUS_CHANGE' });
    expect(list.items[0]).not.toHaveProperty('dedupKey');
    expect(count).toEqual({ unreadCount: 3 });
  });

  it('種別・既読／未読で絞り込め、ページ分割できる', async () => {
    const context = await withNotifications();
    const first = NotificationListResponseSchema.parse(
      await (await context.request('/notifications?limit=2')).json(),
    );
    const second = NotificationListResponseSchema.parse(
      await (
        await context.request(`/notifications?limit=2&cursor=${first.nextCursor ?? ''}`)
      ).json(),
    );
    const environment = NotificationListResponseSchema.parse(
      await (await context.request('/notifications?kind=INGESTION_FAILURE')).json(),
    );
    const unread = NotificationListResponseSchema.parse(
      await (await context.request('/notifications?readState=UNREAD')).json(),
    );

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(environment.items).toEqual([]);
    expect(unread.items).toHaveLength(3);
  });

  it.each([['limit=0'], ['limit=101'], ['kind=OTHER'], ['readState=SEEN'], ['cursor=%21%21']])(
    '一覧のクエリが不正（%s）なら 400',
    async (query) => {
      const context = await withNotifications();

      expect((await context.request(`/notifications?${query}`)).status).toBe(400);
    },
  );

  it('個別に既読にでき、未読の件数に反映される。存在しない通知は 404', async () => {
    const context = await withNotifications();
    const token = await context.login();
    const [first] = NotificationListResponseSchema.parse(
      await (await context.request('/notifications', { token })).json(),
    ).items;

    const read = await context.request(`/notifications/${first?.notificationId ?? ''}/read`, {
      method: 'POST',
      token,
    });
    const missing = await context.request('/notifications/none/read', { method: 'POST', token });

    expect(read.status).toBe(204);
    expect(missing.status).toBe(404);
    expect(await (await context.request('/notifications/unread-count', { token })).json()).toEqual({
      unreadCount: 2,
    });
    const readList = NotificationListResponseSchema.parse(
      await (await context.request('/notifications?readState=READ', { token })).json(),
    );
    expect(readList.items.map((item) => item.notificationId)).toEqual([first?.notificationId]);
  });

  it('一括で既読にでき、本文で範囲を絞れる（本文なしは全件）', async () => {
    const context = await withNotifications();
    const token = await context.login();

    const none = await context.request('/notifications/read-all', {
      method: 'POST',
      token,
      body: { kind: 'INGESTION_FAILURE' },
    });
    const countAfterFilter = await (
      await context.request('/notifications/unread-count', { token })
    ).json();
    const all = await context.request('/notifications/read-all', { method: 'POST', token });
    const countAfterAll = await (
      await context.request('/notifications/unread-count', { token })
    ).json();

    expect(none.status).toBe(204);
    expect(countAfterFilter).toEqual({ unreadCount: 3 });
    expect(all.status).toBe(204);
    expect(countAfterAll).toEqual({ unreadCount: 0 });
  });

  it('一括の既読の本文が不正なら 400', async () => {
    const context = await withNotifications();

    const invalidBody = await context.request('/notifications/read-all', {
      method: 'POST',
      body: { kind: 'OTHER' },
    });
    const notJson = await context.app.request('/api/v1/notifications/read-all', {
      method: 'POST',
      body: 'x',
      headers: { authorization: `Bearer ${await context.login()}` },
    });
    const withFilter = await context.request('/notifications/read-all', {
      method: 'POST',
      body: { readState: 'UNREAD' },
    });

    expect(invalidBody.status).toBe(400);
    expect(notJson.status).toBe(400);
    expect(withFilter.status).toBe(204);
  });
});

describe('開発用 API（ローカル・テストのみ）', () => {
  it('認証が必要', async () => {
    const context = await createTestContext();

    expect((await context.app.request('/api/v1/dev/clock')).status).toBe(401);
  });

  it('ルート一覧のすべてにハンドラがある。ハンドラのないルートがあれば、組み立て時にエラーにする', async () => {
    const context = await createTestContext();
    const withoutHandler = [
      ...ROUTE_TABLE,
      { method: 'GET', path: '/no-handler', access: 'LOGIN', useCases: [] },
    ] as const;

    expect(() => createApp(context.container)).not.toThrow();
    expect(() => createApp(context.container, withoutHandler)).toThrow('GET /no-handler');
  });

  it('本番相当（dev なし）では、ルートを登録しない', async () => {
    const context = await createTestContext();
    const app = createApp({ ...context.container, dev: undefined });

    const response = await app.request('/api/v1/dev/clock', {
      headers: { authorization: `Bearer ${await context.login()}` },
    });

    expect(response.status).toBe(404);
  });

  it('時計を固定・進行・解除できる', async () => {
    const context = await createTestContext();
    const token = await context.login();

    const state = await (await context.request('/dev/clock', { token })).json();
    const set = await (
      await context.request('/dev/clock', {
        method: 'PUT',
        token,
        body: { at: '2026-10-09T03:10:00.000Z', mode: 'FREEZE' },
      })
    ).json();
    const advanced = await (
      await context.request('/dev/clock/advance', { method: 'POST', token, body: { minutes: 15 } })
    ).json();
    const running = (await (
      await context.request('/dev/clock', { method: 'PUT', token, body: { mode: 'RUNNING' } })
    ).json()) as { frozen: boolean };
    const unchanged = await context.request('/dev/clock', { method: 'PUT', token, body: {} });

    expect(state).toEqual({ now: TEST_NOW.toISOString(), frozen: true });
    expect(set).toEqual({ now: '2026-10-09T03:10:00.000Z', frozen: true });
    expect(advanced).toEqual({ now: '2026-10-09T03:25:00.000Z', frozen: true });
    expect(running.frozen).toBe(false);
    expect(unchanged.status).toBe(200);
  });

  it('スケジューラとジョブを、手動で起動できる。存在しないジョブは 404', async () => {
    const context = await withEquipment();
    const token = await context.login();

    const tick = await (
      await context.request('/dev/scheduler/tick', { method: 'POST', token })
    ).json();
    const job = await (
      await context.request('/dev/jobs/JB-02/run', { method: 'POST', token })
    ).json();
    const missing = await context.request('/dev/jobs/JB-99/run', { method: 'POST', token });

    expect(tick).toEqual({ executed: ['JB-01', 'JB-02', 'JB-03', 'JB-04'] });
    expect(job).toMatchObject({ jobId: 'JB-02', summary: { equipmentEvaluated: 3 } });
    expect(missing.status).toBe(404);
  });

  it('モック（ファイルサーバー・農業情報基盤・Web Push）の停止・遅延を再現できる', async () => {
    const context = await withEquipment();
    const token = await context.login();

    const down = await (
      await context.request('/dev/mocks/file-server', {
        method: 'PUT',
        token,
        body: { mode: 'DOWN' },
      })
    ).json();
    const slow = await (
      await context.request('/dev/mocks/federation', {
        method: 'PUT',
        token,
        body: { mode: 'SLOW', delayMs: 2000 },
      })
    ).json();
    const push = await (
      await context.request('/dev/mocks/web-push', { method: 'PUT', token, body: {} })
    ).json();
    const unknown = await context.request('/dev/mocks/none', { method: 'PUT', token, body: {} });
    const invalid = await context.request('/dev/mocks/federation', {
      method: 'PUT',
      token,
      body: { mode: 'BROKEN' },
    });
    const ingestion = await context.container.ingestionService.runSource('robot');

    expect(down).toEqual({ mode: 'DOWN', delayMs: 0 });
    expect(slow).toEqual({ mode: 'SLOW', delayMs: 2000 });
    expect(push).toEqual({ mode: 'UP', delayMs: 0 });
    expect(unknown.status).toBe(404);
    expect(invalid.status).toBe(400);
    expect(ingestion.result).toBe('FAILURE');
  });

  it('モックが受け取った連携・配信の内容を確認できる', async () => {
    const context = await withEquipment();
    const token = await context.login();
    await context.container.evaluationService.evaluateAll('DEV');
    await context.container.jobRunner.run('JB-03');

    const received = (await (
      await context.request('/dev/mocks/federation/received', { token })
    ).json()) as { items: unknown[] };
    const delivered = await (
      await context.request('/dev/mocks/web-push/delivered', { token })
    ).json();

    expect(received.items.length).toBeGreaterThan(0);
    expect(delivered).toEqual({ items: [] });
  });

  it('データをリセットし、初期データ（と、指定ならデモデータ）を入れ直す', async () => {
    const context = await withEquipment();
    const token = await context.login();

    const reset = await context.request('/dev/reset', { method: 'POST', token });
    // リセットで時計が実時間に戻るため、以降の操作は、ログインし直す（初期ユーザーは作り直される）
    const afterReset = EquipmentTreeResponseSchema.parse(
      await (await context.request('/equipment')).json(),
    );
    const demo = await context.request('/dev/reset', { method: 'POST', body: { seed: 'DEMO' } });
    const afterDemo = EquipmentTreeResponseSchema.parse(
      await (await context.request('/equipment')).json(),
    );

    expect(reset.status).toBe(204);
    expect(afterReset.facilities).toEqual([]);
    expect(demo.status).toBe(204);
    expect(afterDemo.facilities[0]?.facility.equipmentId).toBe('HOUSE-01');
    expect((await context.request('/status-codes')).status).toBe(200);
  });
});
