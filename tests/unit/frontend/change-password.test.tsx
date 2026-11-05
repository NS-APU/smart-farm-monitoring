import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LoginResponse } from '@smart-farm/shared/schemas/auth';
import { App } from '../../../src/frontend/app.tsx';
import { errorBody, withBaseRoutes } from '../../support/management-frontend.ts';
import {
  WORKER_LOGIN,
  createFakeFetch,
  createMemorySession,
  dashboard,
  equipmentTree,
  errorResponse,
  jsonResponse,
  type FakeHandler,
  type FakeRequest,
} from '../../support/frontend.ts';

/** 管理者が決めたパスワードで、最初にログインした利用者（変更が必要）。 */
const FORCED_LOGIN: LoginResponse = {
  ...WORKER_LOGIN,
  user: { ...WORKER_LOGIN.user, mustChangePassword: true },
};
/** 変更後の、新しいセッション。 */
const CHANGED_LOGIN: LoginResponse = {
  ...WORKER_LOGIN,
  accessToken: 'access-token-2',
  refreshToken: 'refresh-token-2',
  user: { ...WORKER_LOGIN.user, mustChangePassword: false },
};

interface Scenario {
  readonly login?: (request: FakeRequest) => Response;
  readonly password?: (request: FakeRequest) => Response;
}

function handlerOf(scenario: Scenario = {}): FakeHandler {
  const baseRoutes = withBaseRoutes({
    'GET /equipment': () => jsonResponse(equipmentTree()),
    'GET /dashboard': () => jsonResponse(dashboard()),
    'GET /notifications/unread-count': () => jsonResponse({ unreadCount: 0 }),
  });
  return (request) => {
    switch (`${request.method} ${request.path}`) {
      case 'POST /auth/login':
        return (scenario.login ?? (() => jsonResponse(FORCED_LOGIN)))(request);
      case 'POST /auth/password':
        return (scenario.password ?? (() => jsonResponse(CHANGED_LOGIN)))(request);
      case 'POST /auth/logout':
        return new Response(null, { status: 204 });
      default:
        return baseRoutes(request);
    }
  };
}

function renderApp(
  options: { path?: string; session?: LoginResponse | null; scenario?: Scenario } = {},
) {
  window.history.pushState(null, '', options.path ?? '/');
  const session = createMemorySession(
    options.session === undefined ? FORCED_LOGIN : options.session,
  );
  const fake = createFakeFetch(handlerOf(options.scenario));
  const view = render(<App session={session} fetchFn={fake.fetchFn} />);
  return { ...fake, session, ...view };
}

function fillForm(current: string, next: string, confirm: string = next) {
  fireEvent.change(screen.getByLabelText('現在のパスワード'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('新しいパスワード', { exact: true }), {
    target: { value: next },
  });
  fireEvent.change(screen.getByLabelText('新しいパスワード（確認）'), {
    target: { value: confirm },
  });
}

const submit = () => {
  fireEvent.click(screen.getByRole('button', { name: 'パスワードを変更する' }));
};

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('パスワードの変更の強制（UC-13・UC-14。SC-01。D-45）', () => {
  it('管理者が決めたパスワードで、最初にログインすると、パスワードの変更の画面だけを表示する（メニュー・ほかの画面へは移れない。API も呼ばない）', async () => {
    const { calls } = renderApp({ path: '/data-entry' });

    expect(
      await screen.findByRole('heading', { name: 'パスワードの変更', level: 1 }),
    ).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain(
      '管理者が決めたパスワードは、一時のもの',
    );
    // 共通のレイアウト（メニュー・ヘッダー）は、表示しない
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: 'ダッシュボード' })).toBeNull();
    expect(screen.getByRole('button', { name: 'ログアウト' })).toBeDefined();
    // 変更するまでは、ほかの API を呼ばない（呼んでも、サーバーが拒否する）
    expect(calls).toHaveLength(0);
  });

  it('ログイン画面からログインして、変更が必要な旨が返ると、変更の画面へ進む', async () => {
    renderApp({ session: null, path: '/login' });
    fireEvent.change(await screen.findByLabelText('ユーザーID'), { target: { value: 'worker-1' } });
    fireEvent.change(screen.getByLabelText('パスワード'), {
      target: { value: 'Dummy-Passw0rd-temp' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));

    expect(
      await screen.findByRole('heading', { name: 'パスワードの変更', level: 1 }),
    ).toBeDefined();
  });

  it('変更すると、新しいセッションを保存し、もとの画面（ダッシュボード）へ進む', async () => {
    const { calls, session } = renderApp({ path: '/' });
    await screen.findByRole('heading', { name: 'パスワードの変更', level: 1 });

    fillForm('Dummy-Passw0rd-temp', 'Dummy-Passw0rd-own');
    submit();

    expect(await screen.findByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeDefined();
    expect(calls.find((call) => call.path === '/auth/password')?.body).toEqual({
      currentPassword: 'Dummy-Passw0rd-temp',
      newPassword: 'Dummy-Passw0rd-own',
    });
    expect(session.current?.accessToken).toBe('access-token-2');
    expect(session.current?.user.mustChangePassword).toBe(false);
  });

  it('入力が不足・不正なら、項目ごとのエラーを示し、API は呼ばない（現在のパスワードなし・条件を満たさない・確認が違う・現在と同じ）', async () => {
    const { calls } = renderApp();
    await screen.findByRole('heading', { name: 'パスワードの変更', level: 1 });

    submit();
    expect(await screen.findByText('現在のパスワードを入力してください')).toBeDefined();
    expect(screen.getByText('新しいパスワードを入力してください')).toBeDefined();

    fillForm('Dummy-Passw0rd-temp', 'short');
    submit();
    expect(await screen.findByText(/パスワードは8文字以上/)).toBeDefined();

    fillForm('Dummy-Passw0rd-temp', 'Dummy-Passw0rd-own', 'Dummy-Passw0rd-other');
    submit();
    expect(await screen.findByText('新しいパスワード（確認）が一致しません')).toBeDefined();

    fillForm('Dummy-Passw0rd-temp', 'Dummy-Passw0rd-temp');
    submit();
    expect(
      await screen.findByText('新しいパスワードは、現在のパスワードと違うものにしてください'),
    ).toBeDefined();
    expect(calls.filter((call) => call.path === '/auth/password')).toHaveLength(0);
  });

  it('現在のパスワードの誤り（サーバーの項目のエラー）を、現在のパスワードの欄に示す。画面は、変更の画面のまま', async () => {
    renderApp({
      scenario: {
        password: () =>
          errorBody(400, 'VALIDATION_ERROR', '入力内容に誤りがあります', [
            { name: 'currentPassword', message: '現在のパスワードが正しくありません' },
          ]),
      },
    });
    await screen.findByRole('heading', { name: 'パスワードの変更', level: 1 });

    fillForm('Dummy-Passw0rd-bad', 'Dummy-Passw0rd-own');
    submit();

    const error = await screen.findByText('現在のパスワードが正しくありません');
    expect(error.closest('[data-field="currentPassword"]')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'パスワードの変更', level: 1 })).toBeDefined();
  });

  it('試行の制限（429）のメッセージを、画面に示す', async () => {
    renderApp({
      scenario: {
        password: () =>
          errorResponse(
            429,
            'RATE_LIMITED',
            'ログインの試行回数が上限を超えました。しばらくしてからやり直してください',
          ),
      },
    });
    await screen.findByRole('heading', { name: 'パスワードの変更', level: 1 });

    fillForm('Dummy-Passw0rd-temp', 'Dummy-Passw0rd-own');
    submit();

    expect((await screen.findByRole('alert')).textContent).toContain('試行回数が上限を超えました');
  });

  it('ログアウトできる（変更せずに、ログイン画面へ戻る）', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'パスワードの変更', level: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));

    expect(await screen.findByRole('heading', { name: 'ログイン', level: 2 })).toBeDefined();
  });

  it('新しいパスワードの欄は、パスワードの種類（type=password）・自動入力の指定（new-password）を持つ', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'パスワードの変更', level: 1 });

    expect(screen.getByLabelText('現在のパスワード').getAttribute('autocomplete')).toBe(
      'current-password',
    );
    for (const label of ['新しいパスワード（確認）']) {
      expect(screen.getByLabelText(label).getAttribute('type')).toBe('password');
    }
    expect(
      screen.getByLabelText('新しいパスワード', { exact: true }).getAttribute('autocomplete'),
    ).toBe('new-password');
  });
});

describe('本人によるパスワードの変更（変更が必要でない利用者。FR-9.7）', () => {
  it('ヘッダーの「パスワードの変更」から、変更の画面を開ける（共通のレイアウトの中）。変更すると、ダッシュボードへ戻る', async () => {
    const { session } = renderApp({ session: WORKER_LOGIN, path: '/' });

    fireEvent.click(await screen.findByRole('link', { name: 'パスワードの変更' }));

    const main = await screen.findByRole('main');
    expect(within(main).getByRole('heading', { name: 'パスワードの変更', level: 1 })).toBeDefined();
    // 強制の案内は、出さない
    expect(screen.queryByText(/管理者が決めたパスワードは、一時のもの/)).toBeNull();
    fillForm('Dummy-Passw0rd-1', 'Dummy-Passw0rd-own');
    submit();
    await waitFor(() => {
      expect(session.current?.accessToken).toBe('access-token-2');
    });
    expect(await screen.findByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeDefined();
  });
});
