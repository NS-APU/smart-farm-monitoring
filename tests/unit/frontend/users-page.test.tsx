import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import {
  READ_ONLY_LOGIN,
  at,
  callsOf,
  errorBody,
  noContent,
  renderApp,
} from '../../support/management-frontend.ts';
import { expectCardLabels } from '../../support/card-table.ts';

const USERS = {
  items: [
    {
      userId: 'worker-1',
      userName: '農作業者A',
      role: 'worker',
      lastLoginAt: '2026-10-09T02:00:00.000Z',
    },
    { userId: 'viewer-1', userName: '閲覧者B', role: 'viewer' },
    { userId: 'other-1', userName: '他の利用者', role: 'retired-role' },
  ],
  roles: [
    { roleId: 'worker', name: '農作業者' },
    { roleId: 'viewer', name: '閲覧者' },
  ],
};
const SAVED = { userId: 'new-1', userName: '新しい利用者', role: 'viewer' };
const GOOD_PASSWORD = 'Dummy-Passw0rd';

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

function routes(extra = {}) {
  return { 'GET /users': () => jsonResponse(USERS), ...extra };
}

describe('ユーザー管理（UC-14。SC-14）', () => {
  it('権限（user:manage）がなければ、その旨を示し、一覧を取得しない', async () => {
    const { calls } = renderApp('/settings/users', {}, { login: READ_ONLY_LOGIN });
    expect((await screen.findByTestId('permission-notice')).textContent).toBe(
      'ユーザーを管理する権限がありません',
    );
    expect(callsOf(calls, 'GET', '/users')).toHaveLength(0);
    expect(screen.queryByTestId('user-add')).toBeNull();
  });

  it('ユーザーを、ID・名前・ロール名・最終ログインで表示する。ログイン中の本人は示し、削除できない', async () => {
    renderApp('/settings/users', routes());
    const rows = await screen.findAllByTestId('user-row');

    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('（ログイン中）');
    expect(rows[0]?.textContent).toContain('農作業者');
    expect(
      within(at(rows, 0)).getByRole<HTMLButtonElement>('button', { name: '削除' }).disabled,
    ).toBe(true);
    expect(rows[1]?.textContent).toContain('未ログイン');
    // 未知のロールは、ロールの識別子のまま
    expect(rows[2]?.textContent).toContain('retired-role');
  });

  it('取得に失敗した場合は、エラーを表示し、再読み込みできる', async () => {
    let failing = true;
    renderApp('/settings/users', {
      'GET /users': () =>
        failing ? errorBody(500, 'INTERNAL_ERROR', '取得できません') : jsonResponse(USERS),
    });
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toContain('取得できません');
    failing = false;
    fireEvent.click(at(screen.getAllByRole('button', { name: '再読み込み' }), 0));
    expect(await screen.findAllByTestId('user-row')).toHaveLength(3);
  });

  it('登録: ID・名前・パスワード・ロールが必須で、パスワードは条件を満たす必要がある。登録すると一覧を読み直す', async () => {
    const { calls } = renderApp(
      '/settings/users',
      routes({ 'POST /users': () => jsonResponse(SAVED, 201) }),
    );
    await screen.findAllByTestId('user-row');
    const form = screen.getByTestId('user-add');

    fireEvent.change(within(form).getByLabelText('ロール', { exact: false }), {
      target: { value: '' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    expect(within(form).getByText('ユーザーIDは必須です')).toBeDefined();
    expect(within(form).getByText('ユーザー名は必須です')).toBeDefined();
    expect(form.querySelector('[data-field="role"] .field-error')?.textContent).toBe(
      'ロールを選択してください',
    );

    fireEvent.change(within(form).getByLabelText('ユーザーID', { exact: false }), {
      target: { value: 'new-1' },
    });
    fireEvent.change(within(form).getByLabelText('ユーザー名', { exact: false }), {
      target: { value: '新しい利用者' },
    });
    fireEvent.change(within(form).getByLabelText('ロール', { exact: false }), {
      target: { value: 'viewer' },
    });
    for (const [password, message] of [
      ['Ab1', 'パスワードは8文字以上で指定してください'],
      ['alllowercase1', 'パスワードは英大文字・英小文字・数字を含めてください'],
    ] as const) {
      fireEvent.change(within(form).getByLabelText('パスワード', { exact: false }), {
        target: { value: password },
      });
      fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
      expect(await within(form).findByText(message)).toBeDefined();
    }
    expect(callsOf(calls, 'POST', '/users')).toHaveLength(0);

    fireEvent.change(within(form).getByLabelText('パスワード', { exact: false }), {
      target: { value: GOOD_PASSWORD },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    expect((await screen.findByTestId('users-notice')).textContent).toBe('登録しました');
    expect(callsOf(calls, 'POST', '/users')[0]?.body).toEqual({
      userId: 'new-1',
      userName: '新しい利用者',
      password: GOOD_PASSWORD,
      role: 'viewer',
    });
    expect(
      within(screen.getByTestId('user-add')).getByLabelText<HTMLInputElement>('パスワード', {
        exact: false,
      }).value,
    ).toBe('');
  });

  it('IDが重複した場合は、項目にエラーを表示する。その他のエラーは、画面に表示する', async () => {
    let attempt = 0;
    renderApp(
      '/settings/users',
      routes({
        'POST /users': () => {
          attempt += 1;
          return attempt === 1
            ? errorBody(409, 'CONFLICT', '入力内容を確認してください', [
                { name: 'userId', message: 'ユーザーIDは、すでに使われています' },
              ])
            : errorBody(500, 'INTERNAL_ERROR', '登録できませんでした');
        },
      }),
    );
    await screen.findAllByTestId('user-row');
    const form = screen.getByTestId('user-add');
    fireEvent.change(within(form).getByLabelText('ユーザーID', { exact: false }), {
      target: { value: 'worker-1' },
    });
    fireEvent.change(within(form).getByLabelText('ユーザー名', { exact: false }), {
      target: { value: '重複' },
    });
    fireEvent.change(within(form).getByLabelText('パスワード', { exact: false }), {
      target: { value: GOOD_PASSWORD },
    });

    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    expect(await within(form).findByText('ユーザーIDは、すでに使われています')).toBeDefined();
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    await waitFor(() => {
      expect(within(form).getByRole('alert').textContent).toBe('登録できませんでした');
    });
  });

  it('編集: ユーザーIDは変更できない。パスワードは、変更する場合のみ送る', async () => {
    const { calls } = renderApp(
      '/settings/users',
      routes({ 'PUT /users/viewer-1': () => jsonResponse(SAVED) }),
    );
    const rows = await screen.findAllByTestId('user-row');
    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '修正' }));
    const form = await screen.findByTestId('user-edit');
    expect(within(form).queryByLabelText('ユーザーID', { exact: false })).toBeNull();

    fireEvent.change(within(form).getByLabelText('ユーザー名', { exact: false }), {
      target: { value: '' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    expect(within(form).getByText('ユーザー名は必須です')).toBeDefined();

    fireEvent.change(within(form).getByLabelText('ユーザー名', { exact: false }), {
      target: { value: '閲覧者B2' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    expect((await screen.findByTestId('users-notice')).textContent).toBe('修正しました');
    expect(callsOf(calls, 'PUT', '/users/viewer-1')[0]?.body).toEqual({
      userName: '閲覧者B2',
      role: 'viewer',
    });

    fireEvent.click(
      within(at(await screen.findAllByTestId('user-row'), 1)).getByRole('button', { name: '修正' }),
    );
    const second = await screen.findByTestId('user-edit');
    fireEvent.change(within(second).getByLabelText('パスワード', { exact: false }), {
      target: { value: 'weak' },
    });
    fireEvent.click(within(second).getByRole('button', { name: '保存' }));
    expect(
      await within(second).findByText('パスワードは8文字以上で指定してください'),
    ).toBeDefined();
    fireEvent.change(within(second).getByLabelText('パスワード', { exact: false }), {
      target: { value: GOOD_PASSWORD },
    });
    fireEvent.click(within(second).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(callsOf(calls, 'PUT', '/users/viewer-1')[1]?.body).toMatchObject({
        password: GOOD_PASSWORD,
      });
    });
  });

  it('編集の保存に失敗した場合は、エラーを表示する。キャンセルで閉じる', async () => {
    renderApp(
      '/settings/users',
      routes({
        'PUT /users/viewer-1': () => errorBody(500, 'INTERNAL_ERROR', '修正できませんでした'),
      }),
    );
    const rows = await screen.findAllByTestId('user-row');
    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '修正' }));
    const form = await screen.findByTestId('user-edit');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('修正できませんでした');
    fireEvent.click(within(form).getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByTestId('user-edit')).toBeNull();
  });

  it('削除: 確認のダイアログ。確定すると削除して一覧を読み直す。キャンセルなら何もしない。失敗はエラーを表示する', async () => {
    let attempt = 0;
    const { calls } = renderApp(
      '/settings/users',
      routes({
        'DELETE /users/viewer-1': () => {
          attempt += 1;
          return attempt === 1
            ? noContent()
            : errorBody(500, 'INTERNAL_ERROR', '削除できませんでした');
        },
      }),
    );
    const rows = await screen.findAllByTestId('user-row');

    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '削除' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', {
        name: 'キャンセル',
      }),
    );
    expect(callsOf(calls, 'DELETE', '/users/viewer-1')).toHaveLength(0);

    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '削除' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', { name: '削除' }),
    );
    expect((await screen.findByTestId('users-notice')).textContent).toBe('削除しました');

    fireEvent.click(
      within(at(await screen.findAllByTestId('user-row'), 1)).getByRole('button', { name: '削除' }),
    );
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

describe('ユーザー管理の表の、狭い幅のカード（#151。SC-14）', () => {
  it('各セルが、同じ列の見出しを、カードの項目名（data-label）として持つ', async () => {
    renderApp('/settings/users', routes());
    await screen.findAllByTestId('user-row');

    expectCardLabels();
  });
});
