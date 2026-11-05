/**
 * 取り込み設定（SC-11）のファイルサーバーの接続設定（Issue #172。ADR-0022）の画面テスト。
 * 接続方式（モック／HTTP）、プロトコル・ホスト・ポート・ファイルパス・認証方式の入力、平文 HTTP の警告、
 * 入力の検証、接続テストの失敗の理由の表示。認証情報の値は、画面で入力・表示しない。
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import {
  READ_ONLY_LOGIN,
  callsOf,
  errorBody,
  loginWith,
  renderApp,
  type Routes,
} from '../../support/management-frontend.ts';

const HTTP_CONNECTION = {
  type: 'HTTP',
  protocol: 'HTTPS',
  host: 'fileserver.example.ac.jp',
  port: 8443,
  filePath: '/data/robot/latest.json',
  authMethod: 'API_KEY',
  apiKeyHeaderName: 'X-Auth-Token',
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'robot',
    kind: 'ROBOT',
    profileId: 'robot-v1',
    connectionRef: 'file-server-main',
    connection: { type: 'MOCK' },
    intervalMinutes: 15,
    isEnabled: true,
    formatProfile: { versionLabel: 'v0.1', status: 'PROVISIONAL' },
    lastStartedAt: null,
    lastSuccessAt: null,
    isRunning: false,
    ...overrides,
  };
}

function routes(sources: unknown[], extra: Routes = {}): Routes {
  return {
    'GET /ingestion/settings': () => jsonResponse({ sources }),
    'GET /ingestion/logs': () => jsonResponse({ items: [], nextCursor: null }),
    'GET /federation/logs': () =>
      jsonResponse({
        items: [],
        nextCursor: null,
        queue: { PENDING: 0, SENT: 0, FAILED: 0, HELD: 0, EXPIRED: 0 },
      }),
    ...extra,
  };
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

async function robotCard(): Promise<HTMLElement> {
  return screen.findByTestId('source-robot');
}

function choose(scope: HTMLElement, label: string, value: string): void {
  fireEvent.change(within(scope).getByLabelText(label, { exact: false }), { target: { value } });
}

function save(scope: HTMLElement): void {
  fireEvent.click(within(scope).getByRole('button', { name: '設定を保存' }));
}

describe('接続方式の切り替え', () => {
  it('モック: ホスト・ポート・ファイルパス・認証方式の入力は、表示しない', async () => {
    renderApp('/settings/ingestion', routes([source()]));
    const robot = await robotCard();

    expect(
      within(robot).getByLabelText<HTMLSelectElement>('接続方式', { exact: false }).value,
    ).toBe('MOCK');
    expect(within(robot).queryByLabelText('ホスト', { exact: false })).toBeNull();
    expect(within(robot).queryByLabelText('ポート', { exact: false })).toBeNull();
    expect(within(robot).queryByLabelText('ファイルパス', { exact: false })).toBeNull();
    expect(within(robot).queryByLabelText('認証方式', { exact: false })).toBeNull();
  });

  it('HTTP を選ぶと、プロトコル（既定は HTTPS）・ホスト・ポート・ファイルパス・認証方式の入力を表示する', async () => {
    renderApp('/settings/ingestion', routes([source()]));
    const robot = await robotCard();

    choose(robot, '接続方式', 'HTTP');

    expect(
      within(robot).getByLabelText<HTMLSelectElement>('プロトコル', { exact: false }).value,
    ).toBe('HTTPS');
    expect(within(robot).getByLabelText('ホスト', { exact: false })).toBeDefined();
    expect(within(robot).getByLabelText('ポート', { exact: false })).toBeDefined();
    expect(within(robot).getByLabelText('ファイルパス', { exact: false })).toBeDefined();
    expect(
      within(robot).getByLabelText<HTMLSelectElement>('認証方式', { exact: false }).value,
    ).toBe('NONE');
  });

  it('保存済みの HTTP の接続設定を、入力に表示する。API キーのヘッダー名は、認証方式が API キーのときだけ', async () => {
    renderApp('/settings/ingestion', routes([source({ connection: HTTP_CONNECTION })]));
    const robot = await robotCard();

    expect(within(robot).getByLabelText<HTMLInputElement>('ホスト', { exact: false }).value).toBe(
      'fileserver.example.ac.jp',
    );
    expect(within(robot).getByLabelText<HTMLInputElement>('ポート', { exact: false }).value).toBe(
      '8443',
    );
    expect(
      within(robot).getByLabelText<HTMLInputElement>('ファイルパス', { exact: false }).value,
    ).toBe('/data/robot/latest.json');
    expect(
      within(robot).getByLabelText<HTMLInputElement>('ヘッダー名', { exact: false }).value,
    ).toBe('X-Auth-Token');

    choose(robot, '認証方式', 'BASIC');
    expect(within(robot).queryByLabelText('ヘッダー名', { exact: false })).toBeNull();
  });

  it('ポートを省略すると、プロトコルの既定（HTTPS は 443、HTTP は 80）を、案内に示す', async () => {
    renderApp(
      '/settings/ingestion',
      routes([source({ connection: { ...HTTP_CONNECTION, port: undefined } })]),
    );
    const robot = await robotCard();

    expect(
      within(robot).getByLabelText<HTMLInputElement>('ポート', { exact: false }).placeholder,
    ).toBe('443');
    choose(robot, 'プロトコル', 'HTTP');
    expect(
      within(robot).getByLabelText<HTMLInputElement>('ポート', { exact: false }).placeholder,
    ).toBe('80');
  });
});

describe('平文 HTTP の警告', () => {
  it('プロトコルが HTTP のときだけ、通信が暗号化されない旨を警告する', async () => {
    renderApp('/settings/ingestion', routes([source({ connection: HTTP_CONNECTION })]));
    const robot = await robotCard();

    expect(within(robot).queryByTestId('plaintext-warning-robot')).toBeNull();
    choose(robot, 'プロトコル', 'HTTP');

    const warning = within(robot).getByTestId('plaintext-warning-robot');
    expect(warning.getAttribute('role')).toBe('alert');
    expect(warning.textContent).toContain('暗号化されません');
    expect(warning.textContent).toContain('HTTPS');
  });
});

describe('設定の保存', () => {
  it('HTTP の接続設定を送る（ポートの省略は、送らない）。認証情報の値は、送らない', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      routes([source()], {
        'PUT /ingestion/settings': () => jsonResponse({ sources: [source()] }),
      }),
    );
    const robot = await robotCard();

    choose(robot, '接続方式', 'HTTP');
    choose(robot, 'ホスト', 'fileserver.example.ac.jp');
    choose(robot, 'ファイルパス', '/data/robot/latest.json');
    choose(robot, '認証方式', 'BASIC');
    save(robot);

    expect((await screen.findByTestId('result-robot')).textContent).toBe('設定を保存しました');
    expect(callsOf(calls, 'PUT', '/ingestion/settings')[0]?.body).toEqual({
      sources: [
        {
          sourceId: 'robot',
          connectionRef: 'file-server-main',
          connection: {
            type: 'HTTP',
            protocol: 'HTTPS',
            host: 'fileserver.example.ac.jp',
            filePath: '/data/robot/latest.json',
            authMethod: 'BASIC',
            apiKeyHeaderName: 'X-API-Key',
          },
          intervalMinutes: 15,
          isEnabled: true,
        },
      ],
    });
  });

  it('ポートを入力すると、数値で送る', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      routes([source({ connection: HTTP_CONNECTION })], {
        'PUT /ingestion/settings': () => jsonResponse({ sources: [source()] }),
      }),
    );
    const robot = await robotCard();

    choose(robot, 'ポート', '9443');
    save(robot);

    await screen.findByTestId('result-robot');
    const body = callsOf(calls, 'PUT', '/ingestion/settings')[0]?.body as {
      sources: { connection: { port: number } }[];
    };
    expect(body.sources[0]?.connection.port).toBe(9443);
  });

  it('接続設定を変えていないときは、connection を送らない（現在の接続設定を保つ）', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      routes([source({ connection: HTTP_CONNECTION })], {
        'PUT /ingestion/settings': () => jsonResponse({ sources: [source()] }),
      }),
    );
    const robot = await robotCard();

    fireEvent.click(within(robot).getByRole('checkbox'));
    save(robot);

    await screen.findByTestId('result-robot');
    const body = callsOf(calls, 'PUT', '/ingestion/settings')[0]?.body as {
      sources: Record<string, unknown>[];
    };
    expect(body.sources[0]).not.toHaveProperty('connection');
  });

  it.each([
    [
      'ホストが空',
      { name: 'ホスト', value: '' },
      'ホスト名は、FQDN・IPv4・[IPv6] で指定してください',
    ],
    [
      'ホストにスキームを含む',
      { name: 'ホスト', value: 'https://fileserver.example.ac.jp' },
      'ホスト名は、FQDN・IPv4・[IPv6] で指定してください',
    ],
    ['ポートが範囲外', { name: 'ポート', value: '70000' }, '65535'],
    [
      'ポートが数字でない',
      { name: 'ポート', value: 'abc' },
      'ポート番号は、1〜65535 の数字で指定してください',
    ],
    [
      'ファイルパスが / で始まらない',
      { name: 'ファイルパス', value: 'data/a.json' },
      'ファイルパスは、/ で始まるファイル 1 つを',
    ],
    [
      'ファイルパスに ..',
      { name: 'ファイルパス', value: '/data/../a.json' },
      'ファイルパスは、/ で始まるファイル 1 つを',
    ],
  ])('不正な入力（%s）は、送らず、項目にエラーを表示する', async (_name, change, message) => {
    const { calls } = renderApp(
      '/settings/ingestion',
      routes([source({ connection: HTTP_CONNECTION })], {
        'PUT /ingestion/settings': () => jsonResponse({ sources: [source()] }),
      }),
    );
    const robot = await robotCard();

    choose(robot, change.name, change.value);
    save(robot);

    await waitFor(() => {
      expect(within(robot).getAllByText(message, { exact: false }).length).toBeGreaterThan(0);
    });
    expect(callsOf(calls, 'PUT', '/ingestion/settings')).toHaveLength(0);
  });

  it('サーバーが、内部のアドレスを拒否したら、ホストの項目に表示する', async () => {
    renderApp(
      '/settings/ingestion',
      routes([source({ connection: HTTP_CONNECTION })], {
        'PUT /ingestion/settings': () =>
          errorBody(422, 'VALIDATION_ERROR', '入力内容を確認してください', [
            {
              name: 'sources.0.connection.host',
              message:
                '内部のアドレス（ループバック・プライベート・リンクローカルなど）は、接続先に指定できません',
            },
          ]),
      }),
    );
    const robot = await robotCard();

    choose(robot, 'ホスト', '169.254.169.254');
    save(robot);

    expect(await within(robot).findByText('内部のアドレス', { exact: false })).toBeDefined();
  });
});

describe('接続テストと認証情報', () => {
  it('接続テストの失敗は、理由を表示する（サーバーが返す、接続先・認証情報を含まない文言）', async () => {
    renderApp(
      '/settings/ingestion',
      routes([source({ connection: HTTP_CONNECTION })], {
        'POST /ingestion/robot/test': () =>
          jsonResponse({
            ok: false,
            message:
              '接続できませんでした（認証情報が設定されていません）。接続先と認証情報の設定を確認してください',
          }),
      }),
    );
    const robot = await robotCard();

    fireEvent.click(within(robot).getByRole('button', { name: '接続テスト' }));

    const result = await screen.findByTestId('result-robot');
    expect(result.textContent).toContain('認証情報が設定されていません');
    expect(result.className).toContain('form-error');
  });
});

describe('参照のみ（権限がない）', () => {
  it('接続設定の入力は、読み取り専用（無効）になる', async () => {
    renderApp('/settings/ingestion', routes([source({ connection: HTTP_CONNECTION })]), {
      login: READ_ONLY_LOGIN,
    });
    const robot = await robotCard();

    expect(
      within(robot).getByLabelText<HTMLSelectElement>('接続方式', { exact: false }).disabled,
    ).toBe(true);
    expect(
      within(robot).getByLabelText<HTMLInputElement>('ホスト', { exact: false }).readOnly,
    ).toBe(true);
  });
});

describe('認証情報の登録（Issue #207。D-47。書き込み専用）', () => {
  const BASIC = { ...HTTP_CONNECTION, authMethod: 'BASIC' };
  const BEARER = { ...HTTP_CONNECTION, authMethod: 'BEARER' };
  const DUMMY_PASSWORD = 'dummy-password-0123';
  const UPDATED_AT = '2026-11-09T02:00:00.000Z';

  it('状態を示す: 未設定・設定済み（更新日時つき）・確認できない。認証が不要（モック・認証なし）は、登録の欄を出さない', async () => {
    renderApp(
      '/settings/ingestion',
      routes([
        source({ connection: BASIC, credentials: { state: 'NOT_CONFIGURED' } }),
        source({
          sourceId: 'environment-sensor',
          connection: BEARER,
          credentials: { state: 'CONFIGURED', updatedAt: UPDATED_AT },
        }),
        source({ sourceId: 'custom-1', connection: { ...HTTP_CONNECTION, authMethod: 'NONE' } }),
        source({ sourceId: 'custom-2', connection: { type: 'MOCK' } }),
        source({ sourceId: 'custom-3', connection: BEARER, credentials: { state: 'UNAVAILABLE' } }),
      ]),
    );

    expect((await screen.findByTestId('credentials-status-robot')).textContent).toContain('未設定');
    const configured = screen.getByTestId('credentials-status-environment-sensor').textContent;
    expect(configured).toContain('設定済み');
    expect(configured).toContain('2026');
    expect(screen.getByTestId('credentials-status-custom-3').textContent).toContain(
      '確認できません',
    );
    expect(screen.queryByTestId('credentials-status-custom-1')).toBeNull();
    expect(screen.queryByTestId('credentials-status-custom-2')).toBeNull();
  });

  it('Basic: ユーザー名とパスワード（伏せ字）を入力して保存する。値を送り、入力欄を空に戻し、画面に値を残さない', async () => {
    let saved = false;
    const { calls } = renderApp(
      '/settings/ingestion',
      routes([], {
        'PUT /ingestion/robot/credentials': () => {
          saved = true;
          return jsonResponse({ state: 'CONFIGURED', updatedAt: UPDATED_AT });
        },
        'GET /ingestion/settings': () =>
          jsonResponse({
            sources: [
              source({
                connection: BASIC,
                credentials: saved
                  ? { state: 'CONFIGURED', updatedAt: UPDATED_AT }
                  : { state: 'NOT_CONFIGURED' },
              }),
            ],
          }),
      }),
    );
    const robot = await robotCard();
    const password = within(robot).getByLabelText<HTMLInputElement>('パスワード', {
      exact: false,
    });
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('new-password');

    fireEvent.change(within(robot).getByLabelText('ユーザー名', { exact: false }), {
      target: { value: 'dummy-user' },
    });
    fireEvent.change(password, { target: { value: DUMMY_PASSWORD } });
    fireEvent.click(within(robot).getByRole('button', { name: '認証情報を保存' }));

    expect((await screen.findByTestId('result-robot')).textContent).toBe('認証情報を保存しました');
    expect(callsOf(calls, 'PUT', '/ingestion/robot/credentials')[0]?.body).toEqual({
      authMethod: 'BASIC',
      username: 'dummy-user',
      password: DUMMY_PASSWORD,
    });
    await waitFor(() => {
      expect(screen.getByTestId('credentials-status-robot').textContent).toContain('設定済み');
    });
    expect(
      within(robot).getByLabelText<HTMLInputElement>('パスワード', { exact: false }).value,
    ).toBe('');
    expect(
      within(robot).getByLabelText<HTMLInputElement>('ユーザー名', { exact: false }).value,
    ).toBe('');
    expect(document.body.innerHTML).not.toContain(DUMMY_PASSWORD);
  });

  it('Bearer・API キー: トークン・API キーの入力は、伏せ字で、保存して、送る', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      routes(
        [
          source({ connection: BEARER, credentials: { state: 'NOT_CONFIGURED' } }),
          source({
            sourceId: 'environment-sensor',
            connection: { ...HTTP_CONNECTION, authMethod: 'API_KEY' },
            credentials: { state: 'CONFIGURED', updatedAt: UPDATED_AT },
          }),
        ],
        {
          'PUT /ingestion/robot/credentials': () => jsonResponse({ state: 'CONFIGURED' }),
          'PUT /ingestion/environment-sensor/credentials': () =>
            jsonResponse({ state: 'CONFIGURED' }),
        },
      ),
    );
    const robot = await robotCard();
    const sensor = await screen.findByTestId('source-environment-sensor');
    const token = within(robot).getByLabelText<HTMLInputElement>('トークン', { exact: false });
    const apiKey = within(sensor).getByLabelText<HTMLInputElement>('API キー', { exact: true });
    expect(token.type).toBe('password');
    expect(apiKey.type).toBe('password');

    fireEvent.change(token, { target: { value: 'dummy-token' } });
    fireEvent.click(within(robot).getByRole('button', { name: '認証情報を保存' }));
    await screen.findByTestId('result-robot');
    fireEvent.change(apiKey, { target: { value: 'dummy-api-key' } });
    fireEvent.click(within(sensor).getByRole('button', { name: '認証情報を保存' }));
    await screen.findByTestId('result-environment-sensor');

    expect(callsOf(calls, 'PUT', '/ingestion/robot/credentials')[0]?.body).toEqual({
      authMethod: 'BEARER',
      token: 'dummy-token',
    });
    expect(callsOf(calls, 'PUT', '/ingestion/environment-sensor/credentials')[0]?.body).toEqual({
      authMethod: 'API_KEY',
      apiKey: 'dummy-api-key',
    });
  });

  it.each([
    ['ユーザー名が空', { ユーザー名: '', パスワード: 'p' }, 'ユーザー名を入力してください'],
    ['パスワードが空', { ユーザー名: 'u', パスワード: '' }, 'パスワードを入力してください'],
    [
      'ユーザー名に : を含む',
      { ユーザー名: 'a:b', パスワード: 'p' },
      'ユーザー名に : は使えません',
    ],
  ])('不正な入力（%s）は、送らず、項目にエラーを表示する', async (_name, values, message) => {
    const { calls } = renderApp(
      '/settings/ingestion',
      routes([source({ connection: BASIC, credentials: { state: 'NOT_CONFIGURED' } })]),
    );
    const robot = await robotCard();

    for (const [label, value] of Object.entries(values)) {
      fireEvent.change(within(robot).getByLabelText(label, { exact: false }), {
        target: { value },
      });
    }
    fireEvent.click(within(robot).getByRole('button', { name: '認証情報を保存' }));

    expect(await within(robot).findByText(message)).toBeDefined();
    expect(callsOf(calls, 'PUT', '/ingestion/robot/credentials')).toHaveLength(0);
  });

  it('トークンに空白を含むときは、送らず、エラーを表示する', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      routes([source({ connection: BEARER, credentials: { state: 'NOT_CONFIGURED' } })]),
    );
    const robot = await robotCard();

    fireEvent.change(within(robot).getByLabelText('トークン', { exact: false }), {
      target: { value: 'dummy token' },
    });
    fireEvent.click(within(robot).getByRole('button', { name: '認証情報を保存' }));

    expect(
      await within(robot).findByText('英数字と記号だけで入力してください', { exact: false }),
    ).toBeDefined();
    expect(callsOf(calls, 'PUT', '/ingestion/robot/credentials')).toHaveLength(0);
  });

  it('サーバーが項目のエラーを返したら、その項目に表示する。入力は、そのまま残す（再入力させない）', async () => {
    renderApp(
      '/settings/ingestion',
      routes([source({ connection: BEARER, credentials: { state: 'NOT_CONFIGURED' } })], {
        'PUT /ingestion/robot/credentials': () =>
          errorBody(400, 'VALIDATION_ERROR', '入力内容に誤りがあります', [
            { name: 'authMethod', message: '認証方式が、保存済みの設定と違います' },
          ]),
      }),
    );
    const robot = await robotCard();
    const token = within(robot).getByLabelText<HTMLInputElement>('トークン', { exact: false });

    fireEvent.change(token, { target: { value: 'dummy-token' } });
    fireEvent.click(within(robot).getByRole('button', { name: '認証情報を保存' }));

    expect(await within(robot).findByText('認証方式が、保存済みの設定と違います')).toBeDefined();
    expect(token.value).toBe('dummy-token');
  });

  it('認証方式を変えて、まだ保存していないときは、先に設定を保存するよう案内し、登録できない', async () => {
    renderApp(
      '/settings/ingestion',
      routes([source({ connection: BEARER, credentials: { state: 'NOT_CONFIGURED' } })]),
    );
    const robot = await robotCard();

    choose(robot, '認証方式', 'BASIC');

    expect(within(robot).getByTestId('credentials-unsaved-robot').textContent).toContain(
      '先に設定を保存',
    );
    expect(
      within(robot).getByRole<HTMLButtonElement>('button', { name: '認証情報を保存' }).disabled,
    ).toBe(true);
  });

  it('新しく HTTP・認証方式を選んだだけ（未保存）のときは、登録の欄を出さず、保存後に登録できる旨を案内する', async () => {
    renderApp('/settings/ingestion', routes([source()]));
    const robot = await robotCard();

    choose(robot, '接続方式', 'HTTP');
    choose(robot, '認証方式', 'BASIC');

    expect(within(robot).queryByRole('button', { name: '認証情報を保存' })).toBeNull();
    expect(within(robot).getByTestId('credentials-note-robot').textContent).toContain(
      '設定を保存したあとに、登録できます',
    );
  });

  it('権限がない利用者（実行のみ）には、状態だけを示し、入力欄・保存のボタンは出さない', async () => {
    renderApp(
      '/settings/ingestion',
      routes([
        source({
          connection: BASIC,
          credentials: { state: 'CONFIGURED', updatedAt: UPDATED_AT },
        }),
      ]),
      { login: loginWith(['ingestion:run']) },
    );
    const robot = await robotCard();

    expect(within(robot).getByTestId('credentials-status-robot').textContent).toContain('設定済み');
    expect(within(robot).queryByLabelText('パスワード', { exact: false })).toBeNull();
    expect(within(robot).queryByRole('button', { name: '認証情報を保存' })).toBeNull();
  });
});
