import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import { STATUS_CODES_RESPONSE } from '../../support/viewpoint-fixtures.ts';
import {
  READ_ONLY_LOGIN,
  at,
  callsOf,
  confirmDetailsOf,
  confirmNotesOf,
  errorBody,
  noContent,
  renderApp,
} from '../../support/management-frontend.ts';
import { expectCardLabels } from '../../support/card-table.ts';

const CODES = {
  items: [
    ...STATUS_CODES_RESPONSE.items,
    {
      code: 'CHARGING',
      name: '充電中',
      description: '充電器に接続している',
      category: 'CAUTION',
      isDeleted: false,
    },
  ],
};
const SAVED = { code: 'CHARGING', name: '充電中', category: 'CAUTION', isDeleted: false };

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

/** 登録のフォーム。登録は、ダイアログで行う（#366）。表の上のボタンで開いて、フォームを返す。 */
function openAddForm(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'ステータスコードの登録' }));
  return screen.getByTestId('status-code-add');
}

describe('ステータスコード（UC-17。SC-12）', () => {
  it('定義を、コード値・名称・カテゴリ・説明で表示する。説明がなければ「—」', async () => {
    renderApp('/settings/status-codes', { 'GET /status-codes': () => jsonResponse(CODES) });
    const rows = await screen.findAllByTestId('status-code-row');
    expect(rows.map((row) => row.getAttribute('data-code'))).toEqual([
      'HARVESTING',
      'FALLEN',
      'CHARGING',
    ]);
    expect(rows[0]?.querySelectorAll('td')[3]?.textContent).toBe('—');
    expect(rows[2]?.textContent).toContain('充電器に接続している');
    expect(rows[2]?.textContent).toContain('注意');
  });

  it('「カテゴリの見かた」の凡例は、はじめは閉じている。開くと、正常・注意・異常の意味と対応の目安を示し、「不明」は示さない。もう一度押すと閉じる', async () => {
    renderApp('/settings/status-codes', { 'GET /status-codes': () => jsonResponse(CODES) });
    await screen.findAllByTestId('status-code-row');
    const toggle = screen.getByRole('button', { name: 'カテゴリの見かた' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('status-code-legend-body')).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = screen.getByTestId('status-code-legend-body');
    expect(within(body).getByTestId('status-code-legend-NORMAL').textContent).toContain(
      '判断基準を満たしています',
    );
    expect(within(body).getByTestId('status-code-legend-CAUTION').textContent).toContain(
      '農作業者の確認が望ましい',
    );
    expect(within(body).getByTestId('status-code-legend-ERROR').textContent).toContain(
      '農作業者の対応が必要',
    );
    expect(within(body).queryByTestId('status-code-legend-UNKNOWN')).toBeNull();
    // カテゴリが、判定にどう使われるか
    expect(body.textContent).toContain('収穫速度・メンテナンス性・耐久性');

    fireEvent.click(toggle);
    expect(screen.queryByTestId('status-code-legend-body')).toBeNull();
  });

  it('変更する権限がなくても、凡例を開ける', async () => {
    renderApp('/settings/status-codes', {}, { login: READ_ONLY_LOGIN });
    await screen.findAllByTestId('status-code-row');
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリの見かた' }));
    expect(screen.getByTestId('status-code-legend-body')).toBeDefined();
  });

  it('定義がなければ、その旨を表示する', async () => {
    renderApp('/settings/status-codes', { 'GET /status-codes': () => jsonResponse({ items: [] }) });
    expect((await screen.findByTestId('status-codes-empty')).textContent).toContain(
      '登録されていません',
    );
  });

  it('変更する権限がなければ、参照のみ', async () => {
    renderApp('/settings/status-codes', {}, { login: READ_ONLY_LOGIN });
    await screen.findAllByTestId('status-code-row');
    expect(screen.getByTestId('permission-notice').textContent).toContain('権限がありません');
    expect(screen.queryByRole('button', { name: '修正' })).toBeNull();
    expect(screen.queryByTestId('status-code-add')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ステータスコードの登録' })).toBeNull();
  });

  it('取得に失敗した場合は、エラーを表示し、再読み込みできる', async () => {
    let failing = true;
    renderApp('/settings/status-codes', {
      'GET /status-codes': () =>
        failing ? errorBody(500, 'INTERNAL_ERROR', '取得できません') : jsonResponse(CODES),
    });
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toContain('取得できません');
    failing = false;
    fireEvent.click(at(screen.getAllByRole('button', { name: '再読み込み' }), 0));
    expect(await screen.findAllByTestId('status-code-row')).toHaveLength(3);
  });

  it('登録: コード値・名称が必須で、コード値は英大文字・数字・アンダースコア。登録すると、一覧を読み直す', async () => {
    const { calls } = renderApp('/settings/status-codes', {
      'POST /status-codes': () => jsonResponse(SAVED, 201),
    });
    await screen.findAllByTestId('status-code-row');
    const form = openAddForm();

    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    expect(within(form).getByText('コード値は必須です')).toBeDefined();
    expect(within(form).getByText('名称は必須です')).toBeDefined();

    fireEvent.change(within(form).getByLabelText('コード値', { exact: false }), {
      target: { value: 'charging' },
    });
    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '充電中' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    expect(
      await within(form).findByText('コード値は英大文字・数字・アンダースコアで指定してください'),
    ).toBeDefined();
    expect(callsOf(calls, 'POST', '/status-codes')).toHaveLength(0);

    fireEvent.change(within(form).getByLabelText('コード値', { exact: false }), {
      target: { value: 'CHARGING' },
    });
    fireEvent.change(within(form).getByLabelText('カテゴリ', { exact: false }), {
      target: { value: 'CAUTION' },
    });
    fireEvent.change(within(form).getByLabelText('説明'), {
      target: { value: '充電器に接続している' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    expect((await screen.findByTestId('status-codes-notice')).textContent).toBe('登録しました');
    expect(callsOf(calls, 'POST', '/status-codes')[0]?.body).toEqual({
      code: 'CHARGING',
      name: '充電中',
      category: 'CAUTION',
      description: '充電器に接続している',
    });
    // 登録に成功すると、ダイアログは閉じる。開き直すと、入力は空
    expect(screen.queryByTestId('status-code-add')).toBeNull();
    expect(
      within(openAddForm()).getByLabelText<HTMLInputElement>('コード値', { exact: false }).value,
    ).toBe('');
  });

  it('説明が空なら、説明を送らない。コード値が重複した場合は、サーバーのエラーを項目に表示する。その他のエラーは画面に表示する', async () => {
    let attempt = 0;
    const { calls } = renderApp('/settings/status-codes', {
      'POST /status-codes': () => {
        attempt += 1;
        return attempt === 1
          ? errorBody(409, 'CONFLICT', '入力内容を確認してください', [
              { name: 'code', message: 'コード値は、すでに使われています' },
            ])
          : errorBody(500, 'INTERNAL_ERROR', '登録できませんでした');
      },
    });
    await screen.findAllByTestId('status-code-row');
    const form = openAddForm();
    fireEvent.change(within(form).getByLabelText('コード値', { exact: false }), {
      target: { value: 'HARVESTING' },
    });
    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '重複' },
    });
    fireEvent.change(within(form).getByLabelText('説明'), { target: { value: '  ' } });

    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    expect(await within(form).findByText('コード値は、すでに使われています')).toBeDefined();
    expect(callsOf(calls, 'POST', '/status-codes')[0]?.body).not.toHaveProperty('description');

    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    await waitFor(() => {
      expect(within(form).getByRole('alert').textContent).toBe('登録できませんでした');
    });
  });

  it('編集: コード値は変更できない。名称・カテゴリ・説明を変更して保存すると、更新して一覧を読み直す。キャンセルで閉じる', async () => {
    const { calls } = renderApp('/settings/status-codes', {
      'GET /status-codes': () => jsonResponse(CODES),
      'PUT /status-codes/CHARGING': () => jsonResponse(SAVED),
    });
    const rows = await screen.findAllByTestId('status-code-row');
    fireEvent.click(within(at(rows, 2)).getByRole('button', { name: '修正' }));
    const form = await screen.findByTestId('status-code-edit');
    expect(within(form).queryByLabelText('コード値', { exact: false })).toBeNull();
    expect(within(form).getByLabelText<HTMLInputElement>('名称', { exact: false }).value).toBe(
      '充電中',
    );

    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    expect(within(form).getByText('名称は必須です')).toBeDefined();

    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '充電中（急速）' },
    });
    fireEvent.change(within(form).getByLabelText('カテゴリ', { exact: false }), {
      target: { value: 'ERROR' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    expect((await screen.findByTestId('status-codes-notice')).textContent).toBe('修正しました');
    expect(callsOf(calls, 'PUT', '/status-codes/CHARGING')[0]?.body).toEqual({
      name: '充電中（急速）',
      category: 'ERROR',
      description: '充電器に接続している',
    });
    expect(screen.queryByTestId('status-code-edit')).toBeNull();

    fireEvent.click(
      within(at(await screen.findAllByTestId('status-code-row'), 0)).getByRole('button', {
        name: '修正',
      }),
    );
    fireEvent.click(
      within(await screen.findByTestId('status-code-edit')).getByRole('button', {
        name: 'キャンセル',
      }),
    );
    expect(screen.queryByTestId('status-code-edit')).toBeNull();
  });

  it('編集の保存に失敗した場合は、エラーを表示する', async () => {
    renderApp('/settings/status-codes', {
      'PUT /status-codes/HARVESTING': () =>
        errorBody(500, 'INTERNAL_ERROR', '修正できませんでした'),
    });
    const rows = await screen.findAllByTestId('status-code-row');
    fireEvent.click(within(at(rows, 0)).getByRole('button', { name: '修正' }));
    const form = await screen.findByTestId('status-code-edit');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('修正できませんでした');
  });

  it('削除: 評価への影響を示す確認のダイアログ。確定すると削除して一覧を読み直す。キャンセルなら何もしない', async () => {
    const { calls } = renderApp('/settings/status-codes', {
      'DELETE /status-codes/FALLEN': () => noContent(),
    });
    const rows = await screen.findAllByTestId('status-code-row');

    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '削除' }));
    let dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain('不正な値');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    expect(callsOf(calls, 'DELETE', '/status-codes/FALLEN')).toHaveLength(0);

    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '削除' }));
    dialog = await screen.findByTestId('confirm-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '削除' }));

    expect((await screen.findByTestId('status-codes-notice')).textContent).toBe('削除しました');
    expect(callsOf(calls, 'DELETE', '/status-codes/FALLEN')).toHaveLength(1);
  });

  it('削除の確認は、対象（コード値・名称）と、影響（次の評価から反映・過去の評価は保持・影響する観点）の静的な説明を示す（#153。SC-12-2・SC-12-3）', async () => {
    renderApp('/settings/status-codes', { 'GET /status-codes': () => jsonResponse(CODES) });
    const rows = await screen.findAllByTestId('status-code-row');

    fireEvent.click(within(at(rows, 2)).getByRole('button', { name: '削除' }));

    const dialog = await screen.findByTestId('confirm-dialog');
    expect(confirmDetailsOf(dialog)).toEqual({ コード値: 'CHARGING', 名称: '充電中' });
    expect(dialog.textContent).toContain('不正な値');
    expect(confirmNotesOf(dialog)).toEqual([
      '削除は、次の評価から反映されます。過去の評価は、そのまま保持します',
      '影響する観点: 収穫速度・メンテナンス性・耐久性',
    ]);
  });

  it('カテゴリの変更の影響（次の評価から反映・過去の評価は保持・影響する観点）を、修正のダイアログのカテゴリの欄に常に示す。登録のダイアログには、示さない（#153。SC-12-3）', async () => {
    renderApp('/settings/status-codes', { 'GET /status-codes': () => jsonResponse(CODES) });
    const rows = await screen.findAllByTestId('status-code-row');

    fireEvent.click(within(at(rows, 0)).getByRole('button', { name: '修正' }));
    const edit = await screen.findByTestId('status-code-edit');
    const category = within(edit).getByLabelText('カテゴリ', { exact: false });
    const hint = within(edit).getByText(/次の評価から反映されます/);
    expect(hint.textContent).toBe(
      'カテゴリを変えると、次の評価から反映されます。過去の評価は、そのまま保持します。影響する観点: 収穫速度・メンテナンス性・耐久性',
    );
    expect(category.getAttribute('aria-describedby')).toBe(hint.id);
    fireEvent.click(within(edit).getByRole('button', { name: 'キャンセル' }));

    const add = openAddForm();
    expect(within(add).queryByText(/次の評価から反映されます/)).toBeNull();
  });

  it('削除に失敗した場合は、エラーを表示する', async () => {
    renderApp('/settings/status-codes', {
      'DELETE /status-codes/FALLEN': () => errorBody(500, 'INTERNAL_ERROR', '削除できませんでした'),
    });
    const rows = await screen.findAllByTestId('status-code-row');
    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '削除' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', { name: '削除' }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole('alert').some((node) => node.textContent === '削除できませんでした'),
      ).toBe(true);
    });
  });
});

describe('ステータスコードの表の、狭い幅のカード（#151。SC-12）', () => {
  it('各セルが、同じ列の見出しを、カードの項目名（data-label）として持つ', async () => {
    renderApp('/settings/status-codes', { 'GET /status-codes': () => jsonResponse(CODES) });
    await screen.findAllByTestId('status-code-row');

    expectCardLabels();
  });
});

describe('ステータスコード: 登録・修正は、ダイアログで行う（Issue #366）', () => {
  it('表の上に、「ステータスコードの登録」のボタンがあり、押すまで、登録のフォームは出ない。キャンセル・Esc で閉じる', async () => {
    renderApp('/settings/status-codes');
    await screen.findAllByTestId('status-code-row');

    expect(screen.queryByTestId('status-code-add')).toBeNull();
    const button = screen.getByRole('button', { name: 'ステータスコードの登録' });
    const table = document.querySelector('table') as HTMLElement;
    expect(button.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'ステータスコードを登録' })).toBeDefined();
    fireEvent.click(
      within(screen.getByTestId('status-code-add')).getByRole('button', { name: 'キャンセル' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('一覧が空でも、登録のボタンは表示する（最初の 1 件を登録できる）', async () => {
    renderApp('/settings/status-codes', {
      'GET /status-codes': () => jsonResponse({ items: [] }),
    });
    await screen.findByTestId('status-codes-empty');

    expect(screen.getByRole('button', { name: 'ステータスコードの登録' })).toBeDefined();
  });

  it('修正のボタンで、ダイアログが開く（名前は、「〇〇を修正」）', async () => {
    renderApp('/settings/status-codes');
    const rows = await screen.findAllByTestId('status-code-row');

    fireEvent.click(within(at(rows, 0)).getByRole('button', { name: '修正' }));

    expect(screen.getByRole('dialog', { name: /を修正/ })).toBeDefined();
  });
});

describe('ステータスコード: 未登録のコード値の一覧（SC-12-5。Issue #158）', () => {
  const UNREGISTERED = {
    items: [
      {
        code: 'LOW_BATTERY',
        count: 12,
        lastSeenAt: '2026-11-20T03:00:00.000Z',
        isRegistrable: true,
        suggestedCode: 'LOW_BATTERY',
      },
      {
        code: 'low battery',
        count: 5,
        lastSeenAt: '2026-11-19T00:30:00.000Z',
        isRegistrable: false,
        suggestedCode: 'LOW_BATTERY_2',
      },
      {
        code: '充電異常',
        count: 1,
        lastSeenAt: '2026-11-18T00:00:00.000Z',
        isRegistrable: false,
      },
    ],
  };

  const panel = (): HTMLElement => screen.getByTestId('unregistered-codes');
  const unregisteredRows = (): HTMLElement[] => within(panel()).getAllByTestId('unregistered-row');

  it('管理者には、コード値・件数・最後に取り込んだ日時を、API の順（件数の多い順）で示す。取得は 1 回で、自動では更新しない', async () => {
    const { calls } = renderApp('/settings/status-codes', {
      'GET /status-codes/unregistered': () => jsonResponse(UNREGISTERED),
    });
    await screen.findAllByTestId('unregistered-row');

    expect(unregisteredRows().map((row) => row.getAttribute('data-code'))).toEqual([
      'LOW_BATTERY',
      'low battery',
      '充電異常',
    ]);
    const first = at(unregisteredRows(), 0);
    expect(first.textContent).toContain('12');
    expect(first.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-20T03:00:00.000Z');
    expect(within(panel()).getByRole('heading', { name: '未登録のコード値' })).toBeDefined();
    // 登録後に取り込む分から有効になること・保存済みの値は評価し直さないことの注記
    expect(panel().textContent).toContain('登録した後に取り込む');
    expect(panel().textContent).toContain('評価し直しません');
    expect(callsOf(calls, 'GET', '/status-codes/unregistered')).toHaveLength(1);
  });

  it('表は、狭い幅のカードにする（各セルが、同じ列の見出しを項目名として持つ）', async () => {
    renderApp('/settings/status-codes', {
      'GET /status-codes/unregistered': () => jsonResponse(UNREGISTERED),
    });
    await screen.findAllByTestId('unregistered-row');

    const table = within(panel()).getByRole('table');
    expect(table.classList.contains('card-table')).toBe(true);
    expectCardLabels(table as HTMLTableElement);
  });

  it('0 件なら、空の状態の文言を示す', async () => {
    renderApp('/settings/status-codes');
    expect((await screen.findByTestId('unregistered-codes-empty')).textContent).toContain(
      '未登録のコード値はありません',
    );
  });

  it('取得に失敗したら、エラーと再読み込みを示す。定義の一覧は、影響を受けない', async () => {
    let failing = true;
    renderApp('/settings/status-codes', {
      'GET /status-codes/unregistered': () =>
        failing
          ? errorBody(500, 'INTERNAL_ERROR', '未登録の値を取得できません')
          : jsonResponse(UNREGISTERED),
    });
    const alert = await within(await screen.findByTestId('unregistered-codes')).findByRole('alert');
    expect(alert.textContent).toContain('未登録の値を取得できません');
    expect(await screen.findAllByTestId('status-code-row')).toHaveLength(2);
    failing = false;
    fireEvent.click(within(panel()).getByRole('button', { name: '再読み込み' }));
    expect(await within(panel()).findAllByTestId('unregistered-row')).toHaveLength(3);
  });

  it('「更新」で読み直す', async () => {
    let items = UNREGISTERED.items.slice(0, 1);
    const { calls } = renderApp('/settings/status-codes', {
      'GET /status-codes/unregistered': () => jsonResponse({ items }),
    });
    await screen.findAllByTestId('unregistered-row');
    expect(unregisteredRows()).toHaveLength(1);

    items = UNREGISTERED.items;
    fireEvent.click(within(panel()).getByRole('button', { name: '更新' }));
    await waitFor(() => {
      expect(unregisteredRows()).toHaveLength(3);
    });
    expect(callsOf(calls, 'GET', '/status-codes/unregistered')).toHaveLength(2);
  });

  it('登録できる形式の行は、「登録」で登録のダイアログを開き、コード値を初期値にする。登録すると、定義と未登録の一覧の両方を読み直す', async () => {
    let registered = false;
    const { calls } = renderApp('/settings/status-codes', {
      'GET /status-codes/unregistered': () =>
        jsonResponse({ items: registered ? UNREGISTERED.items.slice(1) : UNREGISTERED.items }),
      'POST /status-codes': () => {
        registered = true;
        return jsonResponse(
          { code: 'LOW_BATTERY', name: '電池残量が少ない', category: 'NORMAL', isDeleted: false },
          201,
        );
      },
    });
    await screen.findAllByTestId('unregistered-row');

    fireEvent.click(within(at(unregisteredRows(), 0)).getByRole('button', { name: '登録' }));
    const dialog = await screen.findByRole('dialog', { name: 'ステータスコードを登録' });
    const form = within(dialog).getByTestId('status-code-add');
    expect(within(form).getByLabelText<HTMLInputElement>('コード値', { exact: false }).value).toBe(
      'LOW_BATTERY',
    );
    expect(dialog.textContent).toContain('登録した後に取り込む');

    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '電池残量が少ない' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    expect((await screen.findByTestId('status-codes-notice')).textContent).toBe('登録しました');
    expect(callsOf(calls, 'POST', '/status-codes')[0]?.body).toEqual({
      code: 'LOW_BATTERY',
      name: '電池残量が少ない',
      category: 'NORMAL',
    });
    await waitFor(() => {
      expect(unregisteredRows().map((row) => row.getAttribute('data-code'))).toEqual([
        'low battery',
        '充電異常',
      ]);
    });
    expect(callsOf(calls, 'GET', '/status-codes')).toHaveLength(2);
  });

  it('登録できる形式の値でも、キャンセルで閉じる。通常の登録を開くと、初期値は空で、一覧からの注記は出ない', async () => {
    renderApp('/settings/status-codes', {
      'GET /status-codes/unregistered': () => jsonResponse(UNREGISTERED),
    });
    await screen.findAllByTestId('unregistered-row');

    fireEvent.click(within(at(unregisteredRows(), 0)).getByRole('button', { name: '登録' }));
    const form = await screen.findByTestId('status-code-add');
    expect(screen.getByRole('dialog').textContent).toContain('「LOW_BATTERY」を登録します');
    fireEvent.click(within(form).getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'ステータスコードの登録' }));
    expect(
      within(screen.getByTestId('status-code-add')).getByLabelText<HTMLInputElement>('コード値', {
        exact: false,
      }).value,
    ).toBe('');
    expect(screen.queryByTestId('status-code-add-note')).toBeNull();
  });

  it('登録できない形式の行は、「登録できない形式」と理由を示し、登録のボタンを出さない（案があれば、形式の例を示す）', async () => {
    renderApp('/settings/status-codes', {
      'GET /status-codes/unregistered': () => jsonResponse(UNREGISTERED),
    });
    await screen.findAllByTestId('unregistered-row');

    const withExample = at(unregisteredRows(), 1);
    expect(withExample.textContent).toContain('low battery');
    expect(withExample.textContent).toContain('登録できない形式');
    expect(withExample.textContent).toContain('「LOW_BATTERY_2」のような形式なら、登録できます');
    expect(within(withExample).queryByRole('button', { name: '登録' })).toBeNull();

    const noExample = at(unregisteredRows(), 2);
    expect(noExample.textContent).toContain('充電異常');
    expect(noExample.textContent).toContain('登録できない形式');
    expect(noExample.textContent).not.toContain('のような形式');
    expect(within(noExample).queryByRole('button', { name: '登録' })).toBeNull();
  });

  it('変更する権限がなければ、一覧を出さず、取得もしない', async () => {
    const { calls } = renderApp(
      '/settings/status-codes',
      { 'GET /status-codes/unregistered': () => jsonResponse(UNREGISTERED) },
      { login: READ_ONLY_LOGIN },
    );
    await screen.findAllByTestId('status-code-row');

    expect(screen.queryByTestId('unregistered-codes')).toBeNull();
    expect(callsOf(calls, 'GET', '/status-codes/unregistered')).toHaveLength(0);
  });
});
