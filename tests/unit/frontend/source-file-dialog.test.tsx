/**
 * SC-11 取り込み: ブラウザから、設備ごとの取り込み用のファイルを置く（Issue #565。UC-15。ADR-0027）。
 * 設備ごとの表の「ファイルを置く」→ ダイアログ（ファイルの選択 → 内容を確認 → 置く）→ 確認のダイアログ → 結果の通知（即時取得への導線）。
 * ファイルの内容は、合成データだけ。
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SOURCE_FILE_MAX_BYTES } from '../../../src/shared/schemas/ingestion.ts';
import { jsonResponse } from '../../support/frontend.ts';
import {
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
  authMethod: 'NONE',
};

function equipment(overrides: Record<string, unknown>) {
  return {
    connection: CONNECTION,
    credentials: { state: 'NOT_REQUIRED' },
    lastStartedAt: null,
    lastResult: null,
    lastSuccessAt: null,
    lastDataAt: null,
    ...overrides,
  };
}

const SETTINGS = {
  sources: [
    {
      sourceId: 'robot',
      kind: 'ROBOT',
      profileId: 'robot-v1',
      isEnabled: true,
      formatProfile: { versionLabel: 'robot-json@1.0.0(CONFIRMED)', status: 'CONFIRMED' },
      lastStartedAt: null,
      lastSuccessAt: null,
      isRunning: false,
      equipment: [
        equipment({
          equipmentId: 'ROBOT-1',
          name: '収穫ロボット1',
          sourceFilePath: '/robot/robot-1.json',
        }),
        // ファイルのパスがない設備には、ボタンを出さない
        equipment({ equipmentId: 'ROBOT-2', name: '収穫ロボット2' }),
      ],
    },
    {
      sourceId: 'environment-sensor',
      kind: 'SENSOR',
      profileId: 'environment-sensor-v1',
      isEnabled: true,
      formatProfile: {
        versionLabel: 'environment-sensor-json@1.0.0(CONFIRMED)',
        status: 'CONFIRMED',
      },
      lastStartedAt: null,
      lastSuccessAt: null,
      isRunning: false,
      equipment: [
        equipment({
          equipmentId: 'SENSOR-1',
          name: '環境センサー1',
          sourceFilePath: '/environment-sensor/sensor-1.json',
        }),
      ],
    },
  ],
};

const FILE_TEXT = '{"robotId":"ROBOT-SAMPLE-01","observedAt":"2026-10-09T02:00:00.000Z"}\n';
const FILE_NAME = 'robot-definition-sample-001.json';

const INSPECTION_OK = {
  ok: true,
  formatLabel: 'robot-json@1.0.0(CONFIRMED)',
  size: 69,
  observedAt: '2026-10-09T02:00:00.000Z',
  itemCount: 7,
  problems: [],
  warnings: [],
};

const INSPECTION_NG = {
  ok: false,
  formatLabel: 'robot-json@1.0.0(CONFIRMED)',
  size: 12,
  itemCount: 0,
  problems: ['JSON として読み取れません', '計測日時を読み取れません'],
  warnings: [],
};

const RUN_RESPONSE = {
  sourceId: 'robot',
  result: 'SUCCESS',
  filesProcessed: 1,
  recordCount: 7,
  rejectedCount: 0,
  attempts: 1,
};

function baseRoutes(extra: Routes = {}): Routes {
  return {
    'GET /ingestion/settings': () => jsonResponse(SETTINGS),
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

const ADMIN = loginWith(['ingestion:read', 'ingestion:configure', 'ingestion:run']);

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

function jsonFile(content = FILE_TEXT, name = FILE_NAME): File {
  return new File([content], name, { type: 'application/json' });
}

function openButton(equipmentName: string): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', {
    name: `${equipmentName}のファイルを置く`,
  });
}

async function openDialog(equipmentName = '収穫ロボット1'): Promise<HTMLElement> {
  await screen.findByTestId('source-robot');
  // 実際のブラウザでは、押したボタンにフォーカスが移る（閉じたら、そのボタンへ戻す）
  openButton(equipmentName).focus();
  fireEvent.click(openButton(equipmentName));
  return screen.findByRole('dialog', { name: 'ファイルを置く' });
}

function fileInput(dialog: HTMLElement): HTMLInputElement {
  return within(dialog).getByLabelText<HTMLInputElement>(/取り込み用のファイル/);
}

/** ファイルを選び、内容の読み取りが終わる（選んだファイルの表示が出る）まで待つ。 */
async function chooseFile(dialog: HTMLElement, file: File = jsonFile()): Promise<void> {
  fireEvent.change(fileInput(dialog), { target: { files: [file] } });
  await within(dialog).findByTestId('source-file-selected');
}

const checkButton = (dialog: HTMLElement) =>
  within(dialog).getByRole<HTMLButtonElement>('button', { name: /^(内容を確認|確認中…)$/ });
const placeButton = (dialog: HTMLElement) =>
  within(dialog).getByRole<HTMLButtonElement>('button', { name: /^(置く|置いています…)$/ });

describe('SC-11: 「ファイルを置く」ボタンの表示（Issue #565）', () => {
  it('取り込みの設定の権限（ingestion:configure）があれば、ファイルのパスがある設備（ロボット・センサー）の行にだけ、「ファイルを置く」を出す。パスのない設備には出さない', async () => {
    renderApp('/settings/ingestion', baseRoutes(), { login: ADMIN });
    await screen.findByTestId('source-robot');

    expect(openButton('収穫ロボット1').textContent).toBe('ファイルを置く');
    expect(openButton('環境センサー1').textContent).toBe('ファイルを置く');
    expect(screen.queryByRole('button', { name: '収穫ロボット2のファイルを置く' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /のファイルを置く$/ })).toHaveLength(2);
  });

  it('接続テストの隣（同じ操作の欄）に出す', async () => {
    renderApp('/settings/ingestion', baseRoutes(), { login: ADMIN });
    await screen.findByTestId('source-robot');

    const actions = openButton('収穫ロボット1').closest('.row-actions');
    expect(actions).not.toBeNull();
    expect(
      within(actions as HTMLElement).getByRole('button', { name: '収穫ロボット1の接続テスト' }),
    ).toBeDefined();
  });

  it('取り込みの設定の権限がなければ（参照・実行だけ）、ボタンを出さない', async () => {
    renderApp('/settings/ingestion', baseRoutes(), {
      login: loginWith(['ingestion:read', 'ingestion:run']),
    });
    await screen.findByTestId('source-robot');

    expect(screen.queryByRole('button', { name: /のファイルを置く$/ })).toBeNull();
    // 接続テストは、実行の権限で使える（ボタンの有無は、権限ごとに独立）
    expect(screen.getByRole('button', { name: '収穫ロボット1の接続テスト' })).toBeDefined();
  });
});

describe('SC-11: ファイルを置くダイアログ（Issue #565）', () => {
  it('role="dialog"・aria-modal で、見出しは「ファイルを置く」。対象の設備名とファイルのパスを示し、ファイルの選択は、.json だけを受け付ける。選ぶまでは、確認・置くを使えない', async () => {
    renderApp('/settings/ingestion', baseRoutes(), { login: ADMIN });

    const dialog = await openDialog();

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByRole('heading', { name: 'ファイルを置く', level: 2 })).toBeDefined();
    expect(within(dialog).getByTestId('source-file-target').textContent).toContain('収穫ロボット1');
    expect(within(dialog).getByTestId('source-file-target').textContent).toContain(
      '/robot/robot-1.json',
    );
    const input = fileInput(dialog);
    expect(input.type).toBe('file');
    expect(input.accept).toBe('.json,application/json');
    expect(checkButton(dialog).disabled).toBe(true);
    expect(placeButton(dialog).disabled).toBe(true);
    // 開いたら、最初の入力欄（ファイルの選択）にフォーカスを移す
    expect(document.activeElement).toBe(input);
  });

  it('Esc・キャンセルで閉じ、フォーカスを、開いたボタンへ戻す', async () => {
    renderApp('/settings/ingestion', baseRoutes(), { login: ADMIN });
    const dialog = await openDialog();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'ファイルを置く' })).toBeNull();
    });
    expect(document.activeElement).toBe(openButton('収穫ロボット1'));

    openButton('収穫ロボット1').focus();
    fireEvent.click(openButton('収穫ロボット1'));
    const reopened = await screen.findByRole('dialog', { name: 'ファイルを置く' });
    fireEvent.click(within(reopened).getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('dialog', { name: 'ファイルを置く' })).toBeNull();
    expect(dialog.isConnected).toBe(false);
  });

  it('ファイルを選ぶと、名前と大きさを示し、「内容を確認」を使えるようにする（置くは、確認のあと）。確認の API は、まだ呼ばない', async () => {
    const { calls } = renderApp('/settings/ingestion', baseRoutes(), { login: ADMIN });
    const dialog = await openDialog();

    await chooseFile(dialog, jsonFile('x'.repeat(1536)));

    expect(within(dialog).getByTestId('source-file-selected').textContent).toBe(
      `選んだファイル: ${FILE_NAME}（1.5 KiB）`,
    );
    expect(checkButton(dialog).disabled).toBe(false);
    expect(placeButton(dialog).disabled).toBe(true);
    expect(callsOf(calls, 'POST', '/ingestion/equipment/ROBOT-1/source-file/check')).toHaveLength(
      0,
    );
  });

  it('内容を確認: ファイルそのものを本文にして、検査の API を呼び（JSON の包みを付けない）、仕様の版・計測日時（日本時間）・項目数・大きさを示す。置けるときは、「置く」を使える', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/equipment/ROBOT-1/source-file/check': () => jsonResponse(INSPECTION_OK),
      }),
      { login: ADMIN },
    );
    const dialog = await openDialog();
    await chooseFile(dialog);

    fireEvent.click(checkButton(dialog));

    const result = await within(dialog).findByTestId('source-file-inspection');
    expect(within(result).getByTestId('source-file-inspection-status').textContent).toBe(
      '置けます',
    );
    expect(result.textContent).toContain('robot-json@1.0.0(CONFIRMED)');
    // 2026-10-09T02:00:00Z = 日本時間 11:00
    expect(within(result).getByTestId('source-file-observed-at').textContent).toBe(
      '2026/10/09 11:00:00',
    );
    expect(within(result).getByTestId('source-file-item-count').textContent).toBe('7 件');
    expect(within(result).queryByTestId('source-file-problems')).toBeNull();
    expect(within(result).queryByTestId('source-file-warnings')).toBeNull();
    expect(placeButton(dialog).disabled).toBe(false);
    const sent = callsOf(calls, 'POST', '/ingestion/equipment/ROBOT-1/source-file/check');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.rawBody).toBe(FILE_TEXT);
    expect(sent[0]?.contentType).toBe('application/json');
    expect(sent[0]?.authorization).toBe('Bearer access-token-1');
    // 検査だけでは、置かない
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-1/source-file')).toHaveLength(0);
  });

  it('置けない内容（ok: false）: 置けない理由を、エラーとして強調して示し、「置く」を無効のままにする', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/equipment/ROBOT-1/source-file/check': () => jsonResponse(INSPECTION_NG),
      }),
      { login: ADMIN },
    );
    const dialog = await openDialog();
    await chooseFile(dialog, jsonFile('{壊れた'));

    fireEvent.click(checkButton(dialog));

    const status = await within(dialog).findByTestId('source-file-inspection-status');
    expect(status.textContent).toBe('置けません');
    expect(status.className).toContain('form-error');
    const problems = within(dialog).getByTestId('source-file-problems');
    expect(within(problems).getByRole('heading', { name: '置けない理由' })).toBeDefined();
    expect(
      within(problems)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['JSON として読み取れません', '計測日時を読み取れません']);
    expect(within(dialog).getByTestId('source-file-observed-at').textContent).toBe(
      '読み取れませんでした',
    );
    expect(placeButton(dialog).disabled).toBe(true);
  });

  it('警告（warnings）: 置けるが、取り込みで「不正」になる点を、注意として示す（置くことはできる）', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/equipment/ROBOT-1/source-file/check': () =>
          jsonResponse({ ...INSPECTION_OK, warnings: ['harvestCount'] }),
      }),
      { login: ADMIN },
    );
    const dialog = await openDialog();
    await chooseFile(dialog);

    fireEvent.click(checkButton(dialog));

    const warnings = await within(dialog).findByTestId('source-file-warnings');
    expect(warnings.className).toContain('notice-warning');
    expect(
      within(warnings)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['harvestCount']);
    expect(placeButton(dialog).disabled).toBe(false);
  });

  it('確認のあとに、別のファイルを選ぶと、確認の結果を消し、「置く」を無効に戻す（確認していない内容を置かない）', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/equipment/ROBOT-1/source-file/check': () => jsonResponse(INSPECTION_OK),
      }),
      { login: ADMIN },
    );
    const dialog = await openDialog();
    await chooseFile(dialog);
    fireEvent.click(checkButton(dialog));
    await within(dialog).findByTestId('source-file-inspection');
    expect(placeButton(dialog).disabled).toBe(false);

    await chooseFile(dialog, jsonFile('{"other":1}', 'other.json'));

    expect(within(dialog).queryByTestId('source-file-inspection')).toBeNull();
    expect(placeButton(dialog).disabled).toBe(true);
    expect(within(dialog).getByTestId('source-file-selected').textContent).toContain('other.json');
  });

  it('1 MiB を超えるファイルは、送信せず、その場で、エラーを示す（確認も置くも使えない）。上限ちょうどは受け付ける', async () => {
    const { calls } = renderApp('/settings/ingestion', baseRoutes(), { login: ADMIN });
    const dialog = await openDialog();

    fireEvent.change(fileInput(dialog), {
      target: {
        files: [
          new File([new Uint8Array(SOURCE_FILE_MAX_BYTES + 1)], 'big.json', {
            type: 'application/json',
          }),
        ],
      },
    });

    const error = await within(dialog).findByText(/1 MiB を超える/);
    expect(error.closest('.field-error')).not.toBeNull();
    expect(fileInput(dialog).getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).queryByTestId('source-file-selected')).toBeNull();
    expect(checkButton(dialog).disabled).toBe(true);
    expect(placeButton(dialog).disabled).toBe(true);
    expect(calls.filter((call) => call.path.includes('source-file'))).toHaveLength(0);

    // 上限ちょうど（1 MiB）は、受け付ける
    await chooseFile(
      dialog,
      new File([new Uint8Array(SOURCE_FILE_MAX_BYTES)], 'limit.json', {
        type: 'application/json',
      }),
    );
    expect(within(dialog).getByTestId('source-file-selected').textContent).toBe(
      '選んだファイル: limit.json（1.0 MiB）',
    );
    expect(within(dialog).queryByText(/1 MiB を超える/)).toBeNull();
    expect(checkButton(dialog).disabled).toBe(false);
  });

  it('確認に失敗した場合（API のエラー）は、ダイアログの中に、API のメッセージを示す。ダイアログは閉じない', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/equipment/ROBOT-1/source-file/check': () =>
          errorBody(503, 'SERVICE_UNAVAILABLE', 'ファイルの保管先を利用できません'),
      }),
      { login: ADMIN },
    );
    const dialog = await openDialog();
    await chooseFile(dialog);

    fireEvent.click(checkButton(dialog));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe('ファイルの保管先を利用できません');
    expect(screen.getByRole('dialog', { name: 'ファイルを置く' })).toBeDefined();
    expect(placeButton(dialog).disabled).toBe(true);
    expect(checkButton(dialog).disabled).toBe(false);
  });

  it('確認の実行中は、「確認中…」と示し、確認・置く・選択を止める（二重送信の防止）。API は 1 回だけ呼ぶ', async () => {
    let release: (response: Response) => void = () => undefined;
    const { calls } = renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/equipment/ROBOT-1/source-file/check': () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      }),
      { login: ADMIN },
    );
    const dialog = await openDialog();
    await chooseFile(dialog);

    fireEvent.click(checkButton(dialog));

    await waitFor(() => {
      expect(checkButton(dialog).textContent).toBe('確認中…');
    });
    expect(checkButton(dialog).disabled).toBe(true);
    expect(placeButton(dialog).disabled).toBe(true);
    expect(fileInput(dialog).disabled).toBe(true);
    fireEvent.click(checkButton(dialog));
    expect(callsOf(calls, 'POST', '/ingestion/equipment/ROBOT-1/source-file/check')).toHaveLength(
      1,
    );

    release(jsonResponse(INSPECTION_OK));
    await waitFor(() => {
      expect(checkButton(dialog).textContent).toBe('内容を確認');
    });
    expect(placeButton(dialog).disabled).toBe(false);
  });
});

describe('SC-11: ファイルを置く（確認のダイアログ・結果の通知。Issue #565）', () => {
  /** 確認のあと、置くを押して、確認のダイアログを開く。 */
  async function openConfirm(
    routes: Routes = {},
    inspection: unknown = INSPECTION_OK,
  ): Promise<{
    dialog: HTMLElement;
    confirm: HTMLElement;
    calls: ReturnType<typeof renderApp>['calls'];
  }> {
    const { calls } = renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/equipment/ROBOT-1/source-file/check': () => jsonResponse(inspection),
        ...routes,
      }),
      { login: ADMIN },
    );
    const dialog = await openDialog();
    await chooseFile(dialog);
    fireEvent.click(checkButton(dialog));
    await within(dialog).findByTestId('source-file-inspection');
    fireEvent.click(placeButton(dialog));
    const confirm = await screen.findByTestId('confirm-dialog');
    return { dialog, confirm, calls };
  }

  it('「置く」で、確認のダイアログを開く。対象（設備名・ファイルの名前・大きさ・計測日時）をラベルと値の並びで示し、「同じパスのファイルは、置き換わります」と示す。この時点では、置かない', async () => {
    const { confirm, calls } = await openConfirm();

    expect(confirm.getAttribute('role')).toBe('alertdialog');
    expect(within(confirm).getByRole('heading', { name: 'ファイルを置きますか' })).toBeDefined();
    const labels = within(confirm)
      .getAllByRole('term')
      .map((term) => term.textContent);
    expect(labels).toEqual(['設備', 'ファイルの名前', '大きさ', '計測日時']);
    const values = within(confirm)
      .getAllByRole('definition')
      .map((definition) => definition.textContent);
    expect(values).toEqual([
      '収穫ロボット1',
      FILE_NAME,
      `${String(FILE_TEXT.length)} バイト`,
      '2026/10/09 11:00:00',
    ]);
    expect(confirm.textContent).toContain('同じパスのファイルは、置き換わります');
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-1/source-file')).toHaveLength(0);
  });

  it('確認のダイアログのキャンセル・Esc は、確認だけを閉じ、ファイルを置くダイアログ（選んだファイル・確認の結果）を残す。置かない', async () => {
    const { dialog, confirm, calls } = await openConfirm();

    fireEvent.click(within(confirm).getByRole('button', { name: 'キャンセル' }));

    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(dialog.isConnected).toBe(true);
    expect(within(dialog).getByTestId('source-file-inspection')).toBeDefined();
    expect(placeButton(dialog).disabled).toBe(false);

    fireEvent.click(placeButton(dialog));
    const again = await screen.findByTestId('confirm-dialog');
    fireEvent.keyDown(within(again).getByRole('button', { name: 'キャンセル' }), {
      key: 'Escape',
    });
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(dialog.isConnected).toBe(true);
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-1/source-file')).toHaveLength(0);
  });

  it('確定で、ファイルそのものを本文にして、置く API（PUT）を呼ぶ。成功したら、ダイアログを閉じ、結果を ResultNotice で示す（設備名・計測日時）。自動では、取り込まない', async () => {
    const { confirm, calls } = await openConfirm({
      'PUT /ingestion/equipment/ROBOT-1/source-file': () =>
        jsonResponse({ ...INSPECTION_OK, placedAt: '2026-10-09T03:00:00.000Z' }),
    });

    fireEvent.click(within(confirm).getByRole('button', { name: '置く' }));

    const notice = await screen.findByTestId('source-file-result-robot');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.className).toContain('form-success');
    expect(notice.textContent).toBe(
      'ファイルを置きました: 収穫ロボット1（計測日時 2026/10/09 11:00:00）',
    );
    expect(screen.queryByRole('dialog', { name: 'ファイルを置く' })).toBeNull();
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    const sent = callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-1/source-file');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.rawBody).toBe(FILE_TEXT);
    expect(sent[0]?.contentType).toBe('application/json');
    // 自動では、取り込まない
    expect(callsOf(calls, 'POST', '/ingestion/robot/run')).toHaveLength(0);
    // 開いたボタンへ、フォーカスを戻す
    expect(document.activeElement).toBe(openButton('収穫ロボット1'));
  });

  it('警告があれば、通知に、件数を示す', async () => {
    const { confirm } = await openConfirm(
      {
        'PUT /ingestion/equipment/ROBOT-1/source-file': () =>
          jsonResponse({
            ...INSPECTION_OK,
            warnings: ['harvestCount', 'batteryLevel'],
            placedAt: '2026-10-09T03:00:00.000Z',
          }),
      },
      { ...INSPECTION_OK, warnings: ['harvestCount', 'batteryLevel'] },
    );

    fireEvent.click(within(confirm).getByRole('button', { name: '置く' }));

    expect((await screen.findByTestId('source-file-result-robot')).textContent).toBe(
      'ファイルを置きました: 収穫ロボット1（計測日時 2026/10/09 11:00:00、注意 2 件）',
    );
  });

  it('通知から、「今すぐ取り込む」で、画面の「即時取得」と同じ処理（POST /ingestion/robot/run）を呼ぶ。実行したら、置いた通知は消え、取得の結果を示す', async () => {
    const { confirm, calls } = await openConfirm({
      'PUT /ingestion/equipment/ROBOT-1/source-file': () =>
        jsonResponse({ ...INSPECTION_OK, placedAt: '2026-10-09T03:00:00.000Z' }),
      'POST /ingestion/robot/run': () => jsonResponse(RUN_RESPONSE, 202),
    });
    fireEvent.click(within(confirm).getByRole('button', { name: '置く' }));
    const placed = await screen.findByTestId('source-file-placed-robot');
    expect(placed.textContent).toContain('取り込みは、まだ行っていません');
    expect(callsOf(calls, 'POST', '/ingestion/robot/run')).toHaveLength(0);

    fireEvent.click(within(placed).getByRole('button', { name: '今すぐ取り込む' }));

    expect((await screen.findByTestId('result-robot')).textContent).toBe(
      '取得しました（成功）: ファイル 1 件、取り込み 7 件、読み取れなかった記録 0 件',
    );
    expect(callsOf(calls, 'POST', '/ingestion/robot/run')).toHaveLength(1);
    expect(screen.queryByTestId('source-file-placed-robot')).toBeNull();
  });

  it('取り込みの実行の権限がなければ、通知に、「今すぐ取り込む」を出さない（案内の文だけ）', async () => {
    renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/equipment/ROBOT-1/source-file/check': () => jsonResponse(INSPECTION_OK),
        'PUT /ingestion/equipment/ROBOT-1/source-file': () =>
          jsonResponse({ ...INSPECTION_OK, placedAt: '2026-10-09T03:00:00.000Z' }),
      }),
      { login: loginWith(['ingestion:read', 'ingestion:configure']) },
    );
    const dialog = await openDialog();
    await chooseFile(dialog);
    fireEvent.click(checkButton(dialog));
    await within(dialog).findByTestId('source-file-inspection');
    fireEvent.click(placeButton(dialog));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', { name: '置く' }),
    );

    const placed = await screen.findByTestId('source-file-placed-robot');
    expect(within(placed).queryByRole('button', { name: '今すぐ取り込む' })).toBeNull();
  });

  it('置けなかった場合（400 など）は、確認のダイアログを閉じ、ファイルを置くダイアログの中に、API のメッセージを示す（通知は出さない）。やり直せる', async () => {
    const { dialog, confirm } = await openConfirm({
      'PUT /ingestion/equipment/ROBOT-1/source-file': () =>
        errorBody(400, 'VALIDATION_ERROR', 'ファイルの内容が、仕様と合いません', [
          { name: 'content', message: '計測日時を読み取れません' },
        ]),
    });

    fireEvent.click(within(confirm).getByRole('button', { name: '置く' }));

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe('ファイルの内容が、仕様と合いません');
    expect(dialog.isConnected).toBe(true);
    expect(screen.queryByTestId('source-file-result-robot')).toBeNull();
    expect(placeButton(dialog).disabled).toBe(false);
  });

  it.each([
    [413, 'VALIDATION_ERROR', 'リクエストが大きすぎます'],
    [503, 'SERVICE_UNAVAILABLE', 'ファイルの保管先を利用できません'],
  ])(
    '置く API が %i を返したら、メッセージを、ダイアログの中に示す',
    async (status, code, message) => {
      const { dialog, confirm } = await openConfirm({
        'PUT /ingestion/equipment/ROBOT-1/source-file': () => errorBody(status, code, message),
      });

      fireEvent.click(within(confirm).getByRole('button', { name: '置く' }));

      expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
    },
  );

  it('置く API がネットワークのエラーのときも、ダイアログの中に、メッセージを示す（接続先・内部情報は示さない）', async () => {
    const { dialog, confirm } = await openConfirm({
      'PUT /ingestion/equipment/ROBOT-1/source-file': () => {
        throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:1');
      },
    });

    fireEvent.click(within(confirm).getByRole('button', { name: '置く' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).not.toContain('ECONNREFUSED');
    expect(alert.textContent).not.toContain('127.0.0.1');
    expect(alert.textContent.length).toBeGreaterThan(0);
  });

  it('置いている間は、確認のダイアログの「置く」を、「置いています…」にして使えなくする（二重送信の防止）。API は 1 回だけ呼ぶ', async () => {
    let release: (response: Response) => void = () => undefined;
    const { confirm, calls } = await openConfirm({
      'PUT /ingestion/equipment/ROBOT-1/source-file': () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });

    fireEvent.click(within(confirm).getByRole('button', { name: '置く' }));

    const busy = await within(confirm).findByRole<HTMLButtonElement>('button', {
      name: '置いています…',
    });
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/ROBOT-1/source-file')).toHaveLength(1);

    release(jsonResponse({ ...INSPECTION_OK, placedAt: '2026-10-09T03:00:00.000Z' }));
    expect(await screen.findByTestId('source-file-result-robot')).toBeDefined();
  });

  it('センサーの設備でも、同じように置ける（設備の API は、その設備の識別子）', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      baseRoutes({
        'POST /ingestion/equipment/SENSOR-1/source-file/check': () => jsonResponse(INSPECTION_OK),
        'PUT /ingestion/equipment/SENSOR-1/source-file': () =>
          jsonResponse({ ...INSPECTION_OK, placedAt: '2026-10-09T03:00:00.000Z' }),
      }),
      { login: ADMIN },
    );
    const dialog = await openDialog('環境センサー1');
    await chooseFile(dialog);
    fireEvent.click(checkButton(dialog));
    await within(dialog).findByTestId('source-file-inspection');
    fireEvent.click(placeButton(dialog));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', { name: '置く' }),
    );

    expect((await screen.findByTestId('source-file-result-environment-sensor')).textContent).toBe(
      'ファイルを置きました: 環境センサー1（計測日時 2026/10/09 11:00:00）',
    );
    expect(callsOf(calls, 'PUT', '/ingestion/equipment/SENSOR-1/source-file')).toHaveLength(1);
  });
});
