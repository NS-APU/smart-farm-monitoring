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
    intervalMinutes: 15,
    isEnabled: true,
    formatProfile: { versionLabel: 'v0.1', status: 'PROVISIONAL' },
    lastStartedAt: '2026-10-09T02:00:00.000Z',
    lastSuccessAt: '2026-10-09T01:00:00.000Z',
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
      intervalMinutes: 60,
      isEnabled: false,
      lastStartedAt: null,
      lastSuccessAt: null,
      formatProfile: { versionLabel: 'v1.0', status: 'CONFIRMED' },
    }),
    source({ sourceId: 'custom-source', isRunning: true }),
  ],
};

function ingestionLog(overrides: Record<string, unknown> = {}) {
  return {
    logId: 'l-1',
    sourceId: 'robot',
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

const QUEUE = { PENDING: 1, SENT: 2, FAILED: 3, HELD: 4 };

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
  it('取り込み元ごとに、設定（接続先の参照名・取得間隔・有効）と、解釈に使う仕様の版・状態、最終の実行・成功を表示する', async () => {
    renderApp('/settings/ingestion', baseRoutes());

    const robot = await screen.findByTestId('source-robot');
    expect(within(robot).getByRole('heading', { name: 'ロボットデータ' })).toBeDefined();
    expect(robot.textContent).toContain('v0.1（仮決め）');
    expect(within(robot).getByLabelText<HTMLInputElement>('接続先', { exact: false }).value).toBe(
      'file-server-main',
    );
    expect(
      within(robot).getByLabelText<HTMLSelectElement>('取得間隔', { exact: false }).value,
    ).toBe('15');
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

  it('取り込みのログ（日時・取り込み元・結果・件数・エラー内容）と、連携の状況（キューの件数・結果の記録）を表示する', async () => {
    renderApp('/settings/ingestion', baseRoutes());

    const logRows = await screen.findAllByTestId('ingestion-log-row');
    expect(logRows[0]?.getAttribute('data-result')).toBe('SUCCESS');
    expect(logRows[0]?.textContent).toContain('ロボットデータ');
    expect(logRows[0]?.querySelectorAll('td')[6]?.textContent).toBe('—');
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
      '結果',
      'ファイル数',
      '取得件数',
      '読み取れなかった数',
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

  it('権限がなければ、参照のみ（入力欄は変更できず、保存・接続テスト・即時取得の操作を表示しない）', async () => {
    renderApp('/settings/ingestion', baseRoutes(), { login: READ_ONLY_LOGIN });
    const robot = await screen.findByTestId('source-robot');
    expect(screen.getByTestId('permission-notice').textContent).toContain('権限がありません');
    expect(
      within(robot).getByLabelText<HTMLInputElement>('接続先', { exact: false }).readOnly,
    ).toBe(true);
    expect(
      within(robot).getByLabelText<HTMLSelectElement>('取得間隔', { exact: false }).disabled,
    ).toBe(true);
    expect(within(robot).queryByRole('button', { name: '設定を保存' })).toBeNull();
    expect(within(robot).queryByRole('button', { name: '即時取得' })).toBeNull();
  });

  it('設定の権限だけがある場合は、保存だけできる。実行の権限だけがある場合は、接続テスト・即時取得だけできる', async () => {
    const view = renderApp('/settings/ingestion', baseRoutes(), {
      login: loginWith(['ingestion:configure']),
    });
    const robot = await screen.findByTestId('source-robot');
    expect(within(robot).getByRole('button', { name: '設定を保存' })).toBeDefined();
    expect(within(robot).queryByRole('button', { name: '接続テスト' })).toBeNull();
    view.unmount();

    renderApp('/settings/ingestion', baseRoutes(), { login: loginWith(['ingestion:run']) });
    const robotRun = await screen.findByTestId('source-robot');
    expect(within(robotRun).queryByRole('button', { name: '設定を保存' })).toBeNull();
    expect(within(robotRun).getByRole('button', { name: '接続テスト' })).toBeDefined();
    expect(within(robotRun).getByRole('button', { name: '即時取得' })).toBeDefined();
  });

  it('設定の保存: 接続先の参照名・取得間隔・有効を送る。不正な参照名は、保存しない', async () => {
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
    fireEvent.change(within(robot).getByLabelText('取得間隔', { exact: false }), {
      target: { value: '5' },
    });
    fireEvent.click(within(robot).getByRole('checkbox'));
    fireEvent.click(within(robot).getByRole('button', { name: '設定を保存' }));

    expect((await screen.findByTestId('result-robot')).textContent).toBe('設定を保存しました');
    expect(callsOf(calls, 'PUT', '/ingestion/settings')[0]?.body).toEqual({
      sources: [
        {
          sourceId: 'robot',
          connectionRef: 'file-server-sub',
          intervalMinutes: 5,
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

  it('取り込み元でログを絞り込める。クエリに反映する', async () => {
    const { calls } = renderApp('/settings/ingestion', baseRoutes());
    await screen.findAllByTestId('ingestion-log-row');
    const section = screen.getByTestId('ingestion-logs');

    fireEvent.change(within(section).getByLabelText('取り込み元'), { target: { value: 'robot' } });

    await waitFor(() => {
      expect(callsOf(calls, 'GET', '/ingestion/logs').at(-1)?.query.get('sourceId')).toBe('robot');
    });
    expect(window.location.search).toContain('source=robot');
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
