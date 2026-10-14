/**
 * フロントエンドの耐障害性（レビュー V-059・V-060・V-061・V-063・V-116・V-167）のテスト。
 * API クライアントの JSON でない応答・タイムアウト、ポーリングの一時的な失敗、エラーバウンダリ、権限の表示の更新。
 */

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toUserId } from '../../../src/shared/schemas/common.ts';
import { App } from '../../../src/frontend/app.tsx';
import { withBaseRoutes } from '../../support/management-frontend.ts';
import { ApiError, createApiClient } from '../../../src/frontend/api/client.ts';
import { AuthProvider, useAuth } from '../../../src/frontend/auth/auth-context.tsx';
import { ErrorBoundary } from '../../../src/frontend/components/error-boundary.tsx';
import { POLLING_INTERVAL_MS, usePolling } from '../../../src/frontend/hooks/use-polling.ts';
import { Routes, matchPath, navigate } from '../../../src/frontend/router/router.tsx';
import {
  WORKER_LOGIN,
  dashboard,
  equipmentTree,
  createFakeFetch,
  createMemorySession,
  errorResponse,
  jsonResponse,
} from '../../support/frontend.ts';

const ItemSchema = z.object({ value: z.number() });

describe('API クライアント: JSON でない応答（V-059）', () => {
  it('200 の本文が JSON でなければ、構文エラーではなく、ApiError（INVALID_RESPONSE）にする', async () => {
    const { fetchFn } = createFakeFetch(
      () => new Response('<html>Bad Gateway</html>', { status: 200 }),
    );
    const api = createApiClient({
      fetchFn,
      session: createMemorySession(WORKER_LOGIN),
      onSessionExpired: vi.fn(),
    });

    await expect(api.request('/items', { schema: ItemSchema })).rejects.toMatchObject({
      name: 'ApiError',
      code: 'INVALID_RESPONSE',
    });
  });

  it('更新（refresh）の応答が JSON でなければ、更新の失敗として扱い、再ログインを求める', async () => {
    const onSessionExpired = vi.fn();
    const session = createMemorySession(WORKER_LOGIN);
    const { fetchFn } = createFakeFetch((request) =>
      request.path === '/auth/refresh'
        ? new Response('not json', { status: 200 })
        : errorResponse(401, 'UNAUTHENTICATED', '期限切れ'),
    );
    const api = createApiClient({ fetchFn, session, onSessionExpired });

    await expect(api.request('/items', { schema: ItemSchema })).rejects.toBeInstanceOf(ApiError);

    expect(session.current).toBeNull();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

describe('API クライアント: タイムアウト（V-060）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('応答がなければ、指定の時間のあとに、リクエストを中止し、通信エラー（NETWORK_ERROR）にする', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchFn = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal !== undefined && signal !== null) {
            signals.push(signal);
            signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }
        }),
    );
    const api = createApiClient({
      fetchFn,
      session: createMemorySession(WORKER_LOGIN),
      onSessionExpired: vi.fn(),
      timeoutMs: 5000,
    });

    const request = api.request('/items', { schema: ItemSchema });
    const expectation = expect(request).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await vi.advanceTimersByTimeAsync(5000);

    await expectation;
    expect(signals[0]?.aborted).toBe(true);
  });

  it('時間内に応答があれば、タイマーを解除する（中止しない）', async () => {
    vi.useFakeTimers();
    const { fetchFn } = createFakeFetch(() => jsonResponse({ value: 1 }));
    const api = createApiClient({
      fetchFn,
      session: createMemorySession(WORKER_LOGIN),
      onSessionExpired: vi.fn(),
      timeoutMs: 5000,
    });

    const result = await api.request('/items', { schema: ItemSchema });

    expect(result).toEqual({ value: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('定期的な取得: 一時的な失敗（V-061）と、タブの再表示（V-167）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('取得済みのデータがあれば、更新の失敗でも、データを保持し、失敗は refreshError で伝える。次の成功で復帰する', async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('最初のデータ')
      .mockRejectedValueOnce(new Error('一時的な切断'))
      .mockResolvedValue('回復したデータ');
    const { result } = renderHook(() => usePolling(fetcher));
    await advance(0);
    expect(result.current).toMatchObject({ data: '最初のデータ', error: undefined });

    await advance(POLLING_INTERVAL_MS);

    expect(result.current.data).toBe('最初のデータ');
    expect(result.current.error).toBeUndefined();
    expect(result.current.refreshError?.message).toBe('一時的な切断');

    await advance(POLLING_INTERVAL_MS);

    expect(result.current).toMatchObject({ data: '回復したデータ', refreshError: undefined });
  });

  it('連続して3回失敗したら、データを破棄して、エラーにする', async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('データ')
      .mockRejectedValue(new Error('切断'));
    const { result } = renderHook(() => usePolling(fetcher));
    await advance(0);

    await advance(POLLING_INTERVAL_MS);
    await advance(POLLING_INTERVAL_MS);
    expect(result.current.data).toBe('データ');
    await advance(POLLING_INTERVAL_MS);

    expect(result.current.data).toBeUndefined();
    expect(result.current.error?.message).toBe('切断');
  });

  it('最初の取得の失敗は、従来どおり、エラーにする（保持するデータがない）', async () => {
    const fetcher = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('失敗'));
    const { result } = renderHook(() => usePolling(fetcher));

    await advance(0);

    expect(result.current).toMatchObject({ data: undefined, refreshError: undefined });
    expect(result.current.error?.message).toBe('失敗');
  });

  it('タブが非表示から表示に戻ったら、次の間隔を待たず、すぐに取得し直す', async () => {
    const fetcher = vi.fn<() => Promise<string>>().mockResolvedValue('x');
    renderHook(() => usePolling(fetcher));
    await advance(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    // 非表示になる（取得しない）
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(0);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('アンマウント後は、タブの再表示のイベントに反応しない', async () => {
    const fetcher = vi.fn<() => Promise<string>>().mockResolvedValue('x');
    const { unmount } = renderHook(() => usePolling(fetcher));
    await advance(0);

    unmount();
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(0);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('ルーター・エラーバウンダリ（V-063）', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/');
  });

  it('不正なパーセント符号を含む URL は、例外にせず、一致なし（null）にする', () => {
    expect(matchPath('/viewpoints/:viewpointId', '/viewpoints/%E0%A4%A')).toBeNull();
    expect(matchPath('/viewpoints/:viewpointId', '/viewpoints/%E6%97%A5')).toEqual({
      viewpointId: '日',
    });
  });

  it('不正な URL を開いても、フォールバック（NotFound）を表示し、アプリ全体が白紙にならない', () => {
    window.history.pushState(null, '', '/items/%E0%A4%A');
    render(
      <Routes
        routes={[{ path: '/items/:id', render: () => <p>項目</p> }]}
        fallback={<p>見つかりません</p>}
      />,
    );

    expect(screen.getByText('見つかりません')).toBeDefined();
  });

  function Broken(): ReactNode {
    throw new Error('描画の失敗');
  }

  it('描画で例外が起きても、「画面を表示できませんでした」と、ダッシュボードへの導線を表示する', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert').textContent).toContain('画面を表示できませんでした');
    expect(screen.getByRole('link', { name: 'ダッシュボードへ戻る' }).getAttribute('href')).toBe(
      '/',
    );
    consoleError.mockRestore();
  });

  it('導線から移動すると、エラーを解除して、通常の画面を表示する', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let broken = true;
    function Maybe(): ReactNode {
      if (broken) {
        throw new Error('描画の失敗');
      }
      return <p>通常の画面</p>;
    }
    render(
      <ErrorBoundary>
        <Maybe />
      </ErrorBoundary>,
    );
    broken = false;

    act(() => {
      navigate('/other');
    });

    expect(screen.getByText('通常の画面')).toBeDefined();
    consoleError.mockRestore();
  });

  it('例外がなければ、そのまま子を表示する', () => {
    render(
      <ErrorBoundary>
        <p>正常</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('正常')).toBeDefined();
  });
});

describe('権限の表示の更新（V-116）', () => {
  function Probe(): ReactNode {
    const { user, api } = useAuth();
    return (
      <div>
        <p data-testid="role">{user?.role ?? 'none'}</p>
        <p data-testid="permissions">{user?.permissions.join(',') ?? ''}</p>
        <button
          type="button"
          onClick={() => {
            void api.request('/items', { schema: ItemSchema });
          }}
        >
          読み込む
        </button>
      </div>
    );
  }

  it('セッションの更新（401 → refresh）で、新しいロール・権限を受け取ったら、画面の権限の表示も更新する', async () => {
    const renewed = {
      ...WORKER_LOGIN,
      accessToken: 'access-token-2',
      refreshToken: 'refresh-token-2',
      user: { ...WORKER_LOGIN.user, userId: toUserId('worker-1'), role: 'viewer', permissions: [] },
    };
    let attempt = 0;
    const { fetchFn } = createFakeFetch((request) => {
      if (request.path === '/auth/refresh') {
        return jsonResponse(renewed);
      }
      attempt += 1;
      return attempt === 1
        ? errorResponse(401, 'UNAUTHENTICATED', '期限切れ')
        : jsonResponse({ value: 1 });
    });
    render(
      <AuthProvider session={createMemorySession(WORKER_LOGIN)} fetchFn={fetchFn}>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId('role').textContent).toBe('worker');

    fireEvent.click(screen.getByRole('button', { name: '読み込む' }));

    await vi.waitFor(() => {
      expect(screen.getByTestId('role').textContent).toBe('viewer');
    });
    expect(screen.getByTestId('permissions').textContent).toBe('');
  });
});

describe('ダッシュボード: 更新の一時的な失敗（V-061）', () => {
  it('取得済みのカードを表示したまま、「最新の情報を取得できませんでした」の帯を表示する。回復すれば消える', async () => {
    window.history.pushState(null, '', '/');
    let failing = false;
    const routes = withBaseRoutes({
      'GET /equipment': () => jsonResponse(equipmentTree()),
      'GET /dashboard': () =>
        failing ? errorResponse(500, 'INTERNAL_ERROR', '一時的な障害') : jsonResponse(dashboard()),
    });
    const { fetchFn } = createFakeFetch(routes);
    render(<App session={createMemorySession(WORKER_LOGIN)} fetchFn={fetchFn} />);
    expect(await screen.findByRole('heading', { name: '安全性' })).toBeDefined();
    expect(screen.queryByTestId('stale-data-notice')).toBeNull();

    failing = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect((await screen.findByTestId('stale-data-notice')).textContent).toContain(
      '最新の情報を取得できませんでした',
    );
    expect(screen.getByRole('heading', { name: '安全性' })).toBeDefined();

    failing = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.waitFor(() => {
      expect(screen.queryByTestId('stale-data-notice')).toBeNull();
    });
  });
});
