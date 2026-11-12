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

function source(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'robot',
    kind: 'ROBOT',
    profileId: 'robot-v1',
    connectionRef: 'file-server-main',
    isEnabled: true,
    formatProfile: { versionLabel: 'v0.1', status: 'PROVISIONAL' },
    lastStartedAt: '2026-10-09T02:00:00.000Z',
    lastSuccessAt: '2026-10-09T01:00:00.000Z',
    equipment: [
      {
        equipmentId: 'ROBOT-1',
        name: '収穫ロボット1',
        lastStartedAt: '2026-10-09T02:00:00.000Z',
        lastResult: 'FAILURE',
        lastSuccessAt: '2026-10-09T01:00:00.000Z',
        lastDataAt: '2026-10-09T00:30:00.000Z',
      },
      {
        equipmentId: 'ROBOT-2',
        name: '収穫ロボット2',
        lastStartedAt: null,
        lastResult: null,
        lastSuccessAt: null,
        lastDataAt: null,
      },
    ],
    isRunning: false,
    ...overrides,
  };
}

const SETTINGS = {
  sources: [
    source(),
    source({
      sourceId: 'environment-sensor',
      kind: 'SENSOR',
      isEnabled: false,
      lastStartedAt: null,
      lastSuccessAt: null,
      equipment: [
        {
          equipmentId: 'SENSOR-1',
          name: '環境センサー1',
          lastStartedAt: null,
          lastResult: null,
          lastSuccessAt: null,
          lastDataAt: null,
        },
      ],
      formatProfile: { versionLabel: 'v1.0', status: 'CONFIRMED' },
    }),
    source({ sourceId: 'custom-source', isRunning: true, equipment: [] }),
  ],
};

function ingestionLog(overrides: Record<string, unknown> = {}) {
  return {
    logId: 'l-1',
    sourceId: 'robot',
    equipmentId: 'ROBOT-1',
    startedAt: '2026-10-09T02:00:00.000Z',
    finishedAt: '2026-10-09T02:00:05.000Z',
    result: 'SUCCESS',
    filesProcessed: 2,
    recordCount: 10,
    rejectedCount: 1,
    attempts: 1,
    ...overrides,
  };
}

const QUEUE = { PENDING: 1, SENT: 2, FAILED: 3, HELD: 4, EXPIRED: 5 };

function federationLog(overrides: Record<string, unknown> = {}) {
  return {
    logId: 'f-1',
    occurredAt: '2026-10-09T02:00:00.000Z',
    result: 'SENT',
    itemCount: 5,
    ...overrides,
  };
}

function baseRoutes(extra: Routes = {}): Routes {
  return {
    'GET /ingestion/settings': () => jsonResponse(SETTINGS),
    'GET /ingestion/logs': () =>
      jsonResponse({
        items: [
          ingestionLog(),
          ingestionLog({
            logId: 'l-2',
            result: 'FAILURE',
            errorMessage: '接続できませんでした',
            sourceId: 'unknown-src',
            // 設備に結びつかないログ（取り込み元単位）
            equipmentId: undefined,
            deletedEquipmentCount: 2,
          }),
        ],
        nextCursor: null,
      }),
    'GET /federation/logs': () =>
      jsonResponse({
        items: [
          federationLog(),
          federationLog({ logId: 'f-2', result: 'HELD', message: '連携先が停止中です' }),
        ],
        nextCursor: null,
        queue: QUEUE,
      }),
    ...extra,
  };
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

function buttonOf(scope: HTMLElement, name: string): HTMLButtonElement {
  return within(scope).getByRole<HTMLButtonElement>('button', { name });
}

function card(sourceId: string): HTMLElement {
  return screen.getByTestId(`source-${sourceId}`);
}

describe('取り込み設定・状況（UC-15・UC-16。SC-11）', () => {
  it('取り込み元ごとに、設定（接続先の参照名・有効）と、解釈に使う仕様の版・状態、最終の実行・成功を表示する', async () => {
    renderApp('/settings/ingestion', baseRoutes());

    const robot = await screen.findByTestId('source-robot');
    expect(within(robot).getByRole('heading', { name: 'ロボットデータ' })).toBeDefined();
    expect(robot.textContent).toContain('v0.1（仮決め）');
    expect(within(robot).getByLabelText<HTMLInputElement>('接続先', { exact: false }).value).toBe(
      'file-server-main',
    );
    // 取得間隔は、設備ごとの設定（設備管理。Issue #197）。この画面には、入力欄を出さず、案内を示す
    expect(within(robot).queryByLabelText('取得間隔', { exact: false })).toBeNull();
    expect(screen.getByTestId('interval-moved-robot').textContent).toBe(
      '取得間隔は、設備ごとに、設備管理で設定します',
    );
    expect(within(robot).getByRole<HTMLInputElement>('checkbox').checked).toBe(true);
    expect(screen.getByTestId('last-started-robot').textContent).toContain('2026');

    const sensor = card('environment-sensor');
    expect(sensor.textContent).toContain('v1.0（確定）');
    expect(screen.getByTestId('last-started-environment-sensor').textContent).toBe(
      'まだ実行していません',
    );
    expect(screen.getByTestId('last-success-environment-sensor').textContent).toBe(
      'まだ実行していません',
    );
    expect(within(sensor).getByRole<HTMLInputElement>('checkbox').checked).toBe(false);

    // 未知の取り込み元は、識別子のまま。実行中は、その旨を示し、操作できない
    const custom = card('custom-source');
    expect(within(custom).getByRole('heading', { name: 'custom-source' })).toBeDefined();
    expect(custom.textContent).toContain('実行中');
    expect(
      within(custom).getByRole<HTMLButtonElement>('button', { name: '取得中…' }).disabled,
    ).toBe(true);
    expect(
      within(custom).getByRole<HTMLButtonElement>('button', { name: '設定を保存' }).disabled,
    ).toBe(true);
  });

  it('連携の記録の「期限切れ」（破棄の期限を過ぎて破棄した）と、連携キューの期限切れの件数を表示する（#204）', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'GET /federation/logs': () =>
          jsonResponse({
            items: [
              federationLog({
                logId: 'f-3',
                result: 'EXPIRED',
                itemCount: 7,
                message: '連携の期限（30 日）を過ぎた項目を、破棄しました',
              }),
            ],
            nextCursor: null,
            queue: QUEUE,
          }),
      }),
    );

    const [row] = await screen.findAllByTestId('federation-log-row');

    expect(row?.getAttribute('data-result')).toBe('EXPIRED');
    expect(row?.textContent).toContain('期限切れ');
    expect(row?.textContent).toContain('連携の期限（30 日）を過ぎた項目を、破棄しました');
    expect(screen.getByTestId('queue-EXPIRED').textContent).toContain('期限切れ');
    expect(screen.getByTestId('queue-EXPIRED').textContent).toContain('5');
  });

  it('取り込みのログ（日時・取り込み元・結果・件数・エラー内容）と、連携の状況（キューの件数・結果の記録）を表示する', async () => {
    renderApp('/settings/ingestion', baseRoutes());

    const logRows = await screen.findAllByTestId('ingestion-log-row');
    expect(logRows[0]?.getAttribute('data-result')).toBe('SUCCESS');
    expect(logRows[0]?.textContent).toContain('ロボットデータ');
    // 設備の名前（設備に結びつかないログは、「—」）
    expect(logRows[0]?.querySelectorAll('td')[2]?.textContent).toBe('収穫ロボット1');
    expect(logRows[0]?.querySelectorAll('td')[7]?.textContent).toBe('—');
    expect(logRows[0]?.querySelectorAll('td')[8]?.textContent).toBe('—');
    expect(logRows[1]?.querySelectorAll('td')[2]?.textContent).toBe('—');
    // 削除済みの設備のレコードの数（取り込み元単位のログにある場合）
    expect(logRows[1]?.querySelectorAll('td')[7]?.textContent).toBe('2');
    expect(logRows[1]?.textContent).toContain('unknown-src');
    expect(logRows[1]?.textContent).toContain('接続できませんでした');

    const federationRows = await screen.findAllByTestId('federation-log-row');
    expect(federationRows).toHaveLength(2);
    expect(federationRows[0]?.textContent).toContain('成功');
    expect(federationRows[0]?.querySelectorAll('td')[3]?.textContent).toBe('—');
    expect(federationRows[1]?.textContent).toContain('保留');
    expect(federationRows[1]?.textContent).toContain('連携先が停止中です');
    expect(screen.getByTestId('queue-PENDING').textContent).toContain('1');
    expect(screen.getByTestId('queue-HELD').textContent).toContain('4');
  });

  it('ログの表の各セルに、項目名（data-label）を持つ。狭い画面（900px 以下）では、表をログ 1 件ごとのカードにして、項目名を表示するため', async () => {
    renderApp('/settings/ingestion', baseRoutes());

    const [logRow] = await screen.findAllByTestId('ingestion-log-row');
    const [federationRow] = await screen.findAllByTestId('federation-log-row');

    const labelsOf = (row: HTMLElement | undefined) =>
      [...(row?.querySelectorAll('td') ?? [])].map((cell) => cell.getAttribute('data-label'));
    expect(labelsOf(logRow)).toEqual([
      '日時',
      '取り込み元',
      '設備',
      '結果',
      'ファイル数',
      '取得件数',
      '読み取れなかった数',
      '削除済みの設備',
      'エラー内容',
    ]);
    expect(labelsOf(federationRow)).toHaveLength(4);
    expect(labelsOf(federationRow).every((label) => label !== null && label !== '')).toBe(true);
  });

  it('ログ・連携の記録がなければ、その旨を表示する', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'GET /ingestion/logs': () => jsonResponse({ items: [], nextCursor: null }),
        'GET /federation/logs': () => jsonResponse({ items: [], nextCursor: null, queue: QUEUE }),
      }),
    );
    expect((await screen.findByTestId('ingestion-logs-empty')).textContent).toBe(
      '取り込みのログはありません',
    );
    expect((await screen.findByTestId('federation-logs-empty')).textContent).toBe(
      '連携の記録はありません',
    );
  });

  it('閲覧の権限（ingestion:read）がなければ（一般）、取り込みの設定・ログ・連携のログを取得せず、ハウス別の記録を表示する（#332）', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      baseRoutes({
        'GET /ingestion/facility-logs': () => jsonResponse({ items: [], nextCursor: null }),
        'GET /federation/facility-logs': () => jsonResponse({ items: [], nextCursor: null }),
      }),
      { login: READ_ONLY_LOGIN },
    );

    expect((await screen.findByTestId('facility-ingestion')).textContent).toContain(
      '取り込みの記録',
    );
    expect(screen.queryByTestId('source-robot')).toBeNull();
    expect(screen.queryByTestId('permission-notice')).toBeNull();
    expect(calls.filter((call) => call.path.startsWith('/ingestion/settings'))).toEqual([]);
    expect(calls.filter((call) => call.path === '/ingestion/logs')).toEqual([]);
    expect(calls.filter((call) => call.path === '/federation/logs')).toEqual([]);
  });

  it('閲覧の権限だけがあれば、参照のみ（入力欄は変更できず、保存・接続テスト・即時取得の操作を表示しない）', async () => {
    renderApp('/settings/ingestion', baseRoutes(), { login: loginWith(['ingestion:read']) });
    const robot = await screen.findByTestId('source-robot');
    expect(screen.getByTestId('permission-notice').textContent).toContain('権限がありません');
    expect(
      within(robot).getByLabelText<HTMLInputElement>('接続先', { exact: false }).readOnly,
    ).toBe(true);
    expect(within(robot).queryByRole('button', { name: '設定を保存' })).toBeNull();
    expect(within(robot).queryByRole('button', { name: '即時取得' })).toBeNull();
  });

  it('設定の権限だけがある場合は、保存だけできる。実行の権限だけがある場合は、接続テスト・即時取得だけできる', async () => {
    const view = renderApp('/settings/ingestion', baseRoutes(), {
      login: loginWith(['ingestion:read', 'ingestion:configure']),
    });
    const robot = await screen.findByTestId('source-robot');
    expect(within(robot).getByRole('button', { name: '設定を保存' })).toBeDefined();
    expect(within(robot).queryByRole('button', { name: '接続テスト' })).toBeNull();
    view.unmount();

    renderApp('/settings/ingestion', baseRoutes(), {
      login: loginWith(['ingestion:read', 'ingestion:run']),
    });
    const robotRun = await screen.findByTestId('source-robot');
    expect(within(robotRun).queryByRole('button', { name: '設定を保存' })).toBeNull();
    expect(within(robotRun).getByRole('button', { name: '接続テスト' })).toBeDefined();
    expect(within(robotRun).getByRole('button', { name: '即時取得' })).toBeDefined();
  });

  it('設定の保存: 接続先の参照名・有効を送る（取得間隔は、送らない）。不正な参照名は、保存しない', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      baseRoutes({ 'PUT /ingestion/settings': () => jsonResponse(SETTINGS) }),
    );
    const robot = await screen.findByTestId('source-robot');

    fireEvent.change(within(robot).getByLabelText('接続先', { exact: false }), {
      target: { value: '' },
    });
    fireEvent.click(within(robot).getByRole('button', { name: '設定を保存' }));
    expect(await within(robot).findByText('接続先の参照名を入力してください')).toBeDefined();
    fireEvent.change(within(robot).getByLabelText('接続先', { exact: false }), {
      target: { value: 'bad name!' },
    });
    fireEvent.click(within(robot).getByRole('button', { name: '設定を保存' }));
    expect(
      await within(robot).findByText('接続先の参照名は英数字・記号（_ . -）のみ使えます'),
    ).toBeDefined();
    expect(callsOf(calls, 'PUT', '/ingestion/settings')).toHaveLength(0);

    fireEvent.change(within(robot).getByLabelText('接続先', { exact: false }), {
      target: { value: 'file-server-sub' },
    });
    fireEvent.click(within(robot).getByRole('checkbox'));
    fireEvent.click(within(robot).getByRole('button', { name: '設定を保存' }));

    expect((await screen.findByTestId('result-robot')).textContent).toBe('設定を保存しました');
    expect(callsOf(calls, 'PUT', '/ingestion/settings')[0]?.body).toEqual({
      sources: [
        {
          sourceId: 'robot',
          connectionRef: 'file-server-sub',
          isEnabled: false,
        },
      ],
    });
  });

  it('設定の保存で、サーバーが項目ごとのエラーを返したら、その項目に表示する', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'PUT /ingestion/settings': () =>
          errorBody(422, 'VALIDATION_ERROR', '入力内容を確認してください', [
            { name: 'sources.0.connectionRef', message: '接続先の参照名を確認してください' },
          ]),
      }),
    );
    const robot = await screen.findByTestId('source-robot');
    fireEvent.click(within(robot).getByRole('button', { name: '設定を保存' }));
    expect(await within(robot).findByText('接続先の参照名を確認してください')).toBeDefined();
  });

  it('即時取得: 削除済みの設備のレコードがあれば、「削除済みの設備の記録 N 件」を、読み取れなかった記録と別に示す（0 件のときは示さない。Issue #231）', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/robot/run': () =>
          jsonResponse({
            sourceId: 'robot',
            result: 'SUCCESS',
            filesProcessed: 1,
            recordCount: 4,
            rejectedCount: 0,
            deletedEquipmentCount: 2,
            attempts: 1,
          }),
      }),
    );
    const robot = await screen.findByTestId('source-robot');

    fireEvent.click(within(robot).getByRole('button', { name: '即時取得' }));

    expect((await screen.findByTestId('result-robot')).textContent).toBe(
      '取得しました（成功）: ファイル 1 件、取り込み 4 件、読み取れなかった記録 0 件、削除済みの設備の記録 2 件',
    );
  });

  it('接続テスト: 結果のメッセージを示す（成功は成功の表示、失敗は失敗の表示）', async () => {
    let ok = true;
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/robot/test': () =>
          jsonResponse(
            ok
              ? { ok: true, message: '接続できました' }
              : { ok: false, message: '接続できませんでした' },
          ),
      }),
    );
    const robot = await screen.findByTestId('source-robot');

    fireEvent.click(within(robot).getByRole('button', { name: '接続テスト' }));
    const success = await screen.findByTestId('result-robot');
    expect(success.textContent).toBe('接続できました');
    expect(success.className).toContain('form-success');

    ok = false;
    fireEvent.click(within(robot).getByRole('button', { name: '接続テスト' }));
    await waitFor(() => {
      expect(screen.getByTestId('result-robot').textContent).toBe('接続できませんでした');
    });
    expect(screen.getByTestId('result-robot').className).toContain('form-error');
  });

  it('接続テストに失敗した場合（API のエラー）は、エラーを表示する', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/robot/test': () =>
          errorBody(500, 'INTERNAL_ERROR', 'テストできませんでした'),
      }),
    );
    const robot = await screen.findByTestId('source-robot');
    fireEvent.click(within(robot).getByRole('button', { name: '接続テスト' }));
    expect((await within(robot).findByRole('alert')).textContent).toBe('テストできませんでした');
  });

  it.each([
    ['SUCCESS', '成功', 'form-success'],
    ['PARTIAL', '一部成功', 'form-success'],
    ['FAILURE', '失敗', 'form-error'],
  ])(
    '即時取得（%s）: 結果と件数を示し、ログ・連携の状況を読み直す',
    async (result, label, className) => {
      const { calls } = renderApp(
        '/settings/ingestion',
        baseRoutes({
          'POST /ingestion/robot/run': () =>
            jsonResponse({
              sourceId: 'robot',
              result,
              filesProcessed: 2,
              recordCount: 10,
              rejectedCount: 3,
              attempts: 1,
            }),
        }),
      );
      const robot = await screen.findByTestId('source-robot');
      const logCalls = callsOf(calls, 'GET', '/ingestion/logs').length;

      fireEvent.click(within(robot).getByRole('button', { name: '即時取得' }));

      const message = await screen.findByTestId('result-robot');
      expect(message.textContent).toBe(
        `取得しました（${label}）: ファイル 2 件、取り込み 10 件、読み取れなかった記録 3 件`,
      );
      expect(message.className).toContain(className);
      await waitFor(() => {
        expect(callsOf(calls, 'GET', '/ingestion/logs').length).toBeGreaterThan(logCalls);
      });
    },
  );

  it('即時取得に失敗した場合（API のエラー）は、エラーを表示し、状況を読み直す', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/robot/run': () => errorBody(409, 'CONFLICT', '取り込みを実行中です'),
      }),
    );
    const robot = await screen.findByTestId('source-robot');
    fireEvent.click(within(robot).getByRole('button', { name: '即時取得' }));
    expect((await within(robot).findByRole('alert')).textContent).toBe('取り込みを実行中です');
  });

  it('操作の実行中は、実行している操作のボタンだけに、実行中の表示を出す（ほかのボタンは、名称のまま使えなくする）', async () => {
    let finish: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/robot/run': () => pending,
        'POST /ingestion/robot/test': () => pending,
        'PUT /ingestion/settings': () => pending,
      }),
    );
    const robot = await screen.findByTestId('source-robot');

    // 即時取得の実行中: 接続テストのボタンに「接続テスト中」と出さない
    fireEvent.click(within(robot).getByRole('button', { name: '即時取得' }));
    await waitFor(() => {
      expect(buttonOf(robot, '取得中…').disabled).toBe(true);
    });
    expect(buttonOf(robot, '接続テスト').disabled).toBe(true);
    expect(buttonOf(robot, '設定を保存').disabled).toBe(true);
    finish(
      jsonResponse({
        sourceId: 'robot',
        result: 'SUCCESS',
        filesProcessed: 0,
        recordCount: 0,
        rejectedCount: 0,
        attempts: 1,
      }),
    );
    await screen.findByTestId('result-robot');
  });

  it('接続テストの実行中は、接続テストのボタンだけに「接続テスト中」と出す。設定の保存の実行中は、どのボタンにも出さない', async () => {
    let finishTest: (response: Response) => void = () => undefined;
    const pendingTest = new Promise<Response>((resolve) => {
      finishTest = resolve;
    });
    let finishSave: (response: Response) => void = () => undefined;
    const pendingSave = new Promise<Response>((resolve) => {
      finishSave = resolve;
    });
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/robot/test': () => pendingTest,
        'PUT /ingestion/settings': () => pendingSave,
      }),
    );
    const robot = await screen.findByTestId('source-robot');

    fireEvent.click(within(robot).getByRole('button', { name: '接続テスト' }));
    await waitFor(() => {
      expect(buttonOf(robot, '接続テスト中…').disabled).toBe(true);
    });
    expect(buttonOf(robot, '即時取得').disabled).toBe(true);
    finishTest(jsonResponse({ ok: true, message: '接続できました' }));
    await screen.findByTestId('result-robot');

    fireEvent.click(within(robot).getByRole('button', { name: '設定を保存' }));
    await waitFor(() => {
      expect(buttonOf(robot, '接続テスト').disabled).toBe(true);
    });
    expect(within(robot).queryByRole('button', { name: '接続テスト中…' })).toBeNull();
    finishSave(jsonResponse(SETTINGS));
    await waitFor(() => {
      expect(buttonOf(robot, '接続テスト').disabled).toBe(false);
    });
  });

  it('ログは、設備・結果・期間（日本時間の日付）で絞り込める。API の条件と URL に反映し、1 ページ 20 件', async () => {
    const { calls } = renderApp('/settings/ingestion', baseRoutes());
    await screen.findAllByTestId('ingestion-log-row');
    const section = screen.getByTestId('ingestion-logs');
    const lastQuery = () => callsOf(calls, 'GET', '/ingestion/logs').at(-1)?.query;
    expect(lastQuery()?.get('limit')).toBe('20');

    // 設備の選択肢は、取り込み元の設備（設定・状況の応答の、設備ごとの一覧）
    const equipment = within(section).getByLabelText<HTMLSelectElement>('設備');
    expect([...equipment.options].map((option) => option.textContent)).toEqual([
      'すべて',
      '収穫ロボット1',
      '収穫ロボット2',
      '環境センサー1',
    ]);
    fireEvent.change(equipment, { target: { value: 'ROBOT-1' } });
    await waitFor(() => {
      expect(lastQuery()?.get('equipmentId')).toBe('ROBOT-1');
    });
    fireEvent.change(within(section).getByLabelText('結果'), { target: { value: 'FAILURE' } });
    fireEvent.change(within(section).getByLabelText('期間（開始日）'), {
      target: { value: '2026-10-09' },
    });
    fireEvent.change(within(section).getByLabelText('期間（終了日）'), {
      target: { value: '2026-10-10' },
    });

    await waitFor(() => {
      expect(lastQuery()?.get('from')).toBe('2026-10-08T15:00:00.000Z');
    });
    expect(lastQuery()?.get('to')).toBe('2026-10-10T14:59:59.999Z');
    expect(lastQuery()?.get('equipmentId')).toBe('ROBOT-1');
    expect(lastQuery()?.get('result')).toBe('FAILURE');
    expect(lastQuery()?.has('sourceId')).toBe(false);
    expect(window.location.search).toContain('equipment=ROBOT-1');
    expect(window.location.search).toContain('result=FAILURE');
    expect(window.location.search).toContain('from=2026-10-09');
    expect(window.location.search).toContain('to=2026-10-10');
  });

  it('絞り込みの条件を変えると、1 ページ目に戻る（次のページのカーソルを引き継がない）', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      baseRoutes({
        'GET /ingestion/logs': (request) =>
          jsonResponse({
            items: [ingestionLog()],
            nextCursor: request.query.get('cursor') === null ? 'log-2' : null,
          }),
      }),
    );
    await screen.findAllByTestId('ingestion-log-row');
    const section = screen.getByTestId('ingestion-logs');
    fireEvent.click(within(section).getByRole('button', { name: '次へ' }));
    await waitFor(() => {
      expect(within(section).getByTestId('pager-page').textContent).toBe('2');
    });

    fireEvent.change(within(section).getByLabelText('結果'), { target: { value: 'SUCCESS' } });

    await waitFor(() => {
      expect(within(section).getByTestId('pager-page').textContent).toBe('1');
    });
    const last = callsOf(calls, 'GET', '/ingestion/logs').at(-1)?.query;
    expect(last?.get('result')).toBe('SUCCESS');
    expect(last?.has('cursor')).toBe(false);
  });

  it('取り込み元ごとに、設備ごとの最終の実行（日時・結果・最後にデータが取れた日時）を表示する。一度も実行していない設備は、その旨', async () => {
    renderApp('/settings/ingestion', baseRoutes());

    const robot1 = await screen.findByTestId('equipment-run-ROBOT-1');
    const robot2 = screen.getByTestId('equipment-run-ROBOT-2');

    expect(within(robot1).getByText('収穫ロボット1')).toBeDefined();
    expect(robot1.textContent).toContain('失敗');
    expect(robot1.textContent).toContain('2026/10/09 11:00:00');
    expect(robot1.textContent).toContain('2026/10/09 09:30:00');
    expect(robot2.textContent).toContain('まだ実行していません');
    expect(
      within(screen.getByTestId('source-environment-sensor')).getByTestId('equipment-run-SENSOR-1')
        .textContent,
    ).toContain('まだ実行していません');
  });

  it('ログ・連携の記録のページ分割: 次へ・前へで、カーソルを使って移動する', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      baseRoutes({
        'GET /ingestion/logs': (request) =>
          jsonResponse({
            items: [ingestionLog()],
            nextCursor: request.query.get('cursor') === null ? 'log-2' : null,
          }),
        'GET /federation/logs': (request) =>
          jsonResponse({
            items: [federationLog()],
            nextCursor: request.query.get('cursor') === null ? 'fed-2' : null,
            queue: QUEUE,
          }),
      }),
    );
    await screen.findAllByTestId('federation-log-row');
    const logs = screen.getByTestId('ingestion-logs');
    const federation = screen.getByTestId('federation-section');

    fireEvent.click(within(logs).getByRole('button', { name: '次へ' }));
    fireEvent.click(within(federation).getByRole('button', { name: '次へ' }));
    await waitFor(() => {
      expect(within(logs).getByTestId('pager-page').textContent).toBe('2');
      expect(within(federation).getByTestId('pager-page').textContent).toBe('2');
    });
    expect(callsOf(calls, 'GET', '/ingestion/logs').at(-1)?.query.get('cursor')).toBe('log-2');
    expect(callsOf(calls, 'GET', '/federation/logs').at(-1)?.query.get('cursor')).toBe('fed-2');

    fireEvent.click(within(logs).getByRole('button', { name: '前へ' }));
    fireEvent.click(within(federation).getByRole('button', { name: '前へ' }));
    await waitFor(() => {
      expect(within(logs).getByTestId('pager-page').textContent).toBe('1');
      expect(within(federation).getByTestId('pager-page').textContent).toBe('1');
    });
  });

  it('「最新の状況を読み込む」で、設定・ログ・連携の状況を読み直す', async () => {
    const { calls } = renderApp('/settings/ingestion', baseRoutes());
    await screen.findByTestId('source-robot');
    const before = callsOf(calls, 'GET', '/ingestion/settings').length;

    fireEvent.click(screen.getByRole('button', { name: '最新の状況を読み込む' }));

    await waitFor(() => {
      expect(callsOf(calls, 'GET', '/ingestion/settings').length).toBeGreaterThan(before);
    });
  });

  it('設定・ログ・連携の取得に失敗した場合は、それぞれ、エラーを表示する', async () => {
    renderApp('/settings/ingestion', {
      'GET /ingestion/settings': () => errorBody(500, 'INTERNAL_ERROR', '設定を取得できません'),
      'GET /ingestion/logs': () => errorBody(500, 'INTERNAL_ERROR', 'ログを取得できません'),
      'GET /federation/logs': () => errorBody(500, 'INTERNAL_ERROR', '連携を取得できません'),
    });
    await waitFor(() => {
      const texts = screen.getAllByRole('alert').map((node) => node.textContent);
      expect(texts.some((text) => text.includes('設定を取得できません'))).toBe(true);
      expect(texts.some((text) => text.includes('ログを取得できません'))).toBe(true);
      expect(texts.some((text) => text.includes('連携を取得できません'))).toBe(true);
    });
  });
});
