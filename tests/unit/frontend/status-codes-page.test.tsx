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
