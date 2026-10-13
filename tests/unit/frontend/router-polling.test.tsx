import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useCallback } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDateTimeJst } from '../../../src/frontend/components/format.ts';
import { POLLING_INTERVAL_MS, usePolling } from '../../../src/frontend/hooks/use-polling.ts';
import {
  Link,
  Routes,
  matchPath,
  navigate,
  useLocation,
} from '../../../src/frontend/router/router.tsx';

describe('パスの一致', () => {
  it.each([
    ['/', '/', {}],
    ['/viewpoints/:viewpointId', '/viewpoints/safety', { viewpointId: 'safety' }],
    ['/a/:x/b/:y', '/a/1/b/%E6%97%A5', { x: '1', y: '日' }],
    ['/settings/users', '/settings/users/', {}],
  ])('%s は %s に一致し、パラメータを返す', (pattern, pathname, params) => {
    expect(matchPath(pattern, pathname)).toEqual(params);
  });

  it.each([
    ['/a', '/b'],
    ['/a/:x', '/a'],
    ['/a', '/a/b'],
    ['/a/b', '/a/c'],
  ])('%s は %s に一致しない', (pattern, pathname) => {
    expect(matchPath(pattern, pathname)).toBeNull();
  });
});

describe('ルーター', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/');
  });

  function Where() {
    const { pathname, search } = useLocation();
    return <p data-testid="where">{`${pathname}?${search.toString()}`}</p>;
  }

  it('現在のパスとクエリを返し、navigate で位置が変わる（履歴に追加、または置き換え）', () => {
    render(<Where />);
    expect(screen.getByTestId('where').textContent).toBe('/?');

    act(() => {
      navigate('/a?x=1');
    });
    expect(screen.getByTestId('where').textContent).toBe('/a?x=1');
    const length = window.history.length;

    act(() => {
      navigate('/b', { replace: true });
    });
    expect(screen.getByTestId('where').textContent).toBe('/b?');
    expect(window.history.length).toBe(length);
  });

  it('ブラウザの戻る・進む（popstate）に追従する', () => {
    render(<Where />);
    act(() => {
      navigate('/first');
      navigate('/second');
    });

    act(() => {
      window.history.back();
    });

    return vi.waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/first?');
    });
  });

  it('一致したルートを描画し、なければフォールバックを描画する', () => {
    const routes = [
      { path: '/', render: () => <p>ホーム</p> },
      {
        path: '/items/:id',
        render: (params: Readonly<Record<string, string>>) => <p>{`項目 ${params.id ?? ''}`}</p>,
      },
    ];
    render(<Routes routes={routes} fallback={<p>なし</p>} />);
    expect(screen.getByText('ホーム')).toBeDefined();

    act(() => {
      navigate('/items/42');
    });
    expect(screen.getByText('項目 42')).toBeDefined();

    act(() => {
      navigate('/unknown');
    });
    expect(screen.getByText('なし')).toBeDefined();
  });

  it('リンクを押すと、ページを読み込み直さずに移動する。onClick も呼ぶ', () => {
    const onClick = vi.fn();
    render(
      <>
        <Link to="/target" onClick={onClick}>
          移動
        </Link>
        <Where />
      </>,
    );

    fireEvent.click(screen.getByRole('link', { name: '移動' }));

    expect(screen.getByTestId('where').textContent).toBe('/target?');
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: '移動' }).getAttribute('href')).toBe('/target');
  });

  it.each([
    ['修飾キー（Ctrl）', { ctrlKey: true }],
    ['修飾キー（Meta）', { metaKey: true }],
    ['修飾キー（Shift）', { shiftKey: true }],
    ['修飾キー（Alt）', { altKey: true }],
    ['マウスの中ボタン', { button: 1 }],
  ])('%s つきのクリックは、ブラウザの既定の動作（新しいタブなど）に任せる', (_name, init) => {
    // 既定の動作（ブラウザの移動）は、jsdom では実装されていないため、最後に止める
    const stopNavigation = (event: Event) => {
      event.preventDefault();
    };
    document.addEventListener('click', stopNavigation);
    render(
      <>
        <Link to="/target">移動</Link>
        <Where />
      </>,
    );

    fireEvent.click(screen.getByRole('link', { name: '移動' }), init);
    document.removeEventListener('click', stopNavigation);

    expect(screen.getByTestId('where').textContent).toBe('/?');
  });

  it('onClick が既定の動作を止めた場合は、移動しない', () => {
    render(
      <>
        <Link
          to="/target"
          onClick={(event) => {
            event.preventDefault();
          }}
        >
          移動
        </Link>
        <Where />
      </>,
    );

    fireEvent.click(screen.getByRole('link', { name: '移動' }));

    expect(screen.getByTestId('where').textContent).toBe('/?');
  });
});

describe('定期的な取得（usePolling）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function flush() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it('最初に取得し、結果が得られるまで読み込み中にする', async () => {
    const fetcher = vi.fn().mockResolvedValue('データ');
    const { result } = renderHook(() => usePolling(fetcher));
    expect(result.current).toMatchObject({ isLoading: true, data: undefined });

    await flush();

    expect(result.current).toMatchObject({ isLoading: false, data: 'データ', error: undefined });
  });

  it('取得に失敗したら、エラーを返す（Error 以外の値は Error にする）', async () => {
    const failing = vi.fn().mockRejectedValue('失敗');
    const { result } = renderHook(() => usePolling(failing));

    await flush();

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('失敗');
    expect(result.current.isLoading).toBe(false);
  });

  it('Error の失敗は、そのまま返す', async () => {
    const error = new Error('失敗です');
    // 取得関数は、呼び出し側で安定させる（毎回新しい関数だと、描画のたびに取得し直してしまう）
    const failing = () => Promise.reject(error);
    const { result } = renderHook(() => usePolling(failing));

    await flush();

    expect(result.current.error).toBe(error);
  });

  it(`約${String(POLLING_INTERVAL_MS / 1000)}秒間隔で、タブが表示されているときだけ取得し直す`, async () => {
    const fetcher = vi.fn().mockResolvedValue('x');
    renderHook(() => usePolling(fetcher));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 3);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    visibility.mockReturnValue('visible');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('取得関数が変わったら、読み込み中に戻して取得し直す', async () => {
    const { result, rerender } = renderHook(
      ({ id }) => usePolling(useCallback(() => Promise.resolve(`データ${String(id)}`), [id])),
      { initialProps: { id: 1 } },
    );
    await flush();
    expect(result.current.data).toBe('データ1');

    rerender({ id: 2 });
    expect(result.current).toMatchObject({ isLoading: true, data: undefined });
    await flush();

    expect(result.current.data).toBe('データ2');
  });

  it('すぐに取得し直せる', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('一回目').mockResolvedValueOnce('二回目');
    const { result } = renderHook(() => usePolling(fetcher));
    await flush();

    act(() => {
      result.current.reload();
    });
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe('二回目');
  });

  it('画面を閉じたあとに届いた結果は、反映しない。定期の取得も止める', async () => {
    let resolveFetch: (value: string) => void = () => undefined;
    let rejectFetch: (error: Error) => void = () => undefined;
    const pending = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFetch = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectFetch = reject;
          }),
      );
    const first = renderHook(() => usePolling(pending));
    first.unmount();
    resolveFetch('遅れて届いた');
    const second = renderHook(() => usePolling(pending));
    second.unmount();
    rejectFetch(new Error('遅れて失敗'));
    await flush();
    const calls = pending.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 2);
    });

    expect(first.result.current.data).toBeUndefined();
    expect(second.result.current.error).toBeUndefined();
    expect(pending.mock.calls.length).toBe(calls);
  });
});

describe('日時の表示', () => {
  it('UTC の日時を、日本時間で表示する', () => {
    expect(formatDateTimeJst('2026-10-09T03:04:05Z')).toBe('2026/10/09 12:04:05');
  });

  it('欠損・不正な日時は「—」で表示する', () => {
    expect(formatDateTimeJst(null)).toBe('—');
    expect(formatDateTimeJst(undefined)).toBe('—');
    expect(formatDateTimeJst('not a date')).toBe('—');
  });
});
