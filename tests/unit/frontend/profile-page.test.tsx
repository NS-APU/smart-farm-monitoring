import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import {
  callsOf,
  errorBody,
  loginWith,
  renderApp,
  type Routes,
} from '../../support/management-frontend.ts';

/** 一般（手動入力の権限だけ）。 */
const GENERAL_LOGIN = loginWith(['manual-entry:write']);
const SAVED = { userId: 'worker-1', userName: '新しい表示名', role: 'worker' };

function routes(extra: Routes = {}): Routes {
  return { 'PUT /auth/profile': () => jsonResponse(SAVED), ...extra };
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'ユーザー名を変更する' }));
}

function typeName(value: string) {
  fireEvent.change(screen.getByLabelText('ユーザー名'), { target: { value } });
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('自身のユーザー名の編集（FR-9.7）', () => {
  it('ヘッダーの「ユーザー名の変更」から開く（一般を含む）。現在のユーザー名が入っている', async () => {
    renderApp('/', routes(), { login: GENERAL_LOGIN });

    fireEvent.click(await screen.findByRole('link', { name: 'ユーザー名の変更' }));

    expect((await screen.findByLabelText<HTMLInputElement>('ユーザー名')).value).toBe('農作業者A');
    expect(screen.getByRole('heading', { name: 'ユーザー名の変更' })).toBeDefined();
  });

  it('ロール・ユーザー ID は、変えられない（表示のみ）', async () => {
    renderApp('/profile', routes(), { login: GENERAL_LOGIN });

    expect((await screen.findByTestId('profile-user-id')).textContent).toBe('worker-1');
    expect(screen.queryByLabelText('ロール')).toBeNull();
    expect(screen.queryByLabelText('ユーザーID')).toBeNull();
  });

  it('変更すると、ユーザー名だけを送り、ヘッダーの表示も変わり、変更した旨を示す', async () => {
    const { calls } = renderApp('/profile', routes(), { login: GENERAL_LOGIN });
    await screen.findByLabelText('ユーザー名');

    typeName('新しい表示名');
    submit();

    expect((await screen.findByTestId('profile-saved')).textContent).toContain('変更しました');
    expect(callsOf(calls, 'PUT', '/auth/profile')[0]?.body).toEqual({ userName: '新しい表示名' });
    expect(screen.getByLabelText('ログイン中のユーザー').textContent).toBe('新しい表示名');
  });

  it('前後の空白は、取り除いて送る', async () => {
    const { calls } = renderApp('/profile', routes(), { login: GENERAL_LOGIN });
    await screen.findByLabelText('ユーザー名');

    typeName('  空白つき  ');
    submit();

    await waitFor(() => {
      expect(callsOf(calls, 'PUT', '/auth/profile')[0]?.body).toEqual({ userName: '空白つき' });
    });
  });

  it.each([
    ['空', ''],
    ['空白だけ', '   '],
  ])('ユーザー名が%sなら、送らずに、入力欄に誤りを示す', async (_name, value) => {
    const { calls } = renderApp('/profile', routes(), { login: GENERAL_LOGIN });
    await screen.findByLabelText('ユーザー名');

    typeName(value);
    submit();

    expect((await screen.findByText('ユーザー名を入力してください')).textContent).toBeDefined();
    expect(callsOf(calls, 'PUT', '/auth/profile')).toHaveLength(0);
  });

  it('200 文字を超えるユーザー名は、送らずに、誤りを示す', async () => {
    const { calls } = renderApp('/profile', routes(), { login: GENERAL_LOGIN });
    await screen.findByLabelText('ユーザー名');

    typeName('あ'.repeat(201));
    submit();

    expect(
      (await screen.findByText('ユーザー名は200文字以内で入力してください')).textContent,
    ).toBeDefined();
    expect(callsOf(calls, 'PUT', '/auth/profile')).toHaveLength(0);
  });

  it('サーバーの検証エラーは、入力欄に示す。ユーザー名は、もとのまま', async () => {
    renderApp(
      '/profile',
      routes({
        'PUT /auth/profile': () =>
          errorBody(400, 'VALIDATION_ERROR', '入力に誤りがあります', [
            { name: 'userName', message: 'このユーザー名は使えません' },
          ]),
      }),
      { login: GENERAL_LOGIN },
    );
    await screen.findByLabelText('ユーザー名');

    typeName('使えない名前');
    submit();

    expect((await screen.findByText('このユーザー名は使えません')).textContent).toBeDefined();
    expect(screen.queryByTestId('profile-saved')).toBeNull();
    expect(screen.getByLabelText('ログイン中のユーザー').textContent).toBe('農作業者A');
  });

  it('保存に失敗したら、失敗した旨を示す（変更した旨は示さない）', async () => {
    renderApp(
      '/profile',
      routes({
        'PUT /auth/profile': () => errorBody(500, 'INTERNAL_ERROR', '変更できませんでした'),
      }),
      { login: GENERAL_LOGIN },
    );
    await screen.findByLabelText('ユーザー名');

    typeName('失敗する名前');
    submit();

    expect((await screen.findByRole('alert')).textContent).toContain('変更できませんでした');
    expect(screen.queryByTestId('profile-saved')).toBeNull();
  });
});
