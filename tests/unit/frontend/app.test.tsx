import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResponse } from '@smart-farm/shared/schemas/auth';
import { App } from '../../../src/frontend/app.tsx';
import { safeNextPath } from '../../../src/frontend/pages/login-page.tsx';
import { withBaseRoutes } from '../../support/management-frontend.ts';
import {
  VIEWER_LOGIN,
  WORKER_LOGIN,
  card,
  createFakeFetch,
  createMemorySession,
  dashboard,
  equipmentTree,
  errorResponse,
  jsonResponse,
  type FakeHandler,
  type FakeRequest,
} from '../../support/frontend.ts';

interface Scenario {
  readonly login?: (request: FakeRequest) => Response;
  readonly dashboard?: (request: FakeRequest) => Response;
  readonly equipment?: (request: FakeRequest) => Response;
  readonly unread?: number;
}

function handlerOf(scenario: Scenario = {}): FakeHandler {
  // 共通のルート（設備の階層・未読の件数・ステータスコード）に、このテストのルートを重ねる
  const baseRoutes = withBaseRoutes({
    'GET /equipment': scenario.equipment ?? (() => jsonResponse(equipmentTree())),
    'GET /dashboard': scenario.dashboard ?? (() => jsonResponse(dashboard())),
    'GET /notifications/unread-count': () => jsonResponse({ unreadCount: scenario.unread ?? 2 }),
  });
  return (request) => {
    switch (`${request.method} ${request.path}`) {
      case 'POST /auth/login':
        return (scenario.login ?? (() => jsonResponse(WORKER_LOGIN)))(request);
      case 'POST /auth/logout':
        return new Response(null, { status: 204 });
      default:
        return baseRoutes(request);
    }
  };
}

function renderApp(
  options: {
    path?: string;
    session?: LoginResponse | null;
    scenario?: Scenario;
    handler?: FakeHandler;
  } = {},
) {
  window.history.pushState(null, '', options.path ?? '/');
  const session = createMemorySession(
    options.session === undefined ? WORKER_LOGIN : options.session,
  );
  const fake = createFakeFetch(options.handler ?? handlerOf(options.scenario));
  const view = render(<App session={session} fetchFn={fake.fetchFn} />);
  return { ...fake, session, ...view };
}

function fillLogin(userId: string, password: string) {
  fireEvent.change(screen.getByLabelText('ユーザーID'), { target: { value: userId } });
  fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: password } });
}

const dashboardCalls = (calls: readonly FakeRequest[]) =>
  calls.filter((call) => call.path === '/dashboard');

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('ログイン（UC-13。SC-01）', () => {
  it('未認証のアクセスは、ログイン画面へ誘導する（戻り先を保持）', async () => {
    renderApp({ session: null, path: '/notifications?kind=INGESTION_FAILURE' });

    expect(await screen.findByRole('heading', { name: 'ログイン', level: 2 })).toBeDefined();
    expect(window.location.pathname).toBe('/login');
    expect(new URLSearchParams(window.location.search).get('next')).toBe(
      '/notifications?kind=INGESTION_FAILURE',
    );
  });

  it('ユーザーID・パスワードが未入力なら、項目ごとのエラーを表示し、サーバーへ送らない', async () => {
    const { calls } = renderApp({ session: null, path: '/login' });

    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

    expect(await screen.findByText('ユーザーIDを入力してください')).toBeDefined();
    expect(screen.getByText('パスワードを入力してください')).toBeDefined();
    expect(screen.getByLabelText('ユーザーID').getAttribute('aria-invalid')).toBe('true');
    expect(calls).toHaveLength(0);
  });

  it('入力のエラーは、入力し直して送信すると消える', async () => {
    renderApp({ session: null, path: '/login' });
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));
    await screen.findByText('ユーザーIDを入力してください');

    fillLogin('worker-1', 'Dummy-Passw0rd-1');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

    await waitFor(() => {
      expect(screen.queryByText('ユーザーIDを入力してください')).toBeNull();
    });
  });

  it('認証に成功したら、戻り先へ移動し、セッションを保存する', async () => {
    const { session, calls } = renderApp({ session: null, path: '/login?next=%2Fnotifications' });

    fillLogin('worker-1', 'Dummy-Passw0rd-1');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

    expect(await screen.findByText('農作業者A')).toBeDefined();
    expect(window.location.pathname).toBe('/notifications');
    expect(session.current?.accessToken).toBe('access-token-1');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/auth/login',
      body: { userId: 'worker-1', password: 'Dummy-Passw0rd-1' },
    });
  });

  it('戻り先がなければ、ダッシュボードへ移動する。外部のサイトへは誘導しない', async () => {
    renderApp({ session: null, path: '/login?next=%2F%2Fevil.example' });

    fillLogin('worker-1', 'Dummy-Passw0rd-1');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

    expect(await screen.findByRole('heading', { name: 'ダッシュボード' })).toBeDefined();
    expect(window.location.pathname).toBe('/');
    expect(safeNextPath('/a/b')).toBe('/a/b');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
  });

  it.each([
    [
      '認証の失敗',
      () => errorResponse(401, 'UNAUTHENTICATED', '内部の詳細'),
      'ユーザーIDまたはパスワードが正しくありません',
    ],
    [
      '試行回数の制限',
      () => errorResponse(429, 'RATE_LIMITED', 'ログインの試行回数が上限を超えました'),
      'ログインの試行回数が上限を超えました',
    ],
  ])('%s: 利用者向けのメッセージを表示し、再度入力できる', async (_name, login, message) => {
    renderApp({ session: null, path: '/login', scenario: { login } });

    fillLogin('worker-1', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'ログイン' }).disabled).toBe(
      false,
    );
  });

  it('通信できない場合は、通信エラーのメッセージを表示する', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('failed'));
    window.history.pushState(null, '', '/login');
    render(<App session={createMemorySession(null)} fetchFn={fetchFn} />);

    fillLogin('worker-1', 'pw');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

    expect((await screen.findByRole('alert')).textContent).toContain('接続できませんでした');
  });

  it('想定外のエラーは、内部情報を含まない汎用のメッセージを表示する', async () => {
    window.history.pushState(null, '', '/login');
    const session = createMemorySession(null);
    session.set = () => {
      throw new Error('internal secret detail');
    };
    render(<App session={session} fetchFn={createFakeFetch(handlerOf()).fetchFn} />);

    fillLogin('worker-1', 'pw');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('エラーが発生しました');
    expect(alert.textContent).not.toContain('secret');
  });

  it('ログイン済みで /login を開くと、ダッシュボードへ移動する', async () => {
    renderApp({ path: '/login' });

    expect(await screen.findByRole('heading', { name: 'ダッシュボード' })).toBeDefined();
    expect(window.location.pathname).toBe('/');
  });

  it('ログアウトすると、セッションを破棄し、ログイン画面へ戻る。サーバーへ届かなくても破棄する', async () => {
    const handler: FakeHandler = (request) =>
      request.path === '/auth/logout'
        ? errorResponse(500, 'INTERNAL_ERROR', '失敗')
        : handlerOf()(request);
    const { session, calls } = renderApp({ handler });
    await screen.findByText('農作業者A');

    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));

    expect(await screen.findByRole('heading', { name: 'ログイン', level: 2 })).toBeDefined();
    expect(session.current).toBeNull();
    expect(calls.some((call) => call.path === '/auth/logout')).toBe(true);
  });

  it('セッションを更新できず期限切れになったら、ログイン画面へ戻る', async () => {
    const handler: FakeHandler = (request) =>
      request.path === '/dashboard' || request.path === '/auth/refresh'
        ? errorResponse(401, 'UNAUTHENTICATED', '期限切れ')
        : handlerOf()(request);
    const { session } = renderApp({ handler });

    expect(await screen.findByRole('heading', { name: 'ログイン', level: 2 })).toBeDefined();
    expect(session.current).toBeNull();
  });
});

describe('共通のヘッダー・ナビゲーション', () => {
  it('設備の選択・未読の件数・最終のデータ取得日時・メニュー・ユーザー名を表示する', async () => {
    renderApp();

    expect(await screen.findByText('農作業者A')).toBeDefined();
    const select = await screen.findByLabelText<HTMLSelectElement>('対象の設備');
    await waitFor(() => {
      expect(select.options).toHaveLength(3);
    });
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'ハウス1',
      '　収穫ロボット1',
      '　環境センサー1',
    ]);
    expect(select.value).toBe('HOUSE-01');
    expect((await screen.findByTestId('unread-count')).textContent).toBe('2');
    expect(screen.getByRole('link', { name: /未読の通知: 2件/ }).getAttribute('href')).toBe(
      '/notifications',
    );
    expect(await screen.findByText('2026/10/09 11:55:00')).toBeDefined();
    const menu = screen.getByRole('navigation', { name: 'メニュー' });
    expect(
      within(menu)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'ダッシュボード',
      'データ入力',
      '通知',
      '取り込み済みデータ',
      '設備',
      '取り込み',
      'ステータスコード',
      'ユーザー',
      '通知の設定',
    ]);
    expect(
      within(menu).getByRole('link', { name: 'ダッシュボード' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.getByRole('link', { name: '本文へ移動' }).getAttribute('href')).toBe('#main');
  });

  it('権限のないロールには、ユーザー管理のメニューを表示しない（サーバー側でも拒否する）', async () => {
    renderApp({ session: VIEWER_LOGIN });

    await screen.findByText('閲覧者B');

    expect(screen.queryByRole('link', { name: 'ユーザー' })).toBeNull();
    expect(screen.getByRole('link', { name: '通知' })).toBeDefined();
  });

  it('メニューから、画面（通知）へ移動でき、現在の画面を示す', async () => {
    const base = handlerOf();
    renderApp({
      handler: (request) =>
        request.path === '/notifications'
          ? jsonResponse({ items: [], nextCursor: null })
          : base(request),
    });
    await screen.findByText('農作業者A');

    fireEvent.click(screen.getByRole('link', { name: '通知' }));

    expect(await screen.findByRole('heading', { name: '通知' })).toBeDefined();
    expect(await screen.findByText('通知はありません')).toBeDefined();
    expect(
      screen.getByRole('navigation', { name: 'メニュー' }).querySelector('[aria-current="page"]')
        ?.textContent,
    ).toBe('通知');
  });

  it('存在しないパスは、見つからない旨を表示し、ダッシュボードへ戻れる', async () => {
    renderApp({ path: '/no/such/page' });

    expect(await screen.findByRole('heading', { name: 'ページが見つかりません' })).toBeDefined();
    fireEvent.click(screen.getByRole('link', { name: 'ダッシュボードへ戻る' }));
    expect(await screen.findByRole('heading', { name: 'ダッシュボード' })).toBeDefined();
  });

  it('観点の詳細などのパラメータつきのパスも、画面に対応づける', async () => {
    // 観点（safety）をパスから受け取り、判断基準の編集（SC-13）の画面に対応づける
    const base = handlerOf();
    renderApp({
      path: '/viewpoints/safety/criteria',
      handler: (request) =>
        request.path === '/viewpoints/safety/criteria'
          ? jsonResponse({
              viewpointId: 'safety',
              criteria: [],
              version: 'DEFAULT',
              isDefault: true,
              usesStatusIndicator: false,
            })
          : base(request),
    });

    expect(await screen.findByRole('heading', { name: /判断基準の編集/ })).toBeDefined();
    expect(
      (await screen.findAllByRole('link', { name: '安全性' })).some(
        (link) => link.getAttribute('href') === '/viewpoints/safety',
      ),
    ).toBe(true);
  });

  it('設備を選ぶと、その設備のダッシュボードを取得し直す', async () => {
    const { calls } = renderApp();
    const select = await screen.findByLabelText<HTMLSelectElement>('対象の設備');
    await waitFor(() => {
      expect(select.options).toHaveLength(3);
    });

    fireEvent.change(select, { target: { value: 'ROBOT-01' } });

    await waitFor(() => {
      expect(dashboardCalls(calls).at(-1)?.query.get('equipmentId')).toBe('ROBOT-01');
    });
    expect(select.value).toBe('ROBOT-01');
  });

  it('設備が1つもなければ、選択を無効にする', async () => {
    renderApp({ scenario: { equipment: () => jsonResponse({ facilities: [] }) } });

    const select = await screen.findByLabelText<HTMLSelectElement>('対象の設備');

    await waitFor(() => {
      expect(select.disabled).toBe(true);
    });
  });
});

describe('ダッシュボード（UC-01。SC-02）', () => {
  it('ステータスごとの件数と、観点のカード（ステータス・メトリクス・診断メッセージ・推奨アクション）を表示する', async () => {
    renderApp();

    expect(await screen.findByRole('heading', { name: '安全性' })).toBeDefined();
    expect(screen.getByTestId('summary-NORMAL').textContent).toContain('1');
    expect(screen.getByTestId('summary-CAUTION').textContent).toContain('1');
    expect(screen.getByTestId('summary-ERROR').textContent).toContain('0');
    expect(screen.getByTestId('summary-UNKNOWN').textContent).toContain('1');
    const speed = screen.getByRole('heading', { name: '収穫速度' }).closest('li');
    if (speed === null) {
      throw new Error('テストの前提: カードがある');
    }
    expect(within(speed).getByText('注意')).toBeDefined();
    expect(within(speed).getByText('72.0秒/果実')).toBeDefined();
    expect(within(speed).getByText('2.0%')).toBeDefined();
    // ステータスコードは、カテゴリ名ではなく名称で表示する
    expect(within(speed).getByText('収穫中')).toBeDefined();
    expect(within(speed).getByText('カスタムの判断基準')).toBeDefined();
    expect(within(speed).getByText(/推奨アクション:/)).toBeDefined();
    const safety = screen.getByRole('heading', { name: '安全性' }).closest('li');
    if (safety === null) {
      throw new Error('テストの前提: カードがある');
    }
    // 欠損は「—」で表示する（0 にしない）
    expect(within(safety).getByText('—')).toBeDefined();
    expect(
      within(safety).getByText(/2026\/10\/02 12:00:00 〜 2026\/10\/09 12:00:00/),
    ).toBeDefined();
    expect(within(safety).queryByText('カスタムの判断基準')).toBeNull();
    // 詳細へは、選んだ視点・期間を引き継ぐ
    expect(screen.getByRole('link', { name: '安全性' }).getAttribute('href')).toBe(
      '/viewpoints/safety?horizon=LONG&periodDays=7',
    );
  });

  it('評価がまだの観点は、判定の対象期間を表示しない。ステータスは色・アイコン・文字で示す', async () => {
    renderApp();
    const satisfaction = (await screen.findByRole('heading', { name: '満足度' })).closest('li');
    if (satisfaction === null) {
      throw new Error('テストの前提: カードがある');
    }

    expect(within(satisfaction).queryByText(/判定の対象期間/)).toBeNull();
    const badge = within(satisfaction).getByText('不明').closest('.status-badge');
    expect(badge?.className).toContain('status-unknown');
    expect(badge?.querySelector('[data-icon="status-unknown"]')).not.toBeNull();
  });

  it('視点（短期・長期）と長期の期間を切り替えると、その条件で取得し直す', async () => {
    const { calls } = renderApp();
    await screen.findByRole('heading', { name: '安全性' });
    expect(dashboardCalls(calls)[0]?.query.get('horizon')).toBe('LONG');
    expect(dashboardCalls(calls)[0]?.query.get('periodDays')).toBe('7');

    fireEvent.click(screen.getByRole('radio', { name: '短期' }));
    await waitFor(() => {
      expect(dashboardCalls(calls).at(-1)?.query.get('horizon')).toBe('SHORT');
    });
    fireEvent.click(screen.getByRole('radio', { name: '長期' }));
    fireEvent.change(screen.getByLabelText('長期の期間'), { target: { value: '30' } });

    await waitFor(() => {
      expect(dashboardCalls(calls).at(-1)?.query.get('periodDays')).toBe('30');
    });
    expect(dashboardCalls(calls).at(-1)?.query.get('horizon')).toBe('LONG');
    expect(
      [...screen.getByLabelText<HTMLSelectElement>('長期の期間').options].map(
        (option) => option.textContent,
      ),
    ).toEqual(['当日', '直近7日', '直近30日', '直近60日', '直近90日']);
  });

  it('データが古い場合は、警告を表示し、ヘッダーにも「古い」と示す', async () => {
    renderApp({
      scenario: { dashboard: () => jsonResponse(dashboard({ dataFreshness: 'STALE' })) },
    });

    expect((await screen.findByRole('alert')).textContent).toContain('データが古くなっています');
    expect(await screen.findByText('（古い）')).toBeDefined();
  });

  it('データが未取得の場合は、その旨と次の操作を示し、ヘッダーは「未取得」と示す', async () => {
    renderApp({
      scenario: {
        dashboard: () =>
          jsonResponse(
            dashboard({
              dataFreshness: 'NONE',
              lastReceivedAt: null,
              viewpoints: [card({ status: 'UNKNOWN', statuses: { short: null, long: 'UNKNOWN' } })],
            }),
          ),
      },
    });

    expect(await screen.findByText(/データがまだ取り込まれていません/)).toBeDefined();
    expect(await screen.findByText('未取得')).toBeDefined();
  });

  it('設備が登録されていなければ、その旨と設備管理への導線を表示する', async () => {
    renderApp({ scenario: { equipment: () => jsonResponse({ facilities: [] }) } });

    expect(
      await screen.findByText('設備が登録されていません。設備を登録してください'),
    ).toBeDefined();
    expect(screen.getAllByRole('link', { name: '設備' }).at(-1)?.getAttribute('href')).toBe(
      '/settings/equipment',
    );
  });

  it('設備の読み込みに失敗したら、エラーを表示する', async () => {
    renderApp({
      scenario: {
        equipment: () => errorResponse(500, 'INTERNAL_ERROR', 'サーバーでエラーが発生しました'),
      },
    });

    expect((await screen.findByRole('alert')).textContent).toContain(
      'サーバーでエラーが発生しました',
    );
  });

  it('ダッシュボードの取得に失敗したらエラーを表示し、再読み込みで取得し直せる', async () => {
    let fail = true;
    const { calls } = renderApp({
      scenario: {
        dashboard: () =>
          fail
            ? errorResponse(503, 'SERVICE_UNAVAILABLE', '一時的に利用できません')
            : jsonResponse(dashboard()),
      },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('一時的に利用できません');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));

    expect(await screen.findByRole('heading', { name: '安全性' })).toBeDefined();
    expect(dashboardCalls(calls).length).toBeGreaterThanOrEqual(2);
  });

  it('Error 以外の失敗も、汎用のメッセージで表示する', async () => {
    const handler: FakeHandler = (request) =>
      request.path === '/dashboard' ? jsonResponse({ unexpected: true }) : handlerOf()(request);
    renderApp({ handler });

    expect((await screen.findByRole('alert')).textContent).toContain('エラーが発生しました');
  });

  it('読み込み中は、その旨を表示する', async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const handler: FakeHandler = (request) =>
      request.path === '/dashboard' ? pending : handlerOf()(request);
    renderApp({ handler });

    expect((await screen.findByRole('status')).textContent).toBe('読み込み中…');
    release(jsonResponse(dashboard()));
    expect(await screen.findByRole('heading', { name: '安全性' })).toBeDefined();
  });
});
