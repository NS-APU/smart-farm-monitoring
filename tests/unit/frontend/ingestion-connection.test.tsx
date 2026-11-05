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

  it('認証情報（パスワード・トークン・API キー）の値の入力欄は、この画面にはない。値は、表示しない', async () => {
    renderApp('/settings/ingestion', routes([source({ connection: HTTP_CONNECTION })]));
    const robot = await robotCard();

    expect(within(robot).queryByLabelText('パスワード', { exact: false })).toBeNull();
    expect(within(robot).queryByLabelText('トークン', { exact: false })).toBeNull();
    expect(within(robot).queryByLabelText('API キー', { exact: true })).toBeNull();
    expect(within(robot).getByTestId('credentials-note-robot').textContent).toContain(
      '認証情報の値は、この画面では入力・表示しません',
    );
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
