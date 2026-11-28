import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import {
  READ_ONLY_LOGIN,
  at,
  callsOf,
  confirmDetailsOf,
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

/** 登録のフォーム。登録は、ダイアログで行う（#366）。表の上のボタンで開いて、フォームを返す。 */
function openAddForm(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'ユーザーの登録' }));
  return screen.getByTestId('user-add');
}

describe('ユーザー（UC-14。SC-14）', () => {
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
    const form = openAddForm();

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
    // 登録に成功すると、ダイアログは閉じる。開き直すと、入力は空
    expect(screen.queryByTestId('user-add')).toBeNull();
    expect(
      within(openAddForm()).getByLabelText<HTMLInputElement>('パスワード', { exact: false }).value,
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
    const form = openAddForm();
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

describe('ユーザーの削除の確認（#153。SC-14-2）', () => {
  it('対象（ユーザー名・ユーザーID）を示し、Web Push 通知の購読とログイン中の状態（セッション）も削除される旨を示す。行ごとに、押した行の対象を示す', async () => {
    renderApp('/settings/users', routes());
    const rows = await screen.findAllByTestId('user-row');

    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '削除' }));

    const dialog = await screen.findByTestId('confirm-dialog');
    expect(confirmDetailsOf(dialog)).toEqual({ ユーザー名: '閲覧者B', ユーザーID: 'viewer-1' });
    expect(dialog.textContent).toContain('削除したユーザーは、ログインできなくなります');
    expect(dialog.textContent).toContain('Web Push 通知の購読');
    expect(dialog.textContent).toContain('ログイン中の状態（セッション）');
  });
});

describe('ユーザーの表の、狭い幅のカード（#151。SC-14）', () => {
  it('各セルが、同じ列の見出しを、カードの項目名（data-label）として持つ', async () => {
    renderApp('/settings/users', routes());
    await screen.findAllByTestId('user-row');

    expectCardLabels();
  });
});

describe('ユーザー: 登録・修正は、ダイアログで行う（Issue #366）', () => {
  it('表の上に、「ユーザーの登録」のボタンがあり、押すまで、登録のフォームは出ない。キャンセル・Esc で閉じる', async () => {
    renderApp('/settings/users', routes());
    await screen.findAllByTestId('user-row');

    expect(screen.queryByTestId('user-add')).toBeNull();
    const button = screen.getByRole('button', { name: 'ユーザーの登録' });
    const table = document.querySelector('table') as HTMLElement;
    expect(button.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'ユーザーを登録' })).toBeDefined();
    fireEvent.click(
      within(screen.getByTestId('user-add')).getByRole('button', { name: 'キャンセル' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('修正のボタンで、ダイアログが開く（名前は、「〇〇を修正」）。キャンセルで閉じる', async () => {
    renderApp('/settings/users', routes());
    const rows = await screen.findAllByTestId('user-row');

    fireEvent.click(within(at(rows, 0)).getByRole('button', { name: '修正' }));

    expect(screen.getByRole('dialog', { name: /を修正/ })).toBeDefined();
    fireEvent.click(
      within(screen.getByTestId('user-edit')).getByRole('button', { name: 'キャンセル' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ユーザー: パスワード欄の表示切替・Caps Lock の注意（Issue #157。SC-01-4）', () => {
  it('登録のダイアログのパスワード欄に、表示切替がある（既定は非表示）。押すと表示に切り替わる', async () => {
    renderApp('/settings/users', routes());
    await screen.findAllByTestId('user-row');
    const form = openAddForm();
    const password = within(form).getByLabelText<HTMLInputElement>('パスワード', {
      exact: false,
    });
    const toggle = within(form).getByRole('button', { name: '入力した文字を表示' });

    expect(password.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);

    expect(password.type).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // 切替は、フォームを送信しない（必須のエラーも出さない）
    expect(within(form).queryByText('ユーザーIDは必須です')).toBeNull();
  });

  it('修正（再設定）のダイアログのパスワード欄にも、表示切替と Caps Lock の注意がある', async () => {
    renderApp('/settings/users', routes());
    const rows = await screen.findAllByTestId('user-row');
    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '修正' }));
    const form = await screen.findByTestId('user-edit');
    const password = within(form).getByLabelText<HTMLInputElement>('パスワード', {
      exact: false,
    });

    fireEvent.keyDown(password, { key: 'A', modifierCapsLock: true });
    fireEvent.click(within(form).getByRole('button', { name: '入力した文字を表示' }));

    expect(password.type).toBe('text');
    expect(within(form).getByTestId('caps-lock-notice').textContent).toContain('Caps Lock');
  });
});
