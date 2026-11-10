/**
 * 閲覧の割り当て（ハウスごと）の表（SC-14。Issue #330。ADR-0013）。行がハウス、列が一般ユーザーで、チェックボックスを付けて、
 * 変更したハウスだけを、まとめて保存する。また、閲覧できるハウスがない一般ユーザーへの案内（ダッシュボード・データ入力）。
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import { errorBody, loginWith, renderApp, type Routes } from '../../support/management-frontend.ts';

const USERS = {
  items: [{ userId: 'worker-1', userName: '管理者A', role: 'admin' }],
  roles: [{ roleId: 'admin', name: '管理者' }],
};

function table(overrides: { facilities?: unknown[]; users?: unknown[] } = {}) {
  return {
    facilities: overrides.facilities ?? [
      { facilityId: 'HOUSE-01', name: 'ハウス1', userIds: ['general-1'] },
      { facilityId: 'HOUSE-02', name: 'ハウス2', userIds: [] },
    ],
    users: overrides.users ?? [
      { userId: 'general-1', userName: '一般ユーザーA' },
      { userId: 'general-2', userName: '一般ユーザーB' },
    ],
  };
}

function routes(extra: Routes = {}): Routes {
  return {
    'GET /users': () => jsonResponse(USERS),
    'GET /facility-access': () => jsonResponse(table()),
    ...extra,
  };
}

const checkbox = (house: string, user: string) =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: `${house}を${user}が閲覧できる` });

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('閲覧の割り当ての表（SC-14）', () => {
  it('行がハウス、列が一般ユーザー。割り当て済みのセルは、チェックされている', async () => {
    renderApp('/settings/users', routes());
    await screen.findAllByTestId('facility-access-row');
    const section = screen.getByTestId('facility-access');

    expect(within(section).getByRole('heading', { name: '閲覧の割り当て' })).toBeDefined();
    const columns = within(section)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(columns).toEqual(['ハウス', '一般ユーザーA', '一般ユーザーB']);
    expect(within(section).getAllByTestId('facility-access-row')).toHaveLength(2);
    expect(checkbox('ハウス1', '一般ユーザーA').checked).toBe(true);
    expect(checkbox('ハウス1', '一般ユーザーB').checked).toBe(false);
    expect(checkbox('ハウス2', '一般ユーザーA').checked).toBe(false);
    expect(
      within(section).getByRole<HTMLButtonElement>('button', { name: '割り当てを保存' }).disabled,
    ).toBe(true);
  });

  it('チェックを変えたハウスだけを、そのハウスの全ユーザー（置き換え）で保存する。保存したら、保存した旨を示し、保存ボタンは無効に戻る', async () => {
    const saved = table({
      facilities: [
        { facilityId: 'HOUSE-01', name: 'ハウス1', userIds: ['general-1'] },
        { facilityId: 'HOUSE-02', name: 'ハウス2', userIds: ['general-1', 'general-2'] },
      ],
    });
    let reloaded = false;
    const { calls } = renderApp(
      '/settings/users',
      routes({
        'GET /facility-access': () => jsonResponse(reloaded ? saved : table()),
        'PUT /facility-access/HOUSE-02': () => {
          reloaded = true;
          return jsonResponse(saved.facilities[1]);
        },
      }),
    );
    await screen.findAllByTestId('facility-access-row');

    fireEvent.click(checkbox('ハウス2', '一般ユーザーA'));
    fireEvent.click(checkbox('ハウス2', '一般ユーザーB'));
    fireEvent.click(screen.getByRole('button', { name: '割り当てを保存' }));

    expect((await screen.findByTestId('facility-access-saved')).textContent).toContain(
      '保存しました',
    );
    const puts = calls.filter((call) => call.method === 'PUT');
    expect(puts.map((call) => call.path)).toEqual(['/facility-access/HOUSE-02']);
    expect(puts[0]?.body).toEqual({ userIds: ['general-1', 'general-2'] });
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: '割り当てを保存' }).disabled,
      ).toBe(true);
    });
    expect(checkbox('ハウス2', '一般ユーザーB').checked).toBe(true);
  });

  it('チェックを外して、もとに戻すと、変更なし（保存ボタンは無効）', async () => {
    renderApp('/settings/users', routes());
    await screen.findAllByTestId('facility-access-row');

    fireEvent.click(checkbox('ハウス1', '一般ユーザーA'));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '割り当てを保存' }).disabled).toBe(
      false,
    );
    fireEvent.click(checkbox('ハウス1', '一般ユーザーA'));

    expect(screen.getByRole<HTMLButtonElement>('button', { name: '割り当てを保存' }).disabled).toBe(
      true,
    );
  });

  it('保存に失敗したら、失敗した旨を示し、チェックはそのまま（やり直せる）', async () => {
    renderApp(
      '/settings/users',
      routes({
        'PUT /facility-access/HOUSE-02': () =>
          errorBody(500, 'INTERNAL_ERROR', '保存できませんでした'),
      }),
    );
    await screen.findAllByTestId('facility-access-row');

    fireEvent.click(checkbox('ハウス2', '一般ユーザーB'));
    fireEvent.click(screen.getByRole('button', { name: '割り当てを保存' }));

    expect((await screen.findByTestId('facility-access-error')).textContent).toContain(
      '保存できませんでした',
    );
    expect(screen.queryByTestId('facility-access-saved')).toBeNull();
    expect(checkbox('ハウス2', '一般ユーザーB').checked).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '割り当てを保存' }).disabled).toBe(
      false,
    );
  });

  it('一般ユーザーがいなければ、その旨を示す（管理者は、すべてのハウスを閲覧できる）。ハウスがなければ、その旨を示す', async () => {
    const view = renderApp(
      '/settings/users',
      routes({ 'GET /facility-access': () => jsonResponse(table({ users: [] })) }),
    );
    expect((await screen.findByTestId('facility-access-no-users')).textContent).toContain(
      '管理者は、すべてのハウスを閲覧できます',
    );
    view.unmount();

    renderApp(
      '/settings/users',
      routes({ 'GET /facility-access': () => jsonResponse(table({ facilities: [] })) }),
    );
    expect((await screen.findByTestId('facility-access-no-facilities')).textContent).toContain(
      'ハウスが登録されていません',
    );
  });

  it('表の取得に失敗しても、ユーザーの一覧は表示する（表だけにエラーを示す）', async () => {
    renderApp(
      '/settings/users',
      routes({ 'GET /facility-access': () => errorBody(500, 'INTERNAL_ERROR', '取得できません') }),
    );

    expect(await screen.findAllByTestId('user-row')).toHaveLength(1);
    expect((await screen.findByTestId('facility-access-load-error')).textContent).toContain(
      '取得できません',
    );
  });
});

describe('閲覧できるハウスがない一般ユーザーへの案内', () => {
  const GENERAL = loginWith(['manual-entry:write']);

  it('ダッシュボード: 設備がない旨ではなく、閲覧できるハウスが割り当てられていない旨と、管理者への連絡を示す（設備管理へのリンクは出さない）', async () => {
    renderApp(
      '/',
      { 'GET /equipment': () => jsonResponse({ facilities: [] }) },
      { login: GENERAL },
    );

    const message = await screen.findByText(/閲覧できるハウスが割り当てられていません/);

    expect(message.textContent).toContain('管理者に連絡してください');
    expect(screen.queryByText(/設備を登録してください/)).toBeNull();
    expect(screen.queryByRole('link', { name: '設備の管理へ' })).toBeNull();
  });

  it('管理者（全設備を閲覧する権限がある）には、これまでの案内（設備を登録してください）', async () => {
    renderApp(
      '/',
      { 'GET /equipment': () => jsonResponse({ facilities: [] }) },
      { login: loginWith(['equipment:view-all', 'equipment:manage']) },
    );

    expect(
      await screen.findByText('設備が登録されていません。設備を登録してください'),
    ).toBeDefined();
    expect(screen.queryByText(/閲覧できるハウスが割り当てられていません/)).toBeNull();
  });

  it('データ入力: 閲覧できるハウスが割り当てられていない旨を示す', async () => {
    renderApp(
      '/data-entry',
      { 'GET /equipment': () => jsonResponse({ facilities: [] }) },
      { login: GENERAL },
    );

    expect((await screen.findByTestId('no-equipment')).textContent).toContain(
      '閲覧できるハウスが割り当てられていません',
    );
  });
});
