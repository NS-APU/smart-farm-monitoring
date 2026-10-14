import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toEquipmentId } from '../../../src/shared/schemas/common.ts';
import { ApiError, createApiClient } from '../../../src/frontend/api/client.ts';
import {
  getDashboard,
  getEquipmentTree,
  getUnreadCount,
  login,
  logout,
} from '../../../src/frontend/api/endpoints.ts';
import {
  SESSION_STORAGE_KEY,
  createSessionStorageAccess,
  resolveSessionStorage,
} from '../../../src/frontend/api/session-storage.ts';
import {
  WORKER_LOGIN,
  createFakeFetch,
  createMemorySession,
  dashboard,
  equipmentTree,
  errorResponse,
  jsonResponse,
} from '../../support/frontend.ts';

const ItemSchema = z.object({ value: z.number() });

function setup(
  handler: Parameters<typeof createFakeFetch>[0],
  session = createMemorySession(WORKER_LOGIN),
) {
  const fake = createFakeFetch(handler);
  const onSessionExpired = vi.fn();
  const api = createApiClient({ fetchFn: fake.fetchFn, session, onSessionExpired });
  return { ...fake, api, session, onSessionExpired };
}

describe('API クライアント', () => {
  it('認証トークンとクエリ（未指定は除く）を付けて呼び出し、応答をスキーマで検証して返す', async () => {
    const { api, calls } = setup(() => jsonResponse({ value: 3 }));

    const result = await api.request('/items', {
      query: { a: 1, b: undefined, c: 'x' },
      schema: ItemSchema,
    });

    expect(result).toEqual({ value: 3 });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/items',
      authorization: 'Bearer access-token-1',
    });
    expect(calls[0]?.query.get('a')).toBe('1');
    expect(calls[0]?.query.has('b')).toBe(false);
    expect(calls[0]?.query.get('c')).toBe('x');
  });

  it('本文つきの操作は JSON で送る。応答の本文がない操作は undefined を返す', async () => {
    const { api, calls } = setup(() => new Response(null, { status: 204 }));

    await api.command('/items', { method: 'POST', body: { a: 1 } });

    expect(calls[0]).toMatchObject({ method: 'POST', body: { a: 1 } });
  });

  it('認証が不要な呼び出し（anonymous）には、トークンを付けない', async () => {
    const { api, calls } = setup(() => jsonResponse({ value: 1 }));

    await api.request('/items', { schema: ItemSchema, anonymous: true });

    expect(calls[0]?.authorization).toBeNull();
  });

  it('セッションがなければ、トークンを付けず、401 でも更新を試みない', async () => {
    const { api, calls, onSessionExpired } = setup(
      () => errorResponse(401, 'UNAUTHENTICATED', '認証が必要です'),
      createMemorySession(null),
    );

    await expect(api.request('/items', { schema: ItemSchema })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBeNull();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('エラー応答（共通形式）は、コード・メッセージ・項目ごとのエラーを持つ ApiError にする', async () => {
    const { api } = setup(() =>
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: '入力内容に誤りがあります',
            fields: [{ name: 'a', message: 'b' }],
          },
        },
        400,
      ),
    );

    const error = await api
      .request('/items', { schema: ItemSchema })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: '入力内容に誤りがあります',
      fields: [{ name: 'a', message: 'b' }],
    });
  });

  it('エラー応答が共通形式でない・JSON でない場合は、汎用のメッセージにする', async () => {
    const notShaped = setup(() => jsonResponse({ oops: true }, 500));
    const notJson = setup(() => new Response('<html>', { status: 502 }));

    await expect(notShaped.api.request('/x', { schema: ItemSchema })).rejects.toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: expect.stringContaining('エラーが発生しました'),
    });
    await expect(notJson.api.request('/x', { schema: ItemSchema })).rejects.toMatchObject({
      status: 502,
      code: 'INTERNAL_ERROR',
    });
  });

  it('通信できなければ、通信エラーとして、利用者向けのメッセージを返す', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const api = createApiClient({
      fetchFn,
      session: createMemorySession(null),
      onSessionExpired: vi.fn(),
    });

    await expect(api.request('/x', { schema: ItemSchema })).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
      message: expect.stringContaining('接続できませんでした'),
    });
  });

  it('応答がスキーマに合わなければ、不正な応答として扱う', async () => {
    const { api } = setup(() => jsonResponse({ value: 'not a number' }));

    await expect(api.request('/items', { schema: ItemSchema })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  describe('条件つきの読み直し（ETag・304。FR-6.7）', () => {
    const withEtag = (body: unknown, etag: string) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', etag },
      });

    it('応答に ETag があれば、次の同じ GET に If-None-Match を付け、304 なら前回の本文を使う', async () => {
      const { api, calls } = setup((request) =>
        request.ifNoneMatch === '"v1"'
          ? new Response(null, { status: 304 })
          : withEtag({ value: 5 }, '"v1"'),
      );

      const first = await api.request('/items', { schema: ItemSchema });
      const second = await api.request('/items', { schema: ItemSchema });

      expect(first).toEqual({ value: 5 });
      expect(second).toEqual({ value: 5 });
      expect(calls.map((call) => call.ifNoneMatch)).toEqual([null, '"v1"']);
    });

    it('内容が変わった（200）ら、新しい本文と ETag を使う。URL（クエリ）が違えば、別に扱う', async () => {
      let version = 1;
      const { api, calls } = setup((request) => {
        const etag = `"v${String(version)}"`;
        return request.ifNoneMatch === etag
          ? new Response(null, { status: 304 })
          : withEtag({ value: version }, etag);
      });

      await api.request('/items', { query: { a: 1 }, schema: ItemSchema });
      version = 2;
      const changed = await api.request('/items', { query: { a: 1 }, schema: ItemSchema });
      const other = await api.request('/items', { query: { a: 2 }, schema: ItemSchema });
      const again = await api.request('/items', { query: { a: 1 }, schema: ItemSchema });

      expect(changed).toEqual({ value: 2 });
      expect(other).toEqual({ value: 2 });
      expect(again).toEqual({ value: 2 });
      expect(calls.map((call) => call.ifNoneMatch)).toEqual([null, '"v1"', null, '"v2"']);
    });

    it('ETag のない応答・GET 以外の操作は、条件つきにしない', async () => {
      const { api, calls } = setup(() => jsonResponse({ value: 1 }));

      await api.request('/items', { schema: ItemSchema });
      await api.request('/items', { schema: ItemSchema });
      await api.request('/items', { method: 'POST', body: {}, schema: ItemSchema });

      expect(calls.map((call) => call.ifNoneMatch)).toEqual([null, null, null]);
    });

    it('トークンが変わった（更新・別の利用者）ら、前回の本文を使わない', async () => {
      const renewed = { ...WORKER_LOGIN, accessToken: 'access-token-2' };
      const { api, calls, session } = setup((request) =>
        request.ifNoneMatch === null
          ? withEtag({ value: 7 }, '"v1"')
          : new Response(null, { status: 304 }),
      );

      await api.request('/items', { schema: ItemSchema });
      session.set(renewed);
      await api.request('/items', { schema: ItemSchema });

      expect(calls.map((call) => [call.authorization, call.ifNoneMatch])).toEqual([
        ['Bearer access-token-1', null],
        ['Bearer access-token-2', null],
      ]);
    });

    it('401 で更新して再試行するときも、新しいトークンに合わせて条件を付ける', async () => {
      let attempt = 0;
      const renewed = { ...WORKER_LOGIN, accessToken: 'access-token-2' };
      const { api, calls } = setup((request) => {
        if (request.path === '/auth/refresh') {
          return jsonResponse(renewed);
        }
        attempt += 1;
        if (attempt === 1) {
          return withEtag({ value: 1 }, '"v1"');
        }
        return attempt === 2
          ? errorResponse(401, 'UNAUTHENTICATED', '期限切れ')
          : withEtag({ value: 2 }, '"v2"');
      });

      await api.request('/items', { schema: ItemSchema });
      const result = await api.request('/items', { schema: ItemSchema });

      expect(result).toEqual({ value: 2 });
      expect(calls.map((call) => [call.path, call.ifNoneMatch])).toEqual([
        ['/items', null],
        ['/items', '"v1"'],
        ['/auth/refresh', null],
        ['/items', null],
      ]);
    });

    it('前回の本文がないのに 304 が返ったら、不正な応答として扱う', async () => {
      const { api } = setup(() => new Response(null, { status: 304 }));

      await expect(api.request('/items', { schema: ItemSchema })).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
    });
  });

  describe('セッションの更新（401）', () => {
    it('リフレッシュトークンで更新し、新しいトークンで、1度だけ再試行する', async () => {
      let attempt = 0;
      const renewed = {
        ...WORKER_LOGIN,
        accessToken: 'access-token-2',
        refreshToken: 'refresh-token-2',
      };
      const { api, calls, session } = setup((request) => {
        if (request.path === '/auth/refresh') {
          return jsonResponse(renewed);
        }
        attempt += 1;
        return attempt === 1
          ? errorResponse(401, 'UNAUTHENTICATED', '期限切れ')
          : jsonResponse({ value: 9 });
      });

      const result = await api.request('/items', { schema: ItemSchema });

      expect(result).toEqual({ value: 9 });
      expect(calls.map((call) => [call.path, call.authorization])).toEqual([
        ['/items', 'Bearer access-token-1'],
        ['/auth/refresh', null],
        ['/items', 'Bearer access-token-2'],
      ]);
      expect(calls[1]?.body).toEqual({ refreshToken: 'refresh-token-1' });
      expect(session.current?.accessToken).toBe('access-token-2');
    });

    it('更新できなければ、セッションを破棄し、再ログインを求める（期限切れを通知する）', async () => {
      const { api, session, onSessionExpired } = setup((request) =>
        request.path === '/auth/refresh'
          ? errorResponse(401, 'UNAUTHENTICATED', '無効')
          : errorResponse(401, 'UNAUTHENTICATED', '期限切れ'),
      );

      await expect(api.request('/items', { schema: ItemSchema })).rejects.toMatchObject({
        status: 401,
      });

      expect(session.current).toBeNull();
      expect(onSessionExpired).toHaveBeenCalledTimes(1);
    });

    it('更新の応答が不正な形式でも、更新できなかったものとして扱う', async () => {
      const { api, session } = setup((request) =>
        request.path === '/auth/refresh'
          ? jsonResponse({ broken: true })
          : errorResponse(401, 'UNAUTHENTICATED', '期限切れ'),
      );

      await expect(api.command('/items')).rejects.toMatchObject({ status: 401 });

      expect(session.current).toBeNull();
    });

    /**
     * 不具合（Issue #60）: 期限切れで、複数の読み込みが同時に 401 になるとき、更新が終わったあとに、遅れて 401 が届くと、
     * 更新が済んでいることを確認せず、もう一度更新していた。サーバーは、更新のたびに、古いトークンを無効にするため、
     * 1 回目の更新で発行したトークンで再試行していた要求が、401 のまま失敗した。
     * サーバーの模型: 更新のたびに、古いアクセストークンを無効にし、新しい組を発行する（local-auth の refresh と同じ）。
     * 要求 X の再試行は、サーバーに、遅れて届く（要求 Y の 401 のあとに処理される）ものとして、止めておく。
     */
    it('更新が済んでいたら、遅れて届いた 401 では、もう一度更新せず、現在のトークンで再試行する（直前のトークンを無効にしない）', async () => {
      const gate = <Value>() => {
        let release!: (value: Value) => void;
        const promise = new Promise<Value>((resolve) => {
          release = resolve;
        });
        return { promise, release };
      };
      const yFirstResponse = gate<undefined>();
      const xRetryArrives = gate<undefined>();
      let generation = 1;
      let currentRefreshToken = 'refresh-token-1';
      // 最初のアクセストークン（access-token-1）は、期限切れ。リフレッシュトークンは、有効
      let validAccessTokens = new Set<string>();
      let refreshCount = 0;
      let xRetrySent = false;
      let yRetrySent = false;
      const sent = { x: 0, y: 0 };

      const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          'http://localhost',
        );
        const path = url.pathname.replace(/^\/api\/v1/, '');
        const authorization = new Headers(init?.headers).get('authorization');
        if (path === '/auth/refresh') {
          refreshCount += 1;
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            refreshToken?: string;
          };
          if (body.refreshToken !== currentRefreshToken) {
            return errorResponse(401, 'UNAUTHENTICATED', '無効なリフレッシュトークン');
          }
          generation += 1;
          currentRefreshToken = `refresh-token-${String(generation)}`;
          const accessToken = `access-token-${String(generation)}`;
          validAccessTokens = new Set([accessToken]);
          return jsonResponse({ ...WORKER_LOGIN, accessToken, refreshToken: currentRefreshToken });
        }
        const who = url.searchParams.get('who') === 'x' ? 'x' : 'y';
        sent[who] += 1;
        const isRetry = sent[who] > 1;
        if (who === 'y' && !isRetry) {
          await yFirstResponse.promise;
        }
        if (who === 'x' && isRetry) {
          xRetrySent = true;
          await xRetryArrives.promise;
        }
        if (who === 'y' && isRetry) {
          yRetrySent = true;
        }
        // 要求が、サーバーに届いた時点で、トークンが有効かを調べる
        const token = authorization?.replace(/^Bearer /, '') ?? '';
        return validAccessTokens.has(token)
          ? jsonResponse({ value: who === 'x' ? 1 : 2 })
          : errorResponse(401, 'UNAUTHENTICATED', '期限切れ');
      };
      const session = createMemorySession(WORKER_LOGIN);
      const api = createApiClient({ fetchFn, session, onSessionExpired: vi.fn() });

      const x = api.request('/items', { schema: ItemSchema, query: { who: 'x' } });
      const y = api.request('/items', { schema: ItemSchema, query: { who: 'y' } });
      // X が更新を終え、新しいトークンで再試行を送る（サーバーには、まだ届いていない）
      await vi.waitFor(() => {
        expect(xRetrySent).toBe(true);
      });
      // Y の 401 が、更新のあとに、遅れて届く
      yFirstResponse.release(undefined);
      await vi.waitFor(() => {
        expect(yRetrySent).toBe(true);
      });
      // X の再試行が、サーバーに届く
      xRetryArrives.release(undefined);

      await expect(x).resolves.toEqual({ value: 1 });
      await expect(y).resolves.toEqual({ value: 2 });
      expect(refreshCount).toBe(1);
      expect(session.current?.accessToken).toBe('access-token-2');
    });
  });
});

describe('エンドポイントの呼び出し', () => {
  it('ログイン・ログアウト・設備・ダッシュボード・未読の件数を、仕様のパス・クエリで呼び出す', async () => {
    const { api, calls } = setup((request) => {
      switch (request.path) {
        case '/auth/login':
          return jsonResponse(WORKER_LOGIN);
        case '/auth/logout':
          return new Response(null, { status: 204 });
        case '/equipment':
          return jsonResponse(equipmentTree());
        case '/dashboard':
          return jsonResponse(dashboard());
        case '/notifications/unread-count':
          return jsonResponse({ unreadCount: 4 });
        default:
          return undefined;
      }
    });

    expect((await login(api, 'worker-1', 'pw')).user.userName).toBe('農作業者A');
    expect((await getEquipmentTree(api)).facilities).toHaveLength(1);
    expect(
      (
        await getDashboard(api, {
          equipmentId: toEquipmentId('HOUSE-01'),
          horizon: 'SHORT',
          periodDays: 30,
        })
      ).summary.NORMAL,
    ).toBe(1);
    expect(await getUnreadCount(api)).toEqual({ unreadCount: 4 });
    await logout(api);

    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/auth/login',
      body: { userId: 'worker-1', password: 'pw' },
      authorization: null,
    });
    expect(calls[2]?.query.get('equipmentId')).toBe('HOUSE-01');
    expect(calls[2]?.query.get('horizon')).toBe('SHORT');
    expect(calls[2]?.query.get('periodDays')).toBe('30');
    expect(calls[4]).toMatchObject({ method: 'POST', path: '/auth/logout' });
  });
});

describe('セッションの保持（sessionStorage）', () => {
  it('保存・読み込み・破棄ができる', () => {
    const storage = window.sessionStorage;
    storage.clear();
    const access = createSessionStorageAccess(storage);

    expect(access.get()).toBeNull();
    access.set(WORKER_LOGIN);
    expect(JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? 'null')).toMatchObject({
      accessToken: 'access-token-1',
    });
    // 新しいインスタンスでも、保存した内容を読み込める（再読み込み）
    expect(createSessionStorageAccess(storage).get()).toEqual(WORKER_LOGIN);
    access.clear();
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(access.get()).toBeNull();
  });

  it('保存内容が壊れている・形式が違う場合は、未ログインとして扱う', () => {
    const storage = window.sessionStorage;
    storage.setItem(SESSION_STORAGE_KEY, '{broken');
    expect(createSessionStorageAccess(storage).get()).toBeNull();
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: 1 }));
    expect(createSessionStorageAccess(storage).get()).toBeNull();
    storage.clear();
  });

  it('ブラウザの保存領域が使えなくても、メモリ上で動作する', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const withBroken = createSessionStorageAccess(broken);
    const withoutStorage = createSessionStorageAccess(undefined);

    expect(withBroken.get()).toBeNull();
    withBroken.set(WORKER_LOGIN);
    expect(withBroken.get()).toEqual(WORKER_LOGIN);
    withBroken.clear();
    expect(withBroken.get()).toBeNull();
    withoutStorage.set(WORKER_LOGIN);
    expect(withoutStorage.get()).toEqual(WORKER_LOGIN);
  });

  it('sessionStorage へのアクセスが禁止されている場合は undefined を返す', () => {
    expect(resolveSessionStorage()).toBe(window.sessionStorage);
    const spy = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(resolveSessionStorage()).toBeUndefined();
    spy.mockRestore();
  });
});
