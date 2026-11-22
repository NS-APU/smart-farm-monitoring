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
  at,
} from '../../support/management-frontend.ts';

const EQUIPMENT_CONNECTION = {
  type: 'HTTP',
  protocol: 'HTTPS',
  host: 'fileserver.example.ac.jp',
  port: 8443,
  authMethod: 'BASIC',
  apiKeyHeaderName: 'X-API-Key',
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'robot',
    kind: 'ROBOT',
    profileId: 'robot-v1',
    isEnabled: true,
    formatProfile: { versionLabel: 'v0.1', status: 'PROVISIONAL' },
    lastStartedAt: '2026-10-09T02:00:00.000Z',
    lastSuccessAt: '2026-10-09T01:00:00.000Z',
    equipment: [
      {
        equipmentId: 'ROBOT-1',
        name: '収穫ロボット1',
        sourceFilePath: '/data/robot-1.json',
        connection: EQUIPMENT_CONNECTION,
        credentials: { state: 'CONFIGURED', updatedAt: '2026-10-09T03:00:00.000Z' },
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

describe('取り込み（UC-15・UC-16。SC-11）', () => {
  it('取り込み元ごとに、有効の設定と、解釈に使う仕様の版・状態、最終の実行を表示する。共通の接続の入力（接続先の参照名・接続設定・認証情報・接続テスト）と、最終の成功は、ない（#367）', async () => {
    renderApp('/settings/ingestion', baseRoutes());

    const robot = await screen.findByTestId('source-robot');
    expect(within(robot).getByRole('heading', { name: 'ロボットデータ' })).toBeDefined();
    expect(robot.textContent).toContain('v0.1（仮決め）');
    // 取り込み元の共通の接続の入力は、ない（接続は、設備ごとに、設備のダイアログで設定する）
    expect(within(robot).queryByLabelText('接続先', { exact: false })).toBeNull();
    expect(within(robot).queryByLabelText('プロトコル', { exact: false })).toBeNull();
    expect(within(robot).queryByLabelText('ホスト', { exact: false })).toBeNull();
    expect(within(robot).queryByLabelText('ポート', { exact: false })).toBeNull();
    expect(within(robot).queryByLabelText('認証方式', { exact: false })).toBeNull();
    expect(within(robot).queryByLabelText('パスワード', { exact: false })).toBeNull();
    expect(within(robot).queryByRole('button', { name: '認証情報を保存' })).toBeNull();
    expect(screen.queryByTestId('last-success-robot')).toBeNull();
    expect(robot.textContent).not.toContain('最終の成功');
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
      '取得したデータ',
    ]);
    expect(labelsOf(federationRow)).toHaveLength(4);
    expect(labelsOf(federationRow).every((label) => label !== null && label !== '')).toBe(true);
  });

  it('取り込みのログから、取得したデータ（計測データの一覧）へ移れる。設備・自動取り込み・実行の日付（日本時間）で絞る。取得件数が 0 の実行は、リンクを出さない（Issue #363）', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'GET /ingestion/logs': () =>
          jsonResponse({
            items: [
              // 日本時間では、翌日にまたがる実行（UTC 15:00 = 日本時間 0:00）
              ingestionLog({
                startedAt: '2026-10-09T14:59:58.000Z',
                finishedAt: '2026-10-09T15:00:03.000Z',
              }),
              ingestionLog({ logId: 'l-2', recordCount: 0 }),
              ingestionLog({ logId: 'l-3', equipmentId: undefined }),
            ],
            nextCursor: null,
          }),
      }),
    );

    const rows = await screen.findAllByTestId('ingestion-log-row');

    const link = within(at(rows, 0)).getByRole('link', { name: '一覧で見る' });
    expect(link.getAttribute('href')).toBe(
      '/observations?source=AUTO_IMPORT&equipmentId=ROBOT-1&from=2026-10-09&to=2026-10-10',
    );
    expect(within(at(rows, 1)).queryByRole('link', { name: '一覧で見る' })).toBeNull();
    // 設備に結びつかないログは、設備を指定しない
    expect(within(at(rows, 2)).getByRole('link', { name: '一覧で見る' }).getAttribute('href')).toBe(
      '/observations?source=AUTO_IMPORT&from=2026-10-09&to=2026-10-09',
    );
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

  it('閲覧の権限だけがあれば、参照のみ（自動取り込みは変更できず、保存・接続テスト・即時取得の操作を表示しない）', async () => {
    renderApp('/settings/ingestion', baseRoutes(), { login: loginWith(['ingestion:read']) });
    const robot = await screen.findByTestId('source-robot');
    expect(screen.getByTestId('permission-notice').textContent).toContain('権限がありません');
    expect(within(robot).getByRole<HTMLInputElement>('checkbox').disabled).toBe(true);
    expect(within(robot).queryByRole('button', { name: '設定を保存' })).toBeNull();
    expect(within(robot).queryByRole('button', { name: '即時取得' })).toBeNull();
    expect(within(robot).queryByRole('button', { name: /接続テスト/ })).toBeNull();
  });

  it('設定の権限だけがある場合は、保存だけできる。実行の権限だけがある場合は、設備ごとの接続テスト・即時取得だけできる', async () => {
    const view = renderApp('/settings/ingestion', baseRoutes(), {
      login: loginWith(['ingestion:read', 'ingestion:configure']),
    });
    const robot = await screen.findByTestId('source-robot');
    expect(within(robot).getByRole('button', { name: '設定を保存' })).toBeDefined();
    expect(within(robot).queryByRole('button', { name: /接続テスト/ })).toBeNull();
    view.unmount();

    renderApp('/settings/ingestion', baseRoutes(), {
      login: loginWith(['ingestion:read', 'ingestion:run']),
    });
    const robotRun = await screen.findByTestId('source-robot');
    expect(within(robotRun).queryByRole('button', { name: '設定を保存' })).toBeNull();
    expect(
      within(robotRun).getByRole('button', { name: '収穫ロボット1の接続テスト' }),
    ).toBeDefined();
    expect(within(robotRun).getByRole('button', { name: '即時取得' })).toBeDefined();
  });

  it('設定の保存: 自動取り込みの有効／無効だけを送る。接続・接続設定の参照名・取得間隔は送らない（#367。共通の接続の廃止）', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      baseRoutes({ 'PUT /ingestion/settings': () => jsonResponse(SETTINGS) }),
    );
    const robot = await screen.findByTestId('source-robot');

    fireEvent.click(within(robot).getByRole('checkbox'));
    fireEvent.click(within(robot).getByRole('button', { name: '設定を保存' }));

    expect((await screen.findByTestId('result-robot')).textContent).toBe('設定を保存しました');
    expect(callsOf(calls, 'PUT', '/ingestion/settings')[0]?.body).toEqual({
      sources: [
        {
          sourceId: 'robot',
          isEnabled: false,
        },
      ],
    });
  });

  it('設定の保存で、サーバーがエラーを返したら、画面に表示する', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'PUT /ingestion/settings': () =>
          errorBody(422, 'VALIDATION_ERROR', '入力内容を確認してください', [
            { name: 'sources.0.sourceId', message: '取り込み元を確認してください' },
          ]),
      }),
    );
    const robot = await screen.findByTestId('source-robot');
    fireEvent.click(within(robot).getByRole('button', { name: '設定を保存' }));
    expect((await within(robot).findByRole('alert')).textContent).toBe(
      '入力内容を確認してください',
    );
  });

  it('自動取り込みを有効にする欄の近くに、外した影響（手動の運用になる・ダッシュボードの「データが古い」の警告が出なくなる）を説明する（SC-11-9）', async () => {
    renderApp('/settings/ingestion', baseRoutes());
    const robot = await screen.findByTestId('source-robot');

    const impact = within(robot).getByTestId('enabled-impact-robot');
    expect(impact.textContent).toContain('手動の運用');
    expect(impact.textContent).toContain('「データが古い」の警告も出なくなります');
    expect(within(robot).getByRole('checkbox').getAttribute('aria-describedby')).toBe(impact.id);
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

  it('設備ごとの接続テスト: その設備の API（/ingestion/equipment/{設備 ID}/test）を呼び、結果のメッセージを、その設備の行に示す（成功は成功の表示、失敗は失敗の表示）', async () => {
    let ok = true;
    const { calls } = renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/equipment/ROBOT-1/test': () =>
          jsonResponse(
            ok
              ? { ok: true, message: '接続できました' }
              : { ok: false, message: '接続できませんでした' },
          ),
      }),
    );
    const robot = await screen.findByTestId('source-robot');

    fireEvent.click(within(robot).getByRole('button', { name: '収穫ロボット1の接続テスト' }));
    const success = await screen.findByTestId('equipment-test-result-ROBOT-1');
    expect(success.textContent).toBe('接続できました');
    expect(success.className).toContain('form-success');
    expect(callsOf(calls, 'POST', '/ingestion/equipment/ROBOT-1/test')).toHaveLength(1);
    // ほかの設備の行には、結果を出さない
    expect(screen.queryByTestId('equipment-test-result-ROBOT-2')).toBeNull();

    ok = false;
    fireEvent.click(within(robot).getByRole('button', { name: '収穫ロボット1の接続テスト' }));
    await waitFor(() => {
      expect(screen.getByTestId('equipment-test-result-ROBOT-1').textContent).toBe(
        '接続できませんでした',
      );
    });
    expect(screen.getByTestId('equipment-test-result-ROBOT-1').className).toContain('form-error');
  });

  it('設備ごとの接続テストに失敗した場合（API のエラー）は、エラーを表示する', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/equipment/ROBOT-1/test': () =>
          errorBody(500, 'INTERNAL_ERROR', 'テストできませんでした'),
      }),
    );
    const robot = await screen.findByTestId('source-robot');
    fireEvent.click(within(robot).getByRole('button', { name: '収穫ロボット1の接続テスト' }));
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
        'POST /ingestion/equipment/ROBOT-1/test': () => pending,
        'PUT /ingestion/settings': () => pending,
      }),
    );
    const robot = await screen.findByTestId('source-robot');

    // 即時取得の実行中: 設備の接続テストのボタンに「接続テスト中」と出さない
    fireEvent.click(within(robot).getByRole('button', { name: '即時取得' }));
    await waitFor(() => {
      expect(buttonOf(robot, '取得中…').disabled).toBe(true);
    });
    expect(buttonOf(robot, '収穫ロボット1の接続テスト').disabled).toBe(true);
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

  it('設備の接続テストの実行中は、その設備のボタンだけに「接続テスト中」と出し、ほかの操作を止める。設定の保存の実行中は、どのボタンにも出さない', async () => {
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
        'POST /ingestion/equipment/ROBOT-1/test': () => pendingTest,
        'PUT /ingestion/settings': () => pendingSave,
      }),
    );
    const robot = await screen.findByTestId('source-robot');

    fireEvent.click(within(robot).getByRole('button', { name: '収穫ロボット1の接続テスト' }));
    await waitFor(() => {
      expect(within(robot).getByTestId('equipment-test-ROBOT-1').textContent).toBe('接続テスト中…');
    });
    expect(buttonOf(robot, '収穫ロボット1の接続テスト').disabled).toBe(true);
    // ほかの設備のボタンには、実行中の表示を出さない（操作は止める）
    expect(within(robot).getByTestId('equipment-test-ROBOT-2').textContent).toBe('接続テスト');
    expect(buttonOf(robot, '即時取得').disabled).toBe(true);
    finishTest(jsonResponse({ ok: true, message: '接続できました' }));
    await screen.findByTestId('equipment-test-result-ROBOT-1');

    fireEvent.click(within(robot).getByRole('button', { name: '設定を保存' }));
    await waitFor(() => {
      expect(buttonOf(robot, '収穫ロボット1の接続テスト').disabled).toBe(true);
    });
    expect(within(robot).queryByText('接続テスト中…')).toBeNull();
    finishSave(jsonResponse(SETTINGS));
    await waitFor(() => {
      expect(buttonOf(robot, '収穫ロボット1の接続テスト').disabled).toBe(false);
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

/** 取り込み元ごとの設備の状況（設備ごとの接続・停止中の判定の確認用）。 */
function equipmentStatus(overrides: Record<string, unknown> = {}) {
  return {
    equipmentId: 'ROBOT-01',
    name: '収穫ロボット1',
    sourceFilePath: '/data/robot-01.json',
    connection: EQUIPMENT_CONNECTION,
    // 停止中の基準（分）は、サーバーが、設備の取得間隔 × 倍数（最低 3 分）で計算して返す。ロボットの既定（1 分 × 3）は、最低の 3 分
    staleThresholdMinutes: 3,
    credentials: { state: 'CONFIGURED', updatedAt: '2026-10-09T03:00:00.000Z' },
    lastStartedAt: null,
    lastResult: null,
    lastSuccessAt: null,
    lastDataAt: null,
    ...overrides,
  };
}

/** 現在から、指定の分だけ前の日時（ISO）。 */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function settingsRoutes(
  equipment: readonly unknown[],
  sourceOverrides: Record<string, unknown> = {},
  extra: Routes = {},
): Routes {
  return baseRoutes({
    'GET /ingestion/settings': () =>
      jsonResponse({ sources: [source({ equipment, ...sourceOverrides })] }),
    ...extra,
  });
}

describe('SC-11: 設備ごとの接続と状況の表（Issue #367。ADR-0026）', () => {
  it('取り込み元ごとに、設備ごとの表を示す: 設備名・ファイルのパス・接続先・認証情報の状態・最終の実行・結果・最後にデータが取れた日時', async () => {
    renderApp('/settings/ingestion', baseRoutes());

    const robot1 = await screen.findByTestId('equipment-run-ROBOT-1');
    const table = within(screen.getByTestId('source-robot')).getByRole('table', {
      name: 'ロボットデータの設備ごとの接続と状況',
    });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      '設備',
      'ファイルのパス',
      '接続先',
      '認証情報',
      '最終の実行（結果）',
      '最後にデータが取れた日時',
      '操作',
    ]);
    expect(within(robot1).getByText('収穫ロボット1')).toBeDefined();
    expect(within(robot1).getByTestId('equipment-path-ROBOT-1').textContent).toBe(
      '/data/robot-1.json',
    );
    // 接続先: 表示用の URL（クエリ・認証情報を含まない。既定のポートは省略する）
    expect(within(robot1).getByTestId('equipment-target-ROBOT-1').textContent).toBe(
      'https://fileserver.example.ac.jp:8443',
    );
    // 接続の出どころ（設備ごと／共通）は、ない（共通の接続の廃止）
    expect(within(robot1).queryByTestId('equipment-origin-ROBOT-1')).toBeNull();
    expect(within(robot1).getByTestId('equipment-credentials-ROBOT-1').textContent).toContain(
      '設定済み',
    );
    expect(within(robot1).getByTestId('equipment-credentials-ROBOT-1').textContent).toContain(
      '2026/10/09 12:00:00',
    );
    expect(within(robot1).getByTestId('equipment-result-ROBOT-1').textContent).toBe('失敗');
    expect(within(robot1).getByTestId('equipment-data-ROBOT-1').textContent).toBe(
      '2026/10/09 09:30:00',
    );
    // 表の各セルは、項目名（data-label）を持つ（狭い画面で、カードにするため）
    expect(
      [...robot1.querySelectorAll('td')].every((cell) => cell.getAttribute('data-label') !== null),
    ).toBe(true);
  });

  it('接続が未設定の設備は、接続先を「未設定」と示す。ファイルのパスがない設備には、「ファイルのパスを設定すると、取り込みの対象になる」の案内を示す', async () => {
    renderApp('/settings/ingestion', baseRoutes());

    const robot2 = await screen.findByTestId('equipment-run-ROBOT-2');

    expect(within(robot2).getByTestId('equipment-target-ROBOT-2').textContent).toBe('未設定');
    expect(within(robot2).getByTestId('equipment-nopath-ROBOT-2').textContent).toContain(
      'ファイルのパスを設定すると、取り込みの対象になります',
    );
    expect(within(robot2).getByTestId('equipment-credentials-ROBOT-2').textContent).toBe('不要');
    // 設備がない取り込み元には、表の代わりに、その旨を示す
    expect(screen.getByTestId('equipment-empty-custom-source').textContent).toContain(
      '設備（ロボット・環境センサー）が登録されていません',
    );
  });

  it('接続先は、設備の接続があれば、接続先のホスト（表示用の URL）、なければ「未設定」を示す。接続の出どころ・共通の接続の注意は、示さない（共通の接続の廃止）', async () => {
    renderApp(
      '/settings/ingestion',
      settingsRoutes([
        equipmentStatus({ equipmentId: 'ROBOT-A', name: 'ロボットA' }),
        equipmentStatus({
          equipmentId: 'ROBOT-C',
          name: 'ロボットC',
          connection: undefined,
          credentials: { state: 'NOT_REQUIRED' },
        }),
      ]),
    );

    await screen.findByTestId('equipment-run-ROBOT-A');

    expect(screen.getByTestId('equipment-target-ROBOT-A').textContent).toBe(
      'https://fileserver.example.ac.jp:8443',
    );
    expect(screen.getByTestId('equipment-target-ROBOT-C').textContent).toBe('未設定');
    expect(screen.queryByTestId('equipment-origin-ROBOT-A')).toBeNull();
    expect(screen.queryByTestId('equipment-origin-ROBOT-C')).toBeNull();
    expect(screen.queryByTestId('shared-connection-notice-robot')).toBeNull();
  });

  it('停止中: 最後にデータが取れてから、サーバーが返す設備の基準（staleThresholdMinutes）を超えた設備に「停止中」を示す', async () => {
    renderApp(
      '/settings/ingestion',
      settingsRoutes([
        // 基準（3 分）を超えた
        equipmentStatus({ equipmentId: 'ROBOT-OLD', name: '古い', lastDataAt: minutesAgo(10) }),
        // 基準以内
        equipmentStatus({ equipmentId: 'ROBOT-NEW', name: '新しい', lastDataAt: minutesAgo(1) }),
        // まだ 1 件もデータがない（判定しない）
        equipmentStatus({ equipmentId: 'ROBOT-NONE', name: 'なし', lastDataAt: null }),
        // ファイルのパスを持たない（取り込みの対象ではない）
        equipmentStatus({
          equipmentId: 'ROBOT-NOPATH',
          name: 'パスなし',
          sourceFilePath: undefined,
          lastDataAt: minutesAgo(600),
        }),
      ]),
    );

    await screen.findByTestId('equipment-run-ROBOT-OLD');

    const stopped = screen.getByTestId('equipment-stopped-ROBOT-OLD');
    expect(stopped.textContent).toBe('停止中');
    expect(stopped.getAttribute('title')).toContain('基準（3 分）');
    expect(screen.queryByTestId('equipment-stopped-ROBOT-NEW')).toBeNull();
    expect(screen.queryByTestId('equipment-stopped-ROBOT-NONE')).toBeNull();
    expect(screen.queryByTestId('equipment-stopped-ROBOT-NOPATH')).toBeNull();
  });

  it('停止中の基準は、設備ごとに、サーバーが返す値（staleThresholdMinutes）を使う。基準が来ない設備は、判定しない', async () => {
    renderApp(
      '/settings/ingestion',
      settingsRoutes([
        // 基準 30 分: 20 分前は、停止中ではない
        equipmentStatus({ staleThresholdMinutes: 30, lastDataAt: minutesAgo(20) }),
        // 基準 3 分: 20 分前は、停止中
        equipmentStatus({
          equipmentId: 'ROBOT-SHORT',
          name: '短い',
          staleThresholdMinutes: 3,
          lastDataAt: minutesAgo(20),
        }),
        // 基準が来ない（サーバーが返さない）: 判定しない
        equipmentStatus({
          equipmentId: 'ROBOT-NOTHRESHOLD',
          name: '基準なし',
          staleThresholdMinutes: undefined,
          lastDataAt: minutesAgo(600),
        }),
      ]),
    );

    await screen.findByTestId('equipment-run-ROBOT-01');

    expect(screen.queryByTestId('equipment-stopped-ROBOT-01')).toBeNull();
    expect(screen.getByTestId('equipment-stopped-ROBOT-SHORT')).toBeDefined();
    expect(screen.queryByTestId('equipment-stopped-ROBOT-NOTHRESHOLD')).toBeNull();
  });

  it('停止中の基準（環境センサー）: サーバーが返す 15 分。14 分前は停止中ではなく、16 分前は停止中。表示にも、その基準を使う', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'GET /ingestion/settings': () =>
          jsonResponse({
            sources: [
              source({
                sourceId: 'environment-sensor',
                kind: 'SENSOR',
                equipment: [
                  equipmentStatus({
                    equipmentId: 'SENSOR-A',
                    name: 'センサーA',
                    staleThresholdMinutes: 15,
                    lastDataAt: minutesAgo(14),
                  }),
                  equipmentStatus({
                    equipmentId: 'SENSOR-B',
                    name: 'センサーB',
                    staleThresholdMinutes: 15,
                    lastDataAt: minutesAgo(16),
                  }),
                ],
              }),
            ],
          }),
      }),
    );

    await screen.findByTestId('equipment-run-SENSOR-A');

    expect(screen.queryByTestId('equipment-stopped-SENSOR-A')).toBeNull();
    expect(screen.getByTestId('equipment-stopped-SENSOR-B').getAttribute('title')).toContain(
      '基準（15 分）',
    );
  });

  it('自動取り込みが無効な取り込み元は、停止中を示さない（手動の運用。ダッシュボードの警告も出ない）', async () => {
    renderApp(
      '/settings/ingestion',
      settingsRoutes([equipmentStatus({ lastDataAt: minutesAgo(600) })], { isEnabled: false }),
    );

    await screen.findByTestId('equipment-run-ROBOT-01');

    expect(screen.queryByTestId('equipment-stopped-ROBOT-01')).toBeNull();
  });

  it('最終の実行結果: 一部成功も、結果として示す（最後にデータが取れた日時に反映される）', async () => {
    renderApp(
      '/settings/ingestion',
      settingsRoutes([
        equipmentStatus({
          lastResult: 'PARTIAL',
          lastStartedAt: minutesAgo(1),
          lastDataAt: minutesAgo(1),
        }),
      ]),
    );

    expect((await screen.findByTestId('equipment-result-ROBOT-01')).textContent).toBe('一部成功');
    expect(screen.queryByTestId('equipment-stopped-ROBOT-01')).toBeNull();
  });

  it('設備のダイアログ（接続を設定・修正）へのリンクを示す。設備を変更する権限がなければ、示さない', async () => {
    const view = renderApp('/settings/ingestion', baseRoutes());

    const link = await screen.findByRole('link', { name: '収穫ロボット1の接続を設定・修正' });
    expect(link.getAttribute('href')).toBe('/settings/equipment?edit=ROBOT-1');
    view.unmount();

    renderApp('/settings/ingestion', baseRoutes(), {
      login: loginWith(['ingestion:read', 'ingestion:run']),
    });
    await screen.findByTestId('equipment-run-ROBOT-1');
    expect(screen.queryByRole('link', { name: /接続を設定・修正/ })).toBeNull();
    expect(screen.getByRole('button', { name: '収穫ロボット1の接続テスト' })).toBeDefined();
  });

  it('接続は設備ごとに設定する旨を、画面の上に示す（取り込み元の共通の入力欄はない）', async () => {
    renderApp('/settings/ingestion', baseRoutes());
    await screen.findByTestId('source-robot');

    expect(screen.getByTestId('ingestion-connection-lead').textContent).toContain(
      '接続は設備ごとに設定します',
    );
  });
});
