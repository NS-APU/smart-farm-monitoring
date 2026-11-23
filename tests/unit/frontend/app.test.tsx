import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResponse } from '@smart-farm/shared/schemas/auth';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import { App } from '../../../src/frontend/app.tsx';
import {
  loginRedirectPath,
  parseLoginReason,
  safeNextPath,
} from '../../../src/frontend/pages/login-page.tsx';
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
  pinClockToDashboardFixture,
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

// 評価が更新されていない警告（Issue #158）が、フィクスチャの最終の評価に対して、実際の現在の時刻で出ないようにする
pinClockToDashboardFixture();

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

    // ログアウトは、ヘッダーのユーザーメニューの中（Issue #353）
    fireEvent.click(screen.getByRole('button', { name: /^ログイン中のユーザー/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'ログアウト' }));

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

describe('ログイン後の戻り先（Issue #460。SC-01）', () => {
  const origin = window.location.origin;
  // バックスラッシュ（1 文字）
  const BACKSLASH = String.fromCharCode(92);

  it.each<[string, string | null, string]>([
    ['正常: 通知', '/notifications', '/notifications'],
    ['正常: クエリ・ハッシュつき', '/notifications?x=1#a', '/notifications?x=1#a'],
    [
      '正常: 観点の詳細（期間・ハッシュつき）',
      '/viewpoints/safety?period=7d#chart',
      '/viewpoints/safety?period=7d#chart',
    ],
    ['正常: ダッシュボード', '/', '/'],
    // パーセント符号は、デコードしない（パスの文字そのもの。別のオリジンには、ならない）
    ['パーセント符号のバックスラッシュは、パスの文字として扱う', '/%5Cx', '/%5Cx'],
    ['バックスラッシュ 1 つ', `/${BACKSLASH}example.invalid`, '/'],
    ['バックスラッシュ 2 つ', `/${BACKSLASH}${BACKSLASH}example.invalid`, '/'],
    ['タブを挟む', '/\t/example.invalid', '/'],
    ['改行を挟む', '/\n/example.invalid', '/'],
    ['バックスラッシュとタブ', `/${BACKSLASH}\t/example.invalid`, '/'],
    ['プロトコル相対（//x）', '//example.invalid', '/'],
    ['URL として解釈できない（//[）', '//[', '/'],
    ['別のサイト（https://）', 'https://example.invalid/', '/'],
    ['同じ origin の絶対 URL でも、スキームつきは許さない', `${origin}/notifications`, '/'],
    ['javascript:', 'javascript:alert(1)', '/'],
    ['data:', 'data:text/html,x', '/'],
    ['スキームなしの相対パス', 'evil', '/'],
    ['先頭が空白', ' /notifications', '/'],
    ['ログイン画面（/login）', '/login', '/'],
    ['ログイン画面（クエリつき）', '/login?next=/a', '/'],
    ['ログイン画面（末尾のスラッシュ）', '/login/', '/'],
    ['ログイン画面の下', '/login/x', '/'],
    ['ログイン画面（. を含む）', '/a/../login', '/'],
    ['ログイン画面（ハッシュつき）', '/login#a', '/'],
    ['空', '', '/'],
    ['null', null, '/'],
  ])('safeNextPath: %s', (_name, next, expected) => {
    expect(safeNextPath(next)).toBe(expected);
  });

  it('ログインに成功したら、戻り先へ、1 回だけ移動する（ダッシュボードへの移動と競合しない）', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    try {
      const { session } = renderApp({
        session: null,
        path: '/login?next=%2Fnotifications%3Fx%3D1%23a',
      });
      replaceState.mockClear();

      fillLogin('worker-1', 'Dummy-Passw0rd-1');
      fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

      expect(await screen.findByText('農作業者A')).toBeDefined();
      expect(session.current?.accessToken).toBe('access-token-1');
      expect(window.location.pathname).toBe('/notifications');
      expect(window.location.search).toBe('?x=1');
      expect(window.location.hash).toBe('#a');
      expect(replaceState).toHaveBeenCalledTimes(1);
    } finally {
      replaceState.mockRestore();
    }
  });

  it('戻り先がバックスラッシュを含むときは、ダッシュボードへ、1 回だけ移動する（エラーを表示しない）', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    try {
      renderApp({ session: null, path: '/login?next=%2F%5Cexample.invalid' });
      replaceState.mockClear();

      fillLogin('worker-1', 'Dummy-Passw0rd-1');
      fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

      expect(await screen.findByRole('heading', { name: 'ダッシュボード' })).toBeDefined();
      expect(window.location.pathname).toBe('/');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(replaceState).toHaveBeenCalledTimes(1);
    } finally {
      replaceState.mockRestore();
    }
  });

  it('ログイン済みでログイン画面を開くと、戻り先へ、1 回だけ移動する', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    try {
      renderApp({ session: WORKER_LOGIN, path: '/login?next=%2Fnotifications' });

      await waitFor(() => {
        expect(window.location.pathname).toBe('/notifications');
      });
      expect(replaceState).toHaveBeenCalledTimes(1);
    } finally {
      replaceState.mockRestore();
    }
  });

  it('ログイン済みでログイン画面を開き、戻り先がなければ、ダッシュボードへ移動する', async () => {
    renderApp({ session: WORKER_LOGIN, path: '/login' });

    expect(await screen.findByRole('heading', { name: 'ダッシュボード' })).toBeDefined();
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
  });

  it('ログイン済みでログイン画面を開き、戻り先が安全でなければ、ダッシュボードへ移動する', async () => {
    renderApp({ session: WORKER_LOGIN, path: '/login?next=%2F%5Cexample.invalid' });

    expect(await screen.findByRole('heading', { name: 'ダッシュボード' })).toBeDefined();
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ログイン画面の文言（Issue #157。SC-01-1・01-2・01-5）', () => {
  const EXPIRED = 'セッションの有効期限が切れました。もう一度ログインしてください';
  const FORGOT = 'パスワードを忘れたときは、管理者に連絡してください';
  const PURPOSE = 'ロボットとハウスの状態をデータで見える化し、早めの対応を支えるシステムです';

  /** ログイン中に、セッションを更新できなくなる（アクセストークンも、リフレッシュトークンも、期限切れ）。 */
  const expiredHandler: FakeHandler = (request) =>
    request.path === '/dashboard' || request.path === '/auth/refresh'
      ? errorResponse(401, 'UNAUTHENTICATED', '期限切れ')
      : handlerOf()(request);

  it('セッションが切れてログイン画面へ戻されたときは、期限切れの理由を示し、元の画面を戻り先に保つ（SC-01-1）', async () => {
    renderApp({ handler: expiredHandler });

    const notice = await screen.findByText(EXPIRED);

    expect(notice.getAttribute('role')).toBe('status');
    expect(window.location.pathname).toBe('/login');
    const query = new URLSearchParams(window.location.search);
    expect(query.get('next')).toBe('/');
    expect(query.get('reason')).toBe('expired');
  });

  it('期限切れで戻されたあと、ログインすると、元の画面へ戻り、理由の表示は消える。ログアウトでは、理由を示さない（SC-01-1）', async () => {
    const state = { sessionBroken: true };
    const handler: FakeHandler = (request) =>
      state.sessionBroken && (request.path === '/dashboard' || request.path === '/auth/refresh')
        ? errorResponse(401, 'UNAUTHENTICATED', '期限切れ')
        : handlerOf()(request);
    renderApp({ handler });
    await screen.findByText(EXPIRED);
    state.sessionBroken = false;

    fillLogin('worker-1', 'Dummy-Passw0rd-1');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));
    await screen.findByText('農作業者A');
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /^ログイン中のユーザー/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'ログアウト' }));

    expect(await screen.findByRole('heading', { name: 'ログイン', level: 2 })).toBeDefined();
    expect(screen.queryByText(EXPIRED)).toBeNull();
    expect(new URLSearchParams(window.location.search).has('reason')).toBe(false);
  });

  it('最初の訪問（未認証で、保護された画面を開く）では、期限切れの理由を示さない（SC-01-1）', async () => {
    renderApp({ session: null, path: '/notifications' });

    await screen.findByRole('heading', { name: 'ログイン', level: 2 });

    expect(screen.queryByText(EXPIRED)).toBeNull();
    expect(new URLSearchParams(window.location.search).has('reason')).toBe(false);
  });

  it('ログイン画面を直接開いたときも、期限切れの理由を示さない（SC-01-1）', async () => {
    renderApp({ session: null, path: '/login' });

    await screen.findByRole('heading', { name: 'ログイン', level: 2 });

    expect(screen.queryByText(EXPIRED)).toBeNull();
  });

  it.each([
    ['許可しない値', 'foo'],
    ['空', ''],
    ['大文字小文字違い', 'EXPIRED'],
    ['値の前後に空白', ' expired'],
  ])(
    '理由の印が、%s のときは、無視する（期限切れの理由を示さない）（SC-01-1）',
    async (_name, reason) => {
      renderApp({ session: null, path: `/login?reason=${encodeURIComponent(reason)}` });

      await screen.findByRole('heading', { name: 'ログイン', level: 2 });

      expect(screen.queryByText(EXPIRED)).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    },
  );

  it('理由の印 expired があるログイン画面は、期限切れの理由を示す（SC-01-1）', async () => {
    renderApp({ session: null, path: '/login?next=%2Fnotifications&reason=expired' });

    expect(await screen.findByText(EXPIRED)).toBeDefined();
  });

  it('parseLoginReason: 許可リスト（expired）にある値だけを返す。それ以外は undefined（SC-01-1）', () => {
    expect(parseLoginReason('expired')).toBe('expired');
    expect(parseLoginReason('Expired')).toBeUndefined();
    expect(parseLoginReason('expired ')).toBeUndefined();
    expect(parseLoginReason('constructor')).toBeUndefined();
    expect(parseLoginReason('__proto__')).toBeUndefined();
    expect(parseLoginReason('')).toBeUndefined();
    expect(parseLoginReason(null)).toBeUndefined();
  });

  it('loginRedirectPath: 戻り先（next）を保ち、理由があれば、reason を足す（SC-01-1）', () => {
    expect(loginRedirectPath('/notifications', new URLSearchParams('kind=A'))).toBe(
      '/login?next=%2Fnotifications%3Fkind%3DA',
    );
    expect(loginRedirectPath('/notifications', new URLSearchParams('kind=A'), 'expired')).toBe(
      '/login?next=%2Fnotifications%3Fkind%3DA&reason=expired',
    );
    expect(loginRedirectPath('/', new URLSearchParams(), 'expired')).toBe(
      '/login?next=%2F&reason=expired',
    );
  });

  it('パスワードを忘れたときは、管理者に連絡する旨を示す。連絡先の名前・メールアドレス・電話番号は書かない（SC-01-2）', async () => {
    renderApp({ session: null, path: '/login' });

    const guide = await screen.findByText(FORGOT);

    expect(guide.closest('form')).not.toBeNull();
    expect(screen.queryByRole('link', { name: /再設定|忘れ/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/@|\d{2,4}-\d{2,4}-\d{3,4}/);
  });

  it('システムの目的を、1 行で示す（SC-01-5）。ログイン画面の見出し（アプリ名）の近くに置く', async () => {
    renderApp({ session: null, path: '/login' });

    const purpose = await screen.findByText(PURPOSE);

    expect(purpose.closest('.login-brand')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Greenhouse Monitor', level: 1 })).toBeDefined();
  });
});

describe('共通のヘッダー・ナビゲーション', () => {
  it('ヘッダーは、未読の件数・メニュー・ユーザー名を表示する。対象のハウス・最終のデータ取得日時は、ダッシュボードの中に表示する（Issue #355）', async () => {
    renderApp();

    expect(await screen.findByText('農作業者A')).toBeDefined();
    // 対象は、ダッシュボードの中の「対象のハウス」（ハウスだけ。ロボット・センサーは、選択肢にない）
    const select = await screen.findByLabelText<HTMLSelectElement>('対象のハウス');
    await waitFor(() => {
      expect(select.options).toHaveLength(1);
    });
    expect([...select.options].map((option) => option.textContent)).toEqual(['ハウス1']);
    expect(select.value).toBe('HOUSE-01');
    expect(within(screen.getByRole('banner')).queryByLabelText('対象の設備')).toBeNull();
    expect(within(screen.getByRole('banner')).queryByText(/最終のデータ取得/)).toBeNull();
    expect(screen.getByText(/最終のデータ取得:/)).toBeDefined();
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
      '計測データ',
      'ハウス・設備',
      '取り込み',
      'ステータスコード',
      'ユーザー',
    ]);
    expect(
      within(menu).getByRole('link', { name: 'ダッシュボード' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.getByRole('link', { name: '本文へ移動' }).getAttribute('href')).toBe('#main');
  });

  it('権限のないロールには、メニューの「ユーザー」を表示しない（サーバー側でも拒否する）', async () => {
    renderApp({ session: VIEWER_LOGIN });

    await screen.findByText('閲覧者B');

    expect(screen.queryByRole('link', { name: 'ユーザー' })).toBeNull();
    // 通知は、メニューでなく、ヘッダーのアイコンから開く（Issue #351）
    expect(screen.getByRole('link', { name: /^未読の通知/ })).toBeDefined();
  });

  it('ヘッダーの通知のアイコンから、画面（通知）へ移動でき、現在の画面を示す（メニューは、現在の項目なし）', async () => {
    const base = handlerOf();
    renderApp({
      handler: (request) =>
        request.path === '/notifications'
          ? jsonResponse({ items: [], nextCursor: null, asOf: '2026-10-09T01:00:00.000Z' })
          : base(request),
    });
    await screen.findByText('農作業者A');

    const link = screen.getByRole('link', { name: /^未読の通知/ });
    fireEvent.click(link);

    expect(await screen.findByRole('heading', { name: '通知' })).toBeDefined();
    expect(await screen.findByText('通知はありません')).toBeDefined();
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(
      screen.getByRole('navigation', { name: 'メニュー' }).querySelector('[aria-current="page"]'),
    ).toBeNull();
  });

  it('存在しないパスは、見つからない旨を表示し、ダッシュボードへ戻れる', async () => {
    renderApp({ path: '/no/such/page' });

    expect(await screen.findByRole('heading', { name: 'ページが見つかりません' })).toBeDefined();
    fireEvent.click(screen.getByRole('link', { name: 'ダッシュボードへ戻る' }));
    expect(await screen.findByRole('heading', { name: 'ダッシュボード' })).toBeDefined();
  });

  it('存在しないパスの画面は、イラスト（装飾）と、原因と次の操作の案内を示す', async () => {
    renderApp({ path: '/no/such/page' });

    const heading = await screen.findByRole('heading', { name: 'ページが見つかりません' });
    const page = heading.closest('.not-found-page');
    expect(page?.querySelector('svg.illustration')?.getAttribute('aria-hidden')).toBe('true');
    expect(page?.textContent).toContain('URL が違っているか、ページが移動した可能性があります。');
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
  it('設備が1つもなければ、ダッシュボードは、対象のハウスの選択でなく、設備の登録の案内を示す', async () => {
    renderApp({ scenario: { equipment: () => jsonResponse({ facilities: [] }) } });

    expect(
      await screen.findByText('設備が登録されていません。設備を登録してください'),
    ).toBeDefined();
    expect(screen.queryByLabelText('対象のハウス')).toBeNull();
    expect(screen.queryByLabelText('対象の設備')).toBeNull();
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
    // 判定の対象期間は、全観点で同じなので、上部に 1 回だけ示し、カードには示さない（Issue #355）
    expect(screen.getByTestId('evaluated-period-common').textContent).toContain(
      '2026/10/02 12:00:00 〜 2026/10/09 12:00:00',
    );
    expect(within(safety).queryByText(/判定の対象期間/)).toBeNull();
    expect(within(safety).queryByText('カスタムの判断基準')).toBeNull();
    // 詳細は、ドロワーで開く（カードの題名と、観点別の状態の表の、どちらからも。期間を選んでいないので、期間は付けない）
    expect(
      screen.getAllByRole('link', { name: '安全性' }).map((link) => link.getAttribute('href')),
    ).toEqual(['/?viewpoint=safety', '/?viewpoint=safety']);
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

  it('期間を切り替えると、その期間で取得し直す（視点の切り替えはない。常に長期）', async () => {
    const { calls } = renderApp();
    await screen.findByRole('heading', { name: '安全性' });
    expect(dashboardCalls(calls)[0]?.query.get('horizon')).toBe('LONG');
    // 期間を選ぶまでは、期間を送らない（観点ごとの既定の期間で評価した結果を返す。満足度は 30 日。D-18）
    expect(dashboardCalls(calls)[0]?.query.has('periodDays')).toBe(false);
    expect(screen.queryByRole('radio', { name: '短期' })).toBeNull();

    fireEvent.change(screen.getByLabelText('期間'), { target: { value: '30' } });

    await waitFor(() => {
      expect(dashboardCalls(calls).at(-1)?.query.get('periodDays')).toBe('30');
    });
    expect(dashboardCalls(calls).at(-1)?.query.get('horizon')).toBe('LONG');
    expect(
      [...screen.getByLabelText<HTMLSelectElement>('期間').options].map(
        (option) => option.textContent,
      ),
    ).toEqual(['当日', '直近7日', '直近30日', '直近60日', '直近90日']);
  });

  it('データが古い場合は、警告を表示し、取得日時の欄にも「古い」と示す', async () => {
    renderApp({
      scenario: { dashboard: () => jsonResponse(dashboard({ dataFreshness: 'STALE' })) },
    });

    expect((await screen.findByRole('alert')).textContent).toContain('データが古くなっています');
    expect(await screen.findByText('（古い）')).toBeDefined();
  });

  it('古い設備があれば、警告に、その設備の名前を示す（最大 3 つ。それ以上は「ほか N 件」。どの設備かの設計は #158）', async () => {
    const stale = (index: number) => ({
      equipmentId: toEquipmentId(`ROBOT-${String(index)}`),
      name: `ロボット${String(index)}`,
      lastReceivedAt: '2026-10-09T02:00:00.000Z',
      thresholdMinutes: 3,
    });
    const view = renderApp({
      scenario: {
        dashboard: () =>
          jsonResponse(dashboard({ dataFreshness: 'STALE', staleEquipment: [stale(1), stale(2)] })),
      },
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('データが古くなっています');
    expect(alert.textContent).toContain('ロボット1');
    expect(alert.textContent).toContain('ロボット2');
    expect(alert.textContent).not.toContain('ほか');
    view.unmount();

    renderApp({
      scenario: {
        dashboard: () =>
          jsonResponse(
            dashboard({
              dataFreshness: 'STALE',
              staleEquipment: [stale(1), stale(2), stale(3), stale(4), stale(5)],
            }),
          ),
      },
    });
    const many = await screen.findByRole('alert');
    expect(many.textContent).toContain('ロボット3');
    expect(many.textContent).not.toContain('ロボット4');
    expect(many.textContent).toContain('ほか 2 件');
  });

  it('データが未取得の場合は、その旨と次の操作を示し、取得日時の欄は「未取得」と示す', async () => {
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

  it('手動のみの運用（自動取り込みが有効でない）は、「古い」「未取得」の警告を出さず、取得日時の欄に「最終の手動入力」の日時を示し、案内とデータ入力への導線を表示する（Issue #202）', async () => {
    renderApp({
      scenario: {
        dashboard: () =>
          jsonResponse(
            dashboard({
              dataFreshness: 'MANUAL',
              lastReceivedAt: null,
              lastManualInputAt: '2026-10-09T02:30:00.000Z',
            }),
          ),
      },
    });

    expect(await screen.findByText(/自動取り込みが有効でない/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/データがまだ取り込まれていません/)).toBeNull();
    expect(screen.queryByText('（古い）')).toBeNull();
    expect(screen.queryByText('未取得')).toBeNull();
    const header = await screen.findByText(/^最終の手動入力:/);
    expect(header.closest('.data-status')?.textContent).toContain('2026/10/09 11:30:00');
    expect(screen.queryByText(/^最終のデータ取得:/)).toBeNull();
    const links = screen.getAllByRole('link', { name: 'データ入力へ' });
    expect(links.at(-1)?.getAttribute('href')).toBe('/data-entry');
  });

  it('手動のみの運用で、手動入力がまだなければ、取得日時の欄は「最終の手動入力: まだありません」', async () => {
    renderApp({
      scenario: {
        dashboard: () =>
          jsonResponse(
            dashboard({ dataFreshness: 'MANUAL', lastReceivedAt: null, lastManualInputAt: null }),
          ),
      },
    });

    const header = await screen.findByText(/^最終の手動入力:/);
    expect(header.closest('.data-status')?.textContent).toContain('まだありません');
  });

  it('設備が登録されていなければ、その旨と設備管理への導線を表示する', async () => {
    renderApp({ scenario: { equipment: () => jsonResponse({ facilities: [] }) } });

    expect(
      await screen.findByText('設備が登録されていません。設備を登録してください'),
    ).toBeDefined();
    expect(screen.getAllByRole('link', { name: 'ハウス・設備' }).at(-1)?.getAttribute('href')).toBe(
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

describe('ログイン: パスワード欄・初期フォーカス（Issue #157。SC-01-4）', () => {
  it('開いたとき、ユーザーIDの欄にフォーカスがある', async () => {
    renderApp({ session: null, path: '/login' });

    const userId = await screen.findByLabelText('ユーザーID');

    expect(document.activeElement).toBe(userId);
  });

  it('パスワードは、既定で非表示（type=password）。表示切替で、表示（type=text）に切り替わり、ログインの送信に影響しない', async () => {
    const { calls } = renderApp({ session: null, path: '/login' });
    const password = await screen.findByLabelText<HTMLInputElement>('パスワード');
    const toggle = screen.getByRole('button', { name: '入力した文字を表示' });
    expect(password.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);

    expect(password.type).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // 切替は、フォームを送信しない（検証のエラーも出さない）
    expect(calls).toHaveLength(0);
    expect(screen.queryByText('パスワードを入力してください')).toBeNull();
  });

  it('パスワードの欄で、Caps Lock がオンのキー入力をすると、注意を示す', async () => {
    renderApp({ session: null, path: '/login' });
    const password = await screen.findByLabelText('パスワード');

    fireEvent.keyDown(password, { key: 'A', modifierCapsLock: true });

    expect(screen.getByTestId('caps-lock-notice').textContent).toContain('Caps Lock');
  });

  it('ユーザーIDの欄には、表示切替・Caps Lock の注意を付けない（パスワード欄だけ）', async () => {
    renderApp({ session: null, path: '/login' });
    await screen.findByLabelText('ユーザーID');

    expect(screen.getAllByRole('button', { name: '入力した文字を表示' })).toHaveLength(1);
    expect(screen.getAllByTestId('caps-lock-notice')).toHaveLength(1);
  });
});
