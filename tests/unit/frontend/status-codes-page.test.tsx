import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import { STATUS_CODES_RESPONSE } from '../../support/viewpoint-fixtures.ts';
import {
  READ_ONLY_LOGIN,
  at,
  callsOf,
  errorBody,
  noContent,
  renderApp,
} from '../../support/management-frontend.ts';

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

describe('ステータスコード管理（UC-17。SC-12）', () => {
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
    const form = screen.getByTestId('status-code-add');

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
    expect(
      within(screen.getByTestId('status-code-add')).getByLabelText<HTMLInputElement>('コード値', {
        exact: false,
      }).value,
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
    const form = screen.getByTestId('status-code-add');
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
