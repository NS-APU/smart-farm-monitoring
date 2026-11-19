/**
 * 設備のダイアログ（SC-10）の「取り込み元の接続」の欄の画面テスト（Issue #367。ADR-0026。ADR-0022 の接続の項目・検証）。
 * 接続は、設備ごとに持つ（取り込み元ごとの共通の入力欄は、ない）。ロボット・環境センサーのダイアログにだけ出る（ハウスにはない）。
 * 検証は共有のスキーマ（項目ごとにエラー）、保存は、設備 → 接続の順、認証情報は書き込み専用、その設備だけの接続テスト、
 * 同じ種別の設備からのコピー（認証情報は写さない）、接続の解除、共通の接続（移行期間）・未設定の注意、設備 ID の説明（SC-10-5）、
 * 登録後の案内（SC-10-9）。値はすべて合成データ。
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import {
  at,
  callsOf,
  errorBody,
  loginWith,
  renderApp,
  type Routes,
} from '../../support/management-frontend.ts';

const CONNECTION = {
  type: 'HTTP',
  protocol: 'HTTPS',
  host: 'fileserver.example.ac.jp',
  port: 8443,
  authMethod: 'API_KEY',
  apiKeyHeaderName: 'X-Auth-Token',
};
const BASIC = { ...CONNECTION, authMethod: 'BASIC' };
const BEARER = { ...CONNECTION, authMethod: 'BEARER' };
const UPDATED_AT = '2026-11-09T02:00:00.000Z';
const DUMMY_PASSWORD = 'dummy-password-0123';

const SAVED_EQUIPMENT = {
  equipmentId: 'ROBOT-02',
  equipmentType: 'ROBOT',
  name: 'ロボット2',
  facilityId: 'HOUSE-01',
  isDeleted: false,
  createdAt: '2026-10-01T00:00:00.000Z',
};

/** 設備の取り込みの状況（既定: ROBOT-01。設備ごとの接続あり・認証情報は未設定）。 */
function status(overrides: Record<string, unknown> = {}) {
  return {
    equipmentId: 'ROBOT-01',
    name: '収穫ロボット1',
    sourceFilePath: '/data/robot-01.json',
    connection: BASIC,
    connectionOrigin: 'EQUIPMENT',
    credentials: { state: 'NOT_CONFIGURED' },
    lastStartedAt: null,
    lastResult: null,
    lastSuccessAt: null,
    lastDataAt: null,
    ...overrides,
  };
}

function sourceOf(
  sourceId: string,
  kind: 'ROBOT' | 'SENSOR',
  equipment: readonly unknown[],
): Record<string, unknown> {
  return {
    sourceId,
    kind,
    profileId: `${sourceId}-v1`,
    connectionRef: 'file-server-main',
    isEnabled: true,
    formatProfile: { versionLabel: 'v0.1', status: 'PROVISIONAL' },
    lastStartedAt: null,
    lastSuccessAt: null,
    equipment,
    isRunning: false,
  };
}

/** 取り込み設定・状況の応答。既定: ロボット（ROBOT-01）・センサー（SENSOR-01）。 */
function settings(
  robots: readonly unknown[] = [status()],
  sensors: readonly unknown[] = [
    status({
      equipmentId: 'SENSOR-01',
      name: '環境センサー1',
      sourceFilePath: '/data/sensor-01.json',
      connection: { ...CONNECTION, host: 'sensor.example.ac.jp' },
    }),
  ],
) {
  return {
    sources: [
      sourceOf('robot', 'ROBOT', robots),
      sourceOf('environment-sensor', 'SENSOR', sensors),
    ],
  };
}

function routes(extra: Routes = {}, response: unknown = settings()): Routes {
  return {
    'GET /ingestion/settings': () => jsonResponse(response),
    'PUT /equipment/ROBOT-01': () => jsonResponse(SAVED_EQUIPMENT),
    'PUT /equipment/SENSOR-01': () => jsonResponse(SAVED_EQUIPMENT),
    'PUT /equipment/HOUSE-01': () => jsonResponse(SAVED_EQUIPMENT),
    ...extra,
  };
}

function connectionResponse(overrides: Record<string, unknown> = {}) {
  return {
    equipmentId: 'ROBOT-01',
    connection: BASIC,
    connectionOrigin: 'EQUIPMENT',
    credentials: { state: 'NOT_CONFIGURED' },
    ...overrides,
  };
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

/** 修正のダイアログを開く（行: 0 = ハウス、1 = ロボット、2 = センサー）。 */
async function openEdit(rowIndex = 1): Promise<HTMLElement> {
  const rows = await screen.findAllByTestId('equipment-row');
  fireEvent.click(within(at(rows, rowIndex)).getByRole('button', { name: '修正' }));
  return screen.findByTestId('equipment-edit');
}

/** 接続の欄が、読み込まれるまで待つ。 */
async function connectionOf(form: HTMLElement): Promise<HTMLElement> {
  const section = await within(form).findByTestId('equipment-connection');
  await within(section).findByLabelText('ホスト', { exact: false });
  return section;
}

async function openEditConnection(
  rowIndex = 1,
): Promise<{ form: HTMLElement; section: HTMLElement }> {
  const form = await openEdit(rowIndex);
  return { form, section: await connectionOf(form) };
}

/** ロボット・環境センサーの登録のダイアログを開く。 */
async function openChild(): Promise<HTMLElement> {
  await screen.findAllByTestId('equipment-row');
  fireEvent.click(screen.getByRole('button', { name: 'ロボット・環境センサーの登録' }));
  return screen.getByRole('form', { name: 'ロボット・環境センサーを登録' });
}

function choose(scope: HTMLElement, label: string, value: string): void {
  fireEvent.change(within(scope).getByLabelText(label, { exact: false }), { target: { value } });
}

function fillChild(form: HTMLElement, id = 'ROBOT-02', name = 'ロボット2'): void {
  choose(form, '親のハウス', 'HOUSE-01');
  choose(form, '設備ID', id);
  choose(form, '名称', name);
}

function indexOfCall(
  calls: readonly { method: string; path: string }[],
  method: string,
  path: string,
): number {
  return calls.findIndex((call) => call.method === method && call.path === path);
}

describe('接続の欄の表示・出し分け', () => {
  it('ロボットの修正のダイアログに、「取り込み元の接続」の欄がある。接続方式の選択はなく、プロトコル・ホスト名・ポート番号・認証方式を表示する', async () => {
    renderApp('/settings/equipment', routes());
    const { section } = await openEditConnection();

    expect(within(section).getByText('取り込み元の接続')).toBeDefined();
    expect(within(section).queryByLabelText('接続方式', { exact: false })).toBeNull();
    expect(within(section).getByLabelText('プロトコル', { exact: false })).toBeDefined();
    expect(within(section).getByLabelText('ホスト', { exact: false })).toBeDefined();
    expect(within(section).getByLabelText('ポート', { exact: false })).toBeDefined();
    expect(within(section).getByLabelText('認証方式', { exact: false })).toBeDefined();
  });

  it('環境センサーの修正のダイアログにも、接続の欄がある（その設備の接続を表示する）', async () => {
    renderApp('/settings/equipment', routes());
    const { section } = await openEditConnection(2);

    expect(within(section).getByLabelText<HTMLInputElement>('ホスト', { exact: false }).value).toBe(
      'sensor.example.ac.jp',
    );
  });

  it('ハウスのダイアログ（修正・登録）には、接続の欄を出さない', async () => {
    renderApp('/settings/equipment', routes());
    const form = await openEdit(0);

    expect(within(form).queryByTestId('equipment-connection')).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'キャンセル' }));
    fireEvent.click(screen.getByRole('button', { name: 'ハウスの登録' }));
    expect(
      within(screen.getByRole('form', { name: 'ハウスを登録' })).queryByTestId(
        'equipment-connection',
      ),
    ).toBeNull();
  });

  it('ロボット・環境センサーの登録のダイアログにも、接続の欄がある。空（HTTPS・ホスト空・ポート空・認証なし）から始まる', async () => {
    renderApp('/settings/equipment', routes());
    const form = await openChild();
    const section = within(form).getByTestId('equipment-connection');

    expect(
      within(section).getByLabelText<HTMLSelectElement>('プロトコル', { exact: false }).value,
    ).toBe('HTTPS');
    expect(within(section).getByLabelText<HTMLInputElement>('ホスト', { exact: false }).value).toBe(
      '',
    );
    expect(within(section).getByLabelText<HTMLInputElement>('ポート', { exact: false }).value).toBe(
      '',
    );
    expect(
      within(section).getByLabelText<HTMLSelectElement>('認証方式', { exact: false }).value,
    ).toBe('NONE');
    expect(within(section).queryByLabelText('ヘッダー名', { exact: false })).toBeNull();
  });

  it('取り込みの参照権限（ingestion:read）がない利用者には、接続の欄を出さず、取り込みの設定を取得しない', async () => {
    const { calls } = renderApp('/settings/equipment', routes(), {
      login: loginWith(['equipment:manage']),
    });
    const form = await openEdit();

    expect(within(form).queryByTestId('equipment-connection')).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'キャンセル' }));
    const child = await openChild();
    expect(within(child).queryByTestId('equipment-connection')).toBeNull();
    expect(calls.filter((call) => call.path.startsWith('/ingestion'))).toEqual([]);
  });

  it('設定の権限（ingestion:configure）がない利用者には、入力を読み取り専用にする。認証情報の入力・コピー・解除は、出さない', async () => {
    renderApp(
      '/settings/equipment',
      routes(
        {},
        settings([status({ credentials: { state: 'CONFIGURED', updatedAt: UPDATED_AT } })]),
      ),
      { login: loginWith(['equipment:manage', 'ingestion:read', 'ingestion:run']) },
    );
    const { section } = await openEditConnection();

    expect(
      within(section).getByLabelText<HTMLSelectElement>('プロトコル', { exact: false }).disabled,
    ).toBe(true);
    expect(
      within(section).getByLabelText<HTMLInputElement>('ホスト', { exact: false }).readOnly,
    ).toBe(true);
    expect(
      within(section).getByLabelText<HTMLInputElement>('ポート', { exact: false }).readOnly,
    ).toBe(true);
    expect(
      within(section).getByLabelText<HTMLSelectElement>('認証方式', { exact: false }).disabled,
    ).toBe(true);
    expect(within(section).getByTestId('equipment-connection-readonly')).toBeDefined();
    // 認証情報は、状態だけ
    expect(within(section).getByTestId('equipment-credentials-status').textContent).toContain(
      '設定済み',
    );
    expect(within(section).queryByLabelText('パスワード', { exact: false })).toBeNull();
    expect(within(section).queryByRole('button', { name: '認証情報を保存' })).toBeNull();
    expect(within(section).queryByTestId('equipment-connection-copy')).toBeNull();
    expect(within(section).queryByTestId('equipment-connection-remove')).toBeNull();
    // 接続テストは、実行の権限があれば、できる
    expect(within(section).getByRole('button', { name: '接続テスト' })).toBeDefined();
  });

  it('実行の権限（ingestion:run）がなければ、接続テストのボタンを出さない', async () => {
    renderApp('/settings/equipment', routes(), {
      login: loginWith(['equipment:manage', 'ingestion:read', 'ingestion:configure']),
    });
    const { section } = await openEditConnection();

    expect(within(section).queryByRole('button', { name: '接続テスト' })).toBeNull();
    expect(within(section).getByTestId('equipment-connection-remove')).toBeDefined();
  });

  it('接続の情報を取得できないときは、その旨を示す（設備の保存はできる。接続は変更しない）', async () => {
    const { calls } = renderApp('/settings/equipment', {
      'GET /ingestion/settings': () => errorBody(500, 'INTERNAL_ERROR', '取得できません'),
      'PUT /equipment/ROBOT-01': () => jsonResponse(SAVED_EQUIPMENT),
    });
    const form = await openEdit();

    expect((await within(form).findByTestId('equipment-connection-loading')).textContent).toContain(
      '接続の情報を取得できません',
    );
    expect(within(form).queryByLabelText('ホスト', { exact: false })).toBeNull();

    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('修正しました');
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(1);
    expect(calls.filter((call) => call.path.includes('/connection'))).toEqual([]);
  });
});

describe('接続の入力（初期値・案内・警告）', () => {
  it('保存済みの接続を、入力に表示する。API キーのヘッダー名は、認証方式が API キーのときだけ', async () => {
    renderApp('/settings/equipment', routes({}, settings([status({ connection: CONNECTION })])));
    const { section } = await openEditConnection();

    expect(within(section).getByLabelText<HTMLInputElement>('ホスト', { exact: false }).value).toBe(
      'fileserver.example.ac.jp',
    );
    expect(within(section).getByLabelText<HTMLInputElement>('ポート', { exact: false }).value).toBe(
      '8443',
    );
    expect(
      within(section).getByLabelText<HTMLInputElement>('ヘッダー名', { exact: false }).value,
    ).toBe('X-Auth-Token');

    choose(section, '認証方式', 'BASIC');
    expect(within(section).queryByLabelText('ヘッダー名', { exact: false })).toBeNull();
  });

  it('ポートを省略すると、プロトコルの既定（HTTPS は 443、HTTP は 80）を、案内に示す', async () => {
    renderApp(
      '/settings/equipment',
      routes({}, settings([status({ connection: { ...BASIC, port: undefined } })])),
    );
    const { section } = await openEditConnection();

    expect(
      within(section).getByLabelText<HTMLInputElement>('ポート', { exact: false }).placeholder,
    ).toBe('443');
    choose(section, 'プロトコル', 'HTTP');
    expect(
      within(section).getByLabelText<HTMLInputElement>('ポート', { exact: false }).placeholder,
    ).toBe('80');
  });

  it('接続が未設定の設備は、「接続先が設定されていません」の案内を示し、入力は空から始まる', async () => {
    renderApp(
      '/settings/equipment',
      routes(
        {},
        settings([
          status({
            connection: undefined,
            connectionOrigin: 'NONE',
            credentials: { state: 'NOT_REQUIRED' },
          }),
        ]),
      ),
    );
    const { section } = await openEditConnection();

    expect(within(section).getByTestId('equipment-connection-unset').textContent).toContain(
      '接続先が設定されていません',
    );
    expect(within(section).getByLabelText<HTMLInputElement>('ホスト', { exact: false }).value).toBe(
      '',
    );
    expect(within(section).queryByTestId('equipment-connection-shared')).toBeNull();
    expect(within(section).queryByTestId('equipment-connection-remove')).toBeNull();
  });

  it('設備ごとの接続があるときは、未設定・共通の接続の注意を示さない', async () => {
    renderApp('/settings/equipment', routes());
    const { section } = await openEditConnection();

    expect(within(section).queryByTestId('equipment-connection-unset')).toBeNull();
    expect(within(section).queryByTestId('equipment-connection-shared')).toBeNull();
  });

  it('プロトコルが HTTP のときだけ、通信が暗号化されない旨を警告する', async () => {
    renderApp('/settings/equipment', routes());
    const { section } = await openEditConnection();

    expect(within(section).queryByTestId('equipment-connection-plaintext-warning')).toBeNull();
    choose(section, 'プロトコル', 'HTTP');

    const warning = within(section).getByTestId('equipment-connection-plaintext-warning');
    expect(warning.getAttribute('role')).toBe('alert');
    expect(warning.textContent).toContain('暗号化されません');
    expect(warning.textContent).toContain('HTTPS');
  });

  it('共通の接続を使う設備（移行期間）は、「設備ごとの接続を設定してください（共通の接続は、廃止予定）」の注意を示し、共通の接続の値を入力に表示する。何も変えなければ、接続を送らない', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes(
        {},
        settings([status({ connectionOrigin: 'SHARED', credentials: { state: 'CONFIGURED' } })]),
      ),
    );
    const { form, section } = await openEditConnection();

    expect(within(section).getByTestId('equipment-connection-shared').textContent).toContain(
      '設備ごとの接続を設定してください（共通の接続は、廃止予定です）',
    );
    expect(within(section).getByLabelText<HTMLInputElement>('ホスト', { exact: false }).value).toBe(
      'fileserver.example.ac.jp',
    );
    // 共通の認証情報は、設備の認証情報ではない（登録の欄は、設備ごとの接続を保存してから）
    expect(within(section).queryByTestId('equipment-credentials')).toBeNull();
    expect(within(section).queryByTestId('equipment-connection-remove')).toBeNull();

    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    await screen.findByTestId('equipment-notice');
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-01/connection')).toHaveLength(0);
  });

  it('共通の接続の内容を、この設備の接続にする（ボタン）と、保存のときに、設備ごとの接続として送る', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes(
        {
          'PUT /ingestion/equipment/ROBOT-01/connection': () => jsonResponse(connectionResponse()),
        },
        settings([status({ connectionOrigin: 'SHARED', credentials: { state: 'CONFIGURED' } })]),
      ),
    );
    const { form, section } = await openEditConnection();

    fireEvent.click(within(section).getByTestId('equipment-connection-adopt'));
    expect(within(section).getByTestId('equipment-connection-result').textContent).toContain(
      '保存すると、この設備だけの接続になります',
    );
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    await screen.findByTestId('equipment-notice');
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-01/connection')[0]?.body).toEqual({
      connection: BASIC,
    });
  });

  it('共通の接続の値を変更して保存すると、その設備だけの接続として送る', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes(
        {
          'PUT /ingestion/equipment/ROBOT-01/connection': () => jsonResponse(connectionResponse()),
        },
        settings([status({ connectionOrigin: 'SHARED', credentials: { state: 'CONFIGURED' } })]),
      ),
    );
    const { form, section } = await openEditConnection();

    choose(section, 'ホスト', 'robot-only.example.ac.jp');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    await screen.findByTestId('equipment-notice');
    expect(
      callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-01/connection')[0]?.body,
    ).toMatchObject({ connection: { host: 'robot-only.example.ac.jp' } });
  });
});

describe('接続の保存（設備 → 接続の順）', () => {
  it('修正: 設備を保存してから、変えた接続を保存する（ポートの省略は送らない）。認証情報の値は、送らない', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes({
        'PUT /ingestion/equipment/ROBOT-01/connection': () =>
          jsonResponse(connectionResponse({ connection: { ...BASIC, host: 'new.example.ac.jp' } })),
      }),
    );
    const { form, section } = await openEditConnection();

    choose(section, 'ホスト', 'New.Example.ac.jp');
    choose(section, 'ポート', '');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('修正しました');
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-01/connection')[0]?.body).toEqual({
      connection: {
        type: 'HTTP',
        protocol: 'HTTPS',
        host: 'new.example.ac.jp',
        authMethod: 'BASIC',
        // 認証方式が API キー以外でも、保存済みのヘッダー名は、そのまま保つ
        apiKeyHeaderName: 'X-Auth-Token',
      },
    });
    expect(indexOfCall(calls, 'PUT', '/equipment/ROBOT-01')).toBeLessThan(
      indexOfCall(calls, 'PUT', '/ingestion/equipment/ROBOT-01/connection'),
    );
    expect(screen.queryByTestId('equipment-edit')).toBeNull();
  });

  it('修正: 接続を変えていないときは、接続を送らない（空白・大文字小文字の違いだけも、送らない）', async () => {
    const { calls } = renderApp('/settings/equipment', routes());
    const { form, section } = await openEditConnection();

    choose(section, 'ホスト', ' FILESERVER.example.ac.jp ');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    await screen.findByTestId('equipment-notice');
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(1);
    expect(calls.filter((call) => call.path.includes('/connection'))).toEqual([]);
  });

  it('修正: 接続が未設定で、何も入力しないときは、接続を送らない（未設定のまま）', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes(
        {},
        settings([
          status({
            connection: undefined,
            connectionOrigin: 'NONE',
            credentials: { state: 'NOT_REQUIRED' },
          }),
        ]),
      ),
    );
    const { form } = await openEditConnection();

    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    await screen.findByTestId('equipment-notice');
    expect(calls.filter((call) => call.path.includes('/connection'))).toEqual([]);
  });

  it('修正: 接続が未設定の設備に、ポートを入力して保存すると、ポートを数値で送る', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes(
        {
          'PUT /ingestion/equipment/ROBOT-01/connection': () =>
            // 応答に接続がなくても（省略できる）、送った接続を、保存済みとして扱う
            jsonResponse(connectionResponse({ connection: undefined })),
        },
        settings([
          status({
            connection: undefined,
            connectionOrigin: 'NONE',
            credentials: { state: 'NOT_REQUIRED' },
          }),
        ]),
      ),
    );
    const { form, section } = await openEditConnection();

    choose(section, 'ホスト', 'robot.example.ac.jp');
    choose(section, 'ポート', '9443');
    choose(section, '認証方式', 'BASIC');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    await screen.findByTestId('equipment-notice');
    const body = callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-01/connection')[0]?.body as {
      connection: { port: number };
    };
    expect(body.connection.port).toBe(9443);
  });

  it('登録: 設備を登録してから、設備 ID が決まったあとに、入力した接続を保存する。接続を入力しなければ、接続は送らない', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes({
        'POST /equipment': () => jsonResponse(SAVED_EQUIPMENT, 201),
        'PUT /ingestion/equipment/ROBOT-02/connection': () =>
          jsonResponse(connectionResponse({ equipmentId: 'ROBOT-02' })),
      }),
    );
    let form = await openChild();
    fillChild(form);
    choose(form, 'ホスト', 'robot2.example.ac.jp');
    choose(form, '認証方式', 'BASIC');
    // 新規の登録は、認証情報を、登録のあとに入力する旨を案内する（欄は出さない）
    expect(within(form).getByTestId('equipment-connection-credentials-note').textContent).toContain(
      '接続を保存したあとに、登録できます',
    );
    expect(within(form).queryByTestId('equipment-credentials')).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('登録しました');
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-02/connection')[0]?.body).toEqual({
      connection: {
        type: 'HTTP',
        protocol: 'HTTPS',
        host: 'robot2.example.ac.jp',
        authMethod: 'BASIC',
        apiKeyHeaderName: 'X-API-Key',
      },
    });
    expect(indexOfCall(calls, 'POST', '/equipment')).toBeLessThan(
      indexOfCall(calls, 'PUT', '/ingestion/equipment/ROBOT-02/connection'),
    );

    // 接続を入力しない登録: 接続は送らない
    form = await openChild();
    fillChild(form, 'ROBOT-03', 'ロボット3');
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    await waitFor(() => {
      expect(callsOf(calls, 'POST', '/equipment')).toHaveLength(2);
    });
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-02/connection')).toHaveLength(1);
    expect(calls.filter((call) => call.path.includes('/ROBOT-03/'))).toEqual([]);
  });

  it('接続の保存に失敗したら、設備は保存済みである旨と、接続のエラー（項目ごと）を、ダイアログに残す。やり直すと、設備は登録し直さず、修正して、接続を保存する', async () => {
    let attempt = 0;
    const { calls } = renderApp(
      '/settings/equipment',
      routes({
        'POST /equipment': () => jsonResponse(SAVED_EQUIPMENT, 201),
        'PUT /equipment/ROBOT-02': () => jsonResponse(SAVED_EQUIPMENT),
        'PUT /ingestion/equipment/ROBOT-02/connection': () => {
          attempt += 1;
          return attempt === 1
            ? errorBody(422, 'VALIDATION_ERROR', '入力内容を確認してください', [
                {
                  name: 'connection.host',
                  message:
                    '内部のアドレス（ループバック・プライベート・リンクローカルなど）は、接続先に指定できません',
                },
              ])
            : jsonResponse(connectionResponse({ equipmentId: 'ROBOT-02' }));
        },
      }),
    );
    const form = await openChild();
    fillChild(form);
    choose(form, 'ホスト', '169.254.169.254');
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    expect((await within(form).findByTestId('equipment-partial')).textContent).toContain(
      '設備は登録しました',
    );
    expect(within(form).getByText('内部のアドレス', { exact: false })).toBeDefined();
    expect(within(form).getByRole('alert').textContent).toBe('入力内容を確認してください');
    // ダイアログは、閉じない。設備 ID は、変更できない
    expect(screen.getByRole('form', { name: 'ロボット・環境センサーを登録' })).toBeDefined();
    expect(within(form).getByLabelText<HTMLInputElement>('設備ID', { exact: false }).readOnly).toBe(
      true,
    );

    choose(form, 'ホスト', 'robot2.example.ac.jp');
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('登録しました');
    expect(callsOf(calls, 'POST', '/equipment')).toHaveLength(1);
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-02')).toHaveLength(1);
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-02/connection')).toHaveLength(2);
  });

  it('修正で、接続の保存に失敗したら、設備は保存済みである旨と、接続のエラーを、ダイアログに残す', async () => {
    renderApp(
      '/settings/equipment',
      routes({
        'PUT /ingestion/equipment/ROBOT-01/connection': () =>
          errorBody(500, 'INTERNAL_ERROR', '接続を保存できませんでした'),
      }),
    );
    const { form, section } = await openEditConnection();

    choose(section, 'ホスト', 'new.example.ac.jp');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    expect((await within(form).findByTestId('equipment-partial')).textContent).toContain(
      '設備は保存しました',
    );
    expect((await within(form).findByRole('alert')).textContent).toBe('接続を保存できませんでした');
    expect(screen.getByTestId('equipment-edit')).toBeDefined();
    expect(screen.queryByTestId('equipment-notice')).toBeNull();
  });

  it('設備の保存に失敗したら、接続は送らない', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes({
        'PUT /equipment/ROBOT-01': () => errorBody(500, 'INTERNAL_ERROR', '修正できませんでした'),
      }),
    );
    const { form, section } = await openEditConnection();

    choose(section, 'ホスト', 'new.example.ac.jp');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    expect((await within(form).findByRole('alert')).textContent).toBe('修正できませんでした');
    expect(calls.filter((call) => call.path.includes('/connection'))).toEqual([]);
  });
});

describe('接続の入力の検証（共有のスキーマ。項目ごとにエラー）', () => {
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
      'API キーのヘッダー名が使えない名前',
      { name: '認証方式', value: 'API_KEY', header: 'Authorization' },
      'このヘッダー名は使えません',
    ],
  ])(
    '不正な入力（%s）は、設備も接続も送らず、項目にエラーを表示する',
    async (_name, change, message) => {
      const { calls } = renderApp('/settings/equipment', routes());
      const { form, section } = await openEditConnection();

      choose(section, change.name, change.value);
      if ('header' in change) {
        choose(section, 'ヘッダー名', change.header);
      }
      fireEvent.click(within(form).getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(within(section).getAllByText(message, { exact: false }).length).toBeGreaterThan(0);
      });
      expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(0);
      expect(calls.filter((call) => call.path.includes('/connection'))).toEqual([]);
    },
  );

  it.each([
    ['プロトコルだけ HTTP にした', { name: 'プロトコル', value: 'HTTP' }],
    ['ポートだけ入力した', { name: 'ポート', value: '8443' }],
    ['認証方式だけ選んだ', { name: '認証方式', value: 'BASIC' }],
  ])(
    '接続が未設定で、%s（ホストは空）ときは、送らず、ホストの項目にエラーを表示する',
    async (_name, change) => {
      const { calls } = renderApp(
        '/settings/equipment',
        routes(
          {},
          settings([
            status({
              connection: undefined,
              connectionOrigin: 'NONE',
              credentials: { state: 'NOT_REQUIRED' },
            }),
          ]),
        ),
      );
      const { form, section } = await openEditConnection();

      choose(section, change.name, change.value);
      fireEvent.click(within(form).getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(
          within(section).getAllByText('ホスト名は、FQDN・IPv4・[IPv6] で指定してください', {
            exact: false,
          }).length,
        ).toBeGreaterThan(0);
      });
      expect(calls.filter((call) => call.path.includes('/connection'))).toEqual([]);
      expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(0);
    },
  );

  it('設備の入力のエラーと、接続の入力のエラーを、同時に表示する', async () => {
    renderApp('/settings/equipment', routes());
    const { form, section } = await openEditConnection();

    choose(form, '名称', '');
    choose(section, 'ホスト', '');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    expect(await within(form).findByText('名称は必須です')).toBeDefined();
    expect(
      within(section).getAllByText('ホスト名は、FQDN・IPv4・[IPv6] で指定してください', {
        exact: false,
      }).length,
    ).toBeGreaterThan(0);
  });

  it('登録でも、設備の入力が正しくても、接続の入力が不正なら、設備を登録せず、項目にエラーを表示する', async () => {
    const { calls } = renderApp('/settings/equipment', routes());
    const form = await openChild();
    fillChild(form);
    choose(form, 'ホスト', 'https://bad.example.ac.jp');

    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    expect(
      (
        await within(form).findAllByText('ホスト名は、FQDN・IPv4・[IPv6] で指定してください', {
          exact: false,
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(callsOf(calls, 'POST', '/equipment')).toHaveLength(0);
  });
});

describe('同じ種別の設備から接続をコピー（認証情報は写さない）', () => {
  const COPY_SETTINGS = settings(
    [
      status(),
      status({
        equipmentId: 'ROBOT-07',
        name: 'コピー元ロボット',
        connection: { ...CONNECTION, host: 'source.example.ac.jp', port: 9000 },
        credentials: { state: 'CONFIGURED', updatedAt: UPDATED_AT },
      }),
      // 共通の接続（SHARED）・未設定の設備は、コピー元にならない
      status({ equipmentId: 'ROBOT-08', name: '共通のロボット', connectionOrigin: 'SHARED' }),
      status({
        equipmentId: 'ROBOT-09',
        name: '未設定のロボット',
        connection: undefined,
        connectionOrigin: 'NONE',
      }),
    ],
    [
      status({
        equipmentId: 'SENSOR-07',
        name: 'コピー元センサー',
        connection: { ...CONNECTION, host: 'sensor-source.example.ac.jp' },
      }),
    ],
  );

  it('選択肢は、同じ種別で、設備ごとの接続を持つ設備（自分自身を除く）だけ', async () => {
    renderApp('/settings/equipment', routes({}, COPY_SETTINGS));
    const { section } = await openEditConnection();

    const select = within(section).getByTestId<HTMLSelectElement>('equipment-connection-copy');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      '選択してください',
      'コピー元ロボット（ROBOT-07）',
    ]);
  });

  it('登録のダイアログでは、選んだ種別（ロボット／環境センサー）の設備が、選択肢になる', async () => {
    renderApp('/settings/equipment', routes({}, COPY_SETTINGS));
    const form = await openChild();
    const section = within(form).getByTestId('equipment-connection');
    await waitFor(() => {
      expect(
        [
          ...within(section).getByTestId<HTMLSelectElement>('equipment-connection-copy').options,
        ].map((option) => option.textContent),
      ).toContain('コピー元ロボット（ROBOT-07）');
    });

    choose(form, '種別', 'SENSOR');

    expect(
      [...within(section).getByTestId<HTMLSelectElement>('equipment-connection-copy').options].map(
        (option) => option.textContent,
      ),
    ).toEqual(['選択してください', 'コピー元センサー（SENSOR-07）']);
  });

  it('選ぶと、接続の項目（プロトコル・ホスト・ポート・認証方式・ヘッダー名）を入力欄に写し、写した旨と、認証情報は入力し直す旨を表示する。認証情報は写さない（まだ保存していない）', async () => {
    const { calls } = renderApp('/settings/equipment', routes({}, COPY_SETTINGS));
    const form = await openChild();
    const section = within(form).getByTestId('equipment-connection');
    await waitFor(() => {
      expect(
        within(section).getByTestId<HTMLSelectElement>('equipment-connection-copy').options.length,
      ).toBeGreaterThan(1);
    });

    fireEvent.change(within(section).getByTestId('equipment-connection-copy'), {
      target: { value: 'ROBOT-07' },
    });

    expect(within(section).getByLabelText<HTMLInputElement>('ホスト', { exact: false }).value).toBe(
      'source.example.ac.jp',
    );
    expect(within(section).getByLabelText<HTMLInputElement>('ポート', { exact: false }).value).toBe(
      '9000',
    );
    expect(
      within(section).getByLabelText<HTMLSelectElement>('認証方式', { exact: false }).value,
    ).toBe('API_KEY');
    expect(
      within(section).getByLabelText<HTMLInputElement>('ヘッダー名', { exact: false }).value,
    ).toBe('X-Auth-Token');
    const copied = within(section).getByTestId('equipment-connection-copied').textContent;
    expect(copied).toContain('コピー元ロボット');
    expect(copied).toContain('まだ保存していません');
    expect(copied).toContain('認証情報は、写していません');
    // 認証情報の登録の欄・値は、写さない（保存のあとに、入力し直す）
    expect(within(section).queryByTestId('equipment-credentials')).toBeNull();
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-07/credentials')).toHaveLength(0);
    expect(calls.filter((call) => call.path.includes('/connection'))).toEqual([]);
  });

  it('コピーしたあと、登録（保存）すると、写した接続を、新しい設備の接続として保存する。コピー元の設備には、何も送らない', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes(
        {
          'POST /equipment': () => jsonResponse(SAVED_EQUIPMENT, 201),
          'PUT /ingestion/equipment/ROBOT-02/connection': () =>
            jsonResponse(connectionResponse({ equipmentId: 'ROBOT-02' })),
        },
        COPY_SETTINGS,
      ),
    );
    const form = await openChild();
    fillChild(form);
    const section = within(form).getByTestId('equipment-connection');
    await waitFor(() => {
      expect(
        within(section).getByTestId<HTMLSelectElement>('equipment-connection-copy').options.length,
      ).toBeGreaterThan(1);
    });
    fireEvent.change(within(section).getByTestId('equipment-connection-copy'), {
      target: { value: 'ROBOT-07' },
    });

    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    await screen.findByTestId('equipment-notice');
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-02/connection')[0]?.body).toEqual({
      connection: {
        type: 'HTTP',
        protocol: 'HTTPS',
        host: 'source.example.ac.jp',
        port: 9000,
        authMethod: 'API_KEY',
        apiKeyHeaderName: 'X-Auth-Token',
      },
    });
    expect(calls.filter((call) => call.path.includes('/ROBOT-07'))).toEqual([]);
  });

  it('コピーできる設備がなければ、選択欄を使えなくして、その旨を示す', async () => {
    renderApp('/settings/equipment', routes());
    const { section } = await openEditConnection();

    const select = within(section).getByTestId<HTMLSelectElement>('equipment-connection-copy');
    expect(select.disabled).toBe(true);
    expect(select.options[0]?.textContent).toContain('コピーできる設備');
  });
});

describe('設備ごとの接続を解除（接続を設定しない／共通の接続を使う）', () => {
  it('確認の文言を示し、キャンセルでは、何も送らない。確定すると、削除して、出どころ（共通／未設定）を反映する', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes({
        'DELETE /ingestion/equipment/ROBOT-01/connection': () =>
          jsonResponse({
            equipmentId: 'ROBOT-01',
            connectionOrigin: 'NONE',
            credentials: { state: 'NOT_REQUIRED' },
          }),
      }),
    );
    const { section } = await openEditConnection();

    fireEvent.click(within(section).getByTestId('equipment-connection-remove'));
    const confirm = within(section).getByTestId('equipment-connection-remove-confirm');
    expect(confirm.textContent).toContain('共通の接続があれば、それを使い');
    expect(confirm.textContent).toContain('接続先が設定されていません');
    fireEvent.click(within(confirm).getByRole('button', { name: 'キャンセル' }));
    expect(within(section).queryByTestId('equipment-connection-remove-confirm')).toBeNull();
    expect(callsOf(calls, 'DELETE', '/ingestion/equipment/ROBOT-01/connection')).toHaveLength(0);

    fireEvent.click(within(section).getByTestId('equipment-connection-remove'));
    fireEvent.click(within(section).getByTestId('equipment-connection-remove-yes'));

    expect((await within(section).findByTestId('equipment-connection-result')).textContent).toBe(
      '設備ごとの接続を解除しました',
    );
    expect(callsOf(calls, 'DELETE', '/ingestion/equipment/ROBOT-01/connection')).toHaveLength(1);
    // 解除のあと: 未設定。入力は空に戻り、解除のボタンは出ない（ダイアログは、閉じない）
    expect(within(section).getByTestId('equipment-connection-unset')).toBeDefined();
    expect(within(section).getByLabelText<HTMLInputElement>('ホスト', { exact: false }).value).toBe(
      '',
    );
    expect(within(section).queryByTestId('equipment-connection-remove')).toBeNull();
    expect(screen.getByTestId('equipment-edit')).toBeDefined();
  });

  it('解除のあと、共通の接続があれば、共通の接続を使う旨を示す（出どころ SHARED）', async () => {
    renderApp(
      '/settings/equipment',
      routes({
        'DELETE /ingestion/equipment/ROBOT-01/connection': () =>
          jsonResponse({
            equipmentId: 'ROBOT-01',
            connection: CONNECTION,
            connectionOrigin: 'SHARED',
            credentials: { state: 'CONFIGURED' },
          }),
      }),
    );
    const { section } = await openEditConnection();

    fireEvent.click(within(section).getByTestId('equipment-connection-remove'));
    fireEvent.click(within(section).getByTestId('equipment-connection-remove-yes'));

    expect(await within(section).findByTestId('equipment-connection-shared')).toBeDefined();
    expect(within(section).getByLabelText<HTMLInputElement>('ホスト', { exact: false }).value).toBe(
      'fileserver.example.ac.jp',
    );
  });

  it('解除に失敗したら、エラーを表示し、確認は残す', async () => {
    renderApp(
      '/settings/equipment',
      routes({
        'DELETE /ingestion/equipment/ROBOT-01/connection': () =>
          errorBody(500, 'INTERNAL_ERROR', '解除できませんでした'),
      }),
    );
    const { section } = await openEditConnection();

    fireEvent.click(within(section).getByTestId('equipment-connection-remove'));
    fireEvent.click(within(section).getByTestId('equipment-connection-remove-yes'));

    expect((await within(section).findByRole('alert')).textContent).toBe('解除できませんでした');
    expect(within(section).getByTestId('equipment-connection-remove-confirm')).toBeDefined();
  });

  it('登録のダイアログ（まだ設備がない）には、解除・接続テストのボタンを出さない', async () => {
    renderApp('/settings/equipment', routes());
    const form = await openChild();
    const section = within(form).getByTestId('equipment-connection');

    expect(within(section).queryByTestId('equipment-connection-remove')).toBeNull();
    expect(within(section).queryByRole('button', { name: '接続テスト' })).toBeNull();
  });
});

describe('その設備だけの接続テスト', () => {
  it('その設備の API を呼び、結果を表示する（成功は成功の表示、失敗は失敗の表示。接続先・認証情報は、サーバーが返す文言のまま）', async () => {
    let ok = true;
    const { calls } = renderApp(
      '/settings/equipment',
      routes({
        'POST /ingestion/equipment/ROBOT-01/test': () =>
          jsonResponse(
            ok
              ? { ok: true, message: '接続できました' }
              : {
                  ok: false,
                  message:
                    '接続できませんでした（認証情報が設定されていません）。接続先と認証情報の設定を確認してください',
                },
          ),
      }),
    );
    const { section } = await openEditConnection();

    fireEvent.click(within(section).getByRole('button', { name: '接続テスト' }));
    const success = await within(section).findByTestId('equipment-connection-result');
    expect(success.textContent).toBe('接続できました');
    expect(success.className).toContain('form-success');
    expect(callsOf(calls, 'POST', '/ingestion/equipment/ROBOT-01/test')).toHaveLength(1);

    ok = false;
    fireEvent.click(within(section).getByRole('button', { name: '接続テスト' }));
    await waitFor(() => {
      expect(within(section).getByTestId('equipment-connection-result').textContent).toContain(
        '認証情報が設定されていません',
      );
    });
    expect(within(section).getByTestId('equipment-connection-result').className).toContain(
      'form-error',
    );
  });

  it('接続テストの API が失敗したら、エラーを表示する', async () => {
    renderApp(
      '/settings/equipment',
      routes({
        'POST /ingestion/equipment/ROBOT-01/test': () =>
          errorBody(500, 'INTERNAL_ERROR', 'テストできませんでした'),
      }),
    );
    const { section } = await openEditConnection();

    fireEvent.click(within(section).getByRole('button', { name: '接続テスト' }));

    expect((await within(section).findByRole('alert')).textContent).toBe('テストできませんでした');
  });

  it('接続の入力を変更していて、まだ保存していないときは、先に保存するよう案内し、接続テストできない（テストは、保存済みの接続で行うため）', async () => {
    renderApp('/settings/equipment', routes());
    const { section } = await openEditConnection();

    expect(
      within(section).getByRole<HTMLButtonElement>('button', { name: '接続テスト' }).disabled,
    ).toBe(false);
    choose(section, 'ポート', '9999');

    expect(
      within(section).getByRole<HTMLButtonElement>('button', { name: '接続テスト' }).disabled,
    ).toBe(true);
    expect(within(section).getByTestId('equipment-connection-test-unsaved').textContent).toContain(
      '保存してから、接続テストをしてください',
    );
  });

  it('接続テストの実行中は、ボタンに実行中の表示を出し、使えなくする', async () => {
    let finish: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    renderApp(
      '/settings/equipment',
      routes({ 'POST /ingestion/equipment/ROBOT-01/test': () => pending }),
    );
    const { section } = await openEditConnection();

    fireEvent.click(within(section).getByRole('button', { name: '接続テスト' }));

    await waitFor(() => {
      expect(
        within(section).getByRole<HTMLButtonElement>('button', { name: '接続テスト中…' }).disabled,
      ).toBe(true);
    });
    finish(jsonResponse({ ok: true, message: '接続できました' }));
    await within(section).findByTestId('equipment-connection-result');
  });
});

describe('認証情報の登録（D-47。書き込み専用。設備ごと）', () => {
  it('状態を示す: 未設定・設定済み（更新日時つき）・確認できない。認証が不要（認証なし）・接続が未設定は、登録の欄を出さない', async () => {
    const view = renderApp('/settings/equipment', routes());
    let { section } = await openEditConnection();
    expect(within(section).getByTestId('equipment-credentials-status').textContent).toContain(
      '未設定',
    );
    view.unmount();

    renderApp(
      '/settings/equipment',
      routes(
        {},
        settings([status({ credentials: { state: 'CONFIGURED', updatedAt: UPDATED_AT } })]),
      ),
    );
    ({ section } = await openEditConnection());
    const configured = within(section).getByTestId('equipment-credentials-status').textContent;
    expect(configured).toContain('設定済み');
    expect(configured).toContain('2026');
  });

  it('状態を確認できないとき・認証が不要のとき', async () => {
    const view = renderApp(
      '/settings/equipment',
      routes({}, settings([status({ credentials: { state: 'UNAVAILABLE' } })])),
    );
    let { section } = await openEditConnection();
    expect(within(section).getByTestId('equipment-credentials-status').textContent).toContain(
      '確認できません',
    );
    view.unmount();

    renderApp(
      '/settings/equipment',
      routes(
        {},
        settings([
          status({
            connection: { ...BASIC, authMethod: 'NONE' },
            credentials: { state: 'NOT_REQUIRED' },
          }),
        ]),
      ),
    );
    ({ section } = await openEditConnection());
    expect(within(section).queryByTestId('equipment-credentials')).toBeNull();
    expect(within(section).queryByTestId('equipment-connection-credentials-note')).toBeNull();
  });

  it('Basic: ユーザー名とパスワード（伏せ字）を入力して保存する。設備の認証情報の API に、値を送り、入力欄を空に戻し、画面に値を残さない', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes({
        'PUT /ingestion/equipment/ROBOT-01/credentials': () =>
          jsonResponse({ state: 'CONFIGURED', updatedAt: UPDATED_AT }),
      }),
    );
    const { section } = await openEditConnection();
    const settingsCalls = callsOf(calls, 'GET', '/ingestion/settings').length;
    const password = within(section).getByLabelText<HTMLInputElement>('パスワード', {
      exact: false,
    });
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('new-password');

    fireEvent.change(within(section).getByLabelText('ユーザー名', { exact: false }), {
      target: { value: 'dummy-user' },
    });
    fireEvent.change(password, { target: { value: DUMMY_PASSWORD } });
    fireEvent.click(within(section).getByRole('button', { name: '認証情報を保存' }));

    expect((await within(section).findByTestId('equipment-connection-result')).textContent).toBe(
      '認証情報を保存しました',
    );
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-01/credentials')[0]?.body).toEqual({
      authMethod: 'BASIC',
      username: 'dummy-user',
      password: DUMMY_PASSWORD,
    });
    expect(within(section).getByTestId('equipment-credentials-status').textContent).toContain(
      '設定済み',
    );
    expect(
      within(section).getByLabelText<HTMLInputElement>('パスワード', { exact: false }).value,
    ).toBe('');
    expect(
      within(section).getByLabelText<HTMLInputElement>('ユーザー名', { exact: false }).value,
    ).toBe('');
    expect(document.body.innerHTML).not.toContain(DUMMY_PASSWORD);
    // 取り込み設定・状況を読み直す
    await waitFor(() => {
      expect(callsOf(calls, 'GET', '/ingestion/settings').length).toBeGreaterThan(settingsCalls);
    });
    // ダイアログは、閉じない（設備は、保存していない）
    expect(screen.getByTestId('equipment-edit')).toBeDefined();
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(0);
  });

  it('Bearer・API キー: トークン・API キーの入力は、伏せ字で、保存して、送る', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes(
        {
          'PUT /ingestion/equipment/ROBOT-01/credentials': () =>
            jsonResponse({ state: 'CONFIGURED' }),
          'PUT /ingestion/equipment/SENSOR-01/credentials': () =>
            jsonResponse({ state: 'CONFIGURED' }),
        },
        settings(
          [status({ connection: BEARER })],
          [
            status({
              equipmentId: 'SENSOR-01',
              name: '環境センサー1',
              connection: CONNECTION,
            }),
          ],
        ),
      ),
    );
    let { form, section } = await openEditConnection(1);
    const token = within(section).getByLabelText<HTMLInputElement>('トークン', { exact: false });
    expect(token.type).toBe('password');
    fireEvent.change(token, { target: { value: 'dummy-token' } });
    fireEvent.click(within(section).getByRole('button', { name: '認証情報を保存' }));
    await within(section).findByTestId('equipment-connection-result');
    fireEvent.click(within(form).getByRole('button', { name: 'キャンセル' }));

    ({ form, section } = await openEditConnection(2));
    const apiKey = within(section).getByLabelText<HTMLInputElement>('API キー', { exact: true });
    expect(apiKey.type).toBe('password');
    fireEvent.change(apiKey, { target: { value: 'dummy-api-key' } });
    fireEvent.click(within(section).getByRole('button', { name: '認証情報を保存' }));
    await within(section).findByTestId('equipment-connection-result');

    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-01/credentials')[0]?.body).toEqual({
      authMethod: 'BEARER',
      token: 'dummy-token',
    });
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/SENSOR-01/credentials')[0]?.body).toEqual({
      authMethod: 'API_KEY',
      apiKey: 'dummy-api-key',
    });
  });

  it('認証情報の欄で Enter を押すと、設備のフォームは送らず、認証情報を保存する。入力が足りないときは、保存せず、設備のフォームも送らない。Enter 以外のキーは、何もしない', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes({
        'PUT /ingestion/equipment/ROBOT-01/credentials': () =>
          jsonResponse({ state: 'CONFIGURED', updatedAt: UPDATED_AT }),
      }),
    );
    const { section } = await openEditConnection();
    const user = within(section).getByLabelText('ユーザー名', { exact: false });
    const password = within(section).getByLabelText('パスワード', { exact: false });

    // 入力が足りない（ユーザー名だけ）: Enter でも、保存しない
    fireEvent.change(user, { target: { value: 'dummy-user' } });
    fireEvent.keyDown(user, { key: 'Enter' });
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-01/credentials')).toHaveLength(0);
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(0);

    // Enter 以外のキーは、何もしない
    fireEvent.change(password, { target: { value: DUMMY_PASSWORD } });
    fireEvent.keyDown(password, { key: 'a' });
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-01/credentials')).toHaveLength(0);

    // 入力がそろって Enter: 認証情報を保存する（設備のフォームは、送らない）
    fireEvent.keyDown(password, { key: 'Enter' });
    await waitFor(() => {
      expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-01/credentials')).toHaveLength(1);
    });
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(0);
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
    const { calls } = renderApp('/settings/equipment', routes());
    const { section } = await openEditConnection();

    for (const [label, value] of Object.entries(values)) {
      fireEvent.change(within(section).getByLabelText(label, { exact: false }), {
        target: { value },
      });
    }
    fireEvent.click(within(section).getByRole('button', { name: '認証情報を保存' }));

    expect(await within(section).findByText(message)).toBeDefined();
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-01/credentials')).toHaveLength(0);
  });

  it('トークンに空白を含むときは、送らず、エラーを表示する', async () => {
    const { calls } = renderApp(
      '/settings/equipment',
      routes({}, settings([status({ connection: BEARER })])),
    );
    const { section } = await openEditConnection();

    fireEvent.change(within(section).getByLabelText('トークン', { exact: false }), {
      target: { value: 'dummy token' },
    });
    fireEvent.click(within(section).getByRole('button', { name: '認証情報を保存' }));

    expect(
      await within(section).findByText('英数字と記号だけで入力してください', { exact: false }),
    ).toBeDefined();
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-01/credentials')).toHaveLength(0);
  });

  it('サーバーが項目のエラーを返したら、その項目に表示する。入力は、そのまま残す（再入力させない）', async () => {
    renderApp(
      '/settings/equipment',
      routes(
        {
          'PUT /ingestion/equipment/ROBOT-01/credentials': () =>
            errorBody(400, 'VALIDATION_ERROR', '入力内容に誤りがあります', [
              { name: 'authMethod', message: '認証方式が、保存済みの接続と違います' },
            ]),
        },
        settings([status({ connection: BEARER })]),
      ),
    );
    const { section } = await openEditConnection();
    const token = within(section).getByLabelText<HTMLInputElement>('トークン', { exact: false });

    fireEvent.change(token, { target: { value: 'dummy-token' } });
    fireEvent.click(within(section).getByRole('button', { name: '認証情報を保存' }));

    expect(await within(section).findByText('認証方式が、保存済みの接続と違います')).toBeDefined();
    expect(token.value).toBe('dummy-token');
  });

  it('認証方式を変えて、まだ保存していないときは、先に設備を保存するよう案内し、登録できない', async () => {
    renderApp('/settings/equipment', routes({}, settings([status({ connection: BEARER })])));
    const { section } = await openEditConnection();

    choose(section, '認証方式', 'BASIC');

    expect(within(section).getByTestId('equipment-credentials-unsaved').textContent).toContain(
      '先に設備を保存',
    );
    expect(
      within(section).getByRole<HTMLButtonElement>('button', { name: '認証情報を保存' }).disabled,
    ).toBe(true);
  });

  it('接続がない設備で、認証方式を選んだだけ（未保存）のときは、登録の欄を出さず、接続を保存したあとに登録できる旨を案内する', async () => {
    renderApp(
      '/settings/equipment',
      routes(
        {},
        settings([
          status({
            connection: undefined,
            connectionOrigin: 'NONE',
            credentials: { state: 'NOT_REQUIRED' },
          }),
        ]),
      ),
    );
    const { section } = await openEditConnection();

    choose(section, '認証方式', 'BASIC');

    expect(within(section).queryByRole('button', { name: '認証情報を保存' })).toBeNull();
    expect(
      within(section).getByTestId('equipment-connection-credentials-note').textContent,
    ).toContain('接続を保存したあとに、登録できます');
  });
});

describe('設備のダイアログの案内（SC-10-5・SC-10-9・取り込みの対象）', () => {
  it('設備 ID の決め方（使える文字・先頭・長さ・登録後は変更できない）を、登録のダイアログ（ハウス・ロボット・環境センサー）に示す。修正のダイアログには、示さない（SC-10-5）', async () => {
    renderApp('/settings/equipment', routes());
    await screen.findAllByTestId('equipment-row');

    fireEvent.click(screen.getByRole('button', { name: 'ハウスの登録' }));
    const rule = within(screen.getByRole('form', { name: 'ハウスを登録' })).getByTestId(
      'equipment-id-rule',
    );
    expect(rule.textContent).toContain('英数字・ハイフン（-）・アンダースコア（_）');
    expect(rule.textContent).toContain('先頭は英数字');
    expect(rule.textContent).toContain('100 文字以内');
    expect(rule.textContent).toContain('登録後は、変更できません');
    fireEvent.click(
      within(screen.getByRole('form', { name: 'ハウスを登録' })).getByRole('button', {
        name: 'キャンセル',
      }),
    );

    const child = await openChild();
    expect(within(child).getByTestId('equipment-id-rule').textContent).toContain('100 文字以内');
    fireEvent.click(within(child).getByRole('button', { name: 'キャンセル' }));

    const edit = await openEdit();
    expect(within(edit).queryByTestId('equipment-id-rule')).toBeNull();
  });

  it('ファイルのパスの近くに、「ファイルのパスを設定すると、取り込みの対象になる。接続も設定すること」の案内を示す（ロボット・環境センサーのダイアログ。ハウスにはない）', async () => {
    renderApp('/settings/equipment', routes());
    const child = await openChild();
    expect(within(child).getByTestId('equipment-file-path-guide').textContent).toContain(
      'ファイルのパスを設定すると、取り込みの対象になります',
    );
    expect(within(child).getByTestId('equipment-file-path-guide').textContent).toContain(
      '「取り込み元の接続」も設定してください',
    );
    fireEvent.click(within(child).getByRole('button', { name: 'キャンセル' }));

    const robot = await openEdit(1);
    expect(within(robot).getByTestId('equipment-file-path-guide')).toBeDefined();
    fireEvent.click(within(robot).getByRole('button', { name: 'キャンセル' }));

    const house = await openEdit(0);
    expect(within(house).queryByTestId('equipment-file-path-guide')).toBeNull();
  });

  it('ハウスを登録したあと、「ロボット・環境センサーを登録」の案内を示し、押すと、ロボット・環境センサーの登録のダイアログを開く（SC-10-9）', async () => {
    renderApp('/settings/equipment', {
      ...routes(),
      'POST /equipment': () => jsonResponse(SAVED_EQUIPMENT, 201),
    });
    await screen.findAllByTestId('equipment-row');
    fireEvent.click(screen.getByRole('button', { name: 'ハウスの登録' }));
    const form = screen.getByRole('form', { name: 'ハウスを登録' });
    choose(form, '設備ID', 'HOUSE-02');
    choose(form, '名称', 'ハウス2');
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('登録しました');
    const next = screen.getByTestId('equipment-next-step');
    expect(next.textContent).toContain('続けて、ロボット・環境センサーを登録できます');
    fireEvent.click(within(next).getByTestId('equipment-next-register-child'));

    expect(screen.getByRole('dialog', { name: 'ロボット・環境センサーを登録' })).toBeDefined();
    // 案内は、ダイアログを開いたら、消える
    expect(screen.queryByTestId('equipment-next-step')).toBeNull();
  });

  it('ロボット・環境センサーを登録したあと、「データ入力へ」のリンクを示す。修正のあとには、案内を示さない（SC-10-9）', async () => {
    renderApp('/settings/equipment', {
      ...routes(),
      'POST /equipment': () => jsonResponse(SAVED_EQUIPMENT, 201),
    });
    const form = await openChild();
    fillChild(form);
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    await screen.findByTestId('equipment-notice');
    const next = screen.getByTestId('equipment-next-step');
    expect(next.textContent).toContain('ロボット・環境センサーを登録しました');
    expect(within(next).getByRole('link', { name: 'データ入力へ' }).getAttribute('href')).toBe(
      '/data-entry',
    );

    const edit = await openEdit();
    expect(screen.queryByTestId('equipment-next-step')).toBeNull();
    fireEvent.click(within(edit).getByRole('button', { name: '保存' }));
    await screen.findByTestId('equipment-notice');
    expect(screen.queryByTestId('equipment-next-step')).toBeNull();
  });

  it('取り込み設定・状況からのリンク（?edit=設備 ID）で、その設備の修正のダイアログを開く。閉じると、URL の指定を外す', async () => {
    renderApp('/settings/equipment?edit=ROBOT-01', routes());

    const form = await screen.findByTestId('equipment-edit');
    expect(screen.getByRole('dialog', { name: /ロボット（ROBOT-01）を修正/ })).toBeDefined();
    await connectionOf(form);

    fireEvent.click(within(form).getByRole('button', { name: 'キャンセル' }));

    expect(screen.queryByTestId('equipment-edit')).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('設備を変更する権限がなければ、?edit= の指定があっても、ダイアログを開かない', async () => {
    renderApp('/settings/equipment?edit=ROBOT-01', routes(), {
      login: loginWith(['ingestion:read']),
    });
    await screen.findAllByTestId('equipment-row');

    expect(screen.queryByTestId('equipment-edit')).toBeNull();
  });
});
