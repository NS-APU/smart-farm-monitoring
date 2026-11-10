/**
 * 閲覧の割り当て（ハウスごと）の操作（設備管理 SC-10。Issue #330。ADR-0013）。ハウスの行の「閲覧できるユーザー」の列に、割り当てた
 * 一般ユーザーを示し、「閲覧の割り当て」のボタンで、そのハウスを閲覧できる一般ユーザーを選んで、保存する（ハウス側から、
 * 一般ユーザーを個別に割り当てる）。また、閲覧できるハウスがない一般ユーザーへの案内（ダッシュボード・データ入力）。
 */

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

function table(overrides: { facilities?: unknown[]; users?: unknown[] } = {}) {
  return {
    facilities: overrides.facilities ?? [
      { facilityId: 'HOUSE-01', name: 'ハウス1', userIds: ['general-1'] },
    ],
    users: overrides.users ?? [
      { userId: 'general-1', userName: '一般ユーザーA' },
      { userId: 'general-2', userName: '一般ユーザーB' },
    ],
  };
}

function routes(extra: Routes = {}): Routes {
  return { 'GET /facility-access': () => jsonResponse(table()), ...extra };
}

function rowOf(equipmentId: string): HTMLElement {
  const row = screen
    .getAllByTestId('equipment-row')
    .find((item) => item.getAttribute('data-equipment-id') === equipmentId);
  if (row === undefined) {
    throw new Error(`テストの前提: ${equipmentId} の行がある`);
  }
  return row;
}

async function houseRow(): Promise<HTMLElement> {
  await screen.findAllByTestId('equipment-row');
  return rowOf('HOUSE-01');
}

async function openPanel(): Promise<HTMLElement> {
  fireEvent.click(within(await houseRow()).getByRole('button', { name: '閲覧の割り当て' }));
  return screen.findByTestId('facility-access');
}

const checkbox = (user: string) =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: `${user}が閲覧できる` });

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('閲覧の割り当て（設備管理のハウスの行）', () => {
  it('ハウスの行に、閲覧できるユーザーを示す。ロボット・センサーの行には、示さない', async () => {
    renderApp('/settings/equipment', routes());

    await waitFor(() => {
      expect(rowOf('HOUSE-01').textContent).toContain('一般ユーザーA');
    });
    expect(rowOf('HOUSE-01').textContent).not.toContain('一般ユーザーB');
    expect(rowOf('ROBOT-01').textContent).not.toContain('一般ユーザー');
    expect(within(rowOf('ROBOT-01')).queryByRole('button', { name: '閲覧の割り当て' })).toBeNull();
  });

  it('割り当てがないハウスは「なし」', async () => {
    renderApp(
      '/settings/equipment',
      routes({
        'GET /facility-access': () =>
          jsonResponse(
            table({ facilities: [{ facilityId: 'HOUSE-01', name: 'ハウス1', userIds: [] }] }),
          ),
      }),
    );

    await waitFor(() => {
      expect(rowOf('HOUSE-01').textContent).toContain('なし');
    });
  });

  it('ボタンで、そのハウスを閲覧できる一般ユーザーを選ぶパネルが開く。割り当て済みのユーザーは、チェック済み', async () => {
    renderApp('/settings/equipment', routes());

    const panel = await openPanel();

    expect(within(panel).getByRole('heading').textContent).toContain('ハウス1');
    expect(checkbox('一般ユーザーA').checked).toBe(true);
    expect(checkbox('一般ユーザーB').checked).toBe(false);
    expect(
      within(panel).getByRole<HTMLButtonElement>('button', { name: '割り当てを保存' }).disabled,
    ).toBe(true);
  });

  it('チェックを変えて保存すると、そのハウスの全ユーザー（置き換え）を送り、保存した旨を示し、パネルを閉じて、行の表示も新しくなる', async () => {
    let saved = false;
    const { calls } = renderApp(
      '/settings/equipment',
      routes({
        'GET /facility-access': () =>
          jsonResponse(
            table({
              facilities: [
                {
                  facilityId: 'HOUSE-01',
                  name: 'ハウス1',
                  userIds: saved ? ['general-1', 'general-2'] : ['general-1'],
                },
              ],
            }),
          ),
        'PUT /facility-access/HOUSE-01': () => {
          saved = true;
          return jsonResponse({
            facilityId: 'HOUSE-01',
            name: 'ハウス1',
            userIds: ['general-1', 'general-2'],
          });
        },
      }),
    );
    await openPanel();

    fireEvent.click(checkbox('一般ユーザーB'));
    fireEvent.click(screen.getByRole('button', { name: '割り当てを保存' }));

    expect((await screen.findByTestId('equipment-notice')).textContent).toContain(
      '閲覧の割り当てを保存しました',
    );
    expect(callsOf(calls, 'PUT', '/facility-access/HOUSE-01')[0]?.body).toEqual({
      userIds: ['general-1', 'general-2'],
    });
    expect(screen.queryByTestId('facility-access')).toBeNull();
    await waitFor(() => {
      expect(rowOf('HOUSE-01').textContent).toContain('一般ユーザーB');
    });
  });

  it('チェックを外して、もとに戻すと、変更なし（保存ボタンは無効）。「閉じる」で、保存せずに閉じる', async () => {
    const { calls } = renderApp('/settings/equipment', routes());
    const panel = await openPanel();

    fireEvent.click(checkbox('一般ユーザーA'));
    const save = within(panel).getByRole<HTMLButtonElement>('button', { name: '割り当てを保存' });
    expect(save.disabled).toBe(false);
    fireEvent.click(checkbox('一般ユーザーA'));
    expect(save.disabled).toBe(true);
    fireEvent.click(within(panel).getByRole('button', { name: '閉じる' }));

    expect(screen.queryByTestId('facility-access')).toBeNull();
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });

  it('保存に失敗したら、失敗した旨を示し、チェックはそのまま（やり直せる）', async () => {
    renderApp(
      '/settings/equipment',
      routes({
        'PUT /facility-access/HOUSE-01': () =>
          errorBody(500, 'INTERNAL_ERROR', '保存できませんでした'),
      }),
    );
    await openPanel();

    fireEvent.click(checkbox('一般ユーザーB'));
    fireEvent.click(screen.getByRole('button', { name: '割り当てを保存' }));

    expect((await screen.findByTestId('facility-access-error')).textContent).toContain(
      '保存できませんでした',
    );
    expect(checkbox('一般ユーザーB').checked).toBe(true);
  });

  it('割り当ての対象の一般ユーザーがいなければ、その旨を示す（管理者は、すべてのハウスを閲覧できる）', async () => {
    renderApp(
      '/settings/equipment',
      routes({ 'GET /facility-access': () => jsonResponse(table({ users: [] })) }),
    );

    const panel = await openPanel();

    expect(within(panel).getByTestId('facility-access-no-users').textContent).toContain(
      '管理者は、すべてのハウスを閲覧できます',
    );
  });

  it('割り当ての取得に失敗しても、設備の一覧は表示する（列には、取得できない旨を示す）', async () => {
    renderApp(
      '/settings/equipment',
      routes({ 'GET /facility-access': () => errorBody(500, 'INTERNAL_ERROR', '取得できません') }),
    );

    await waitFor(() => {
      expect(rowOf('HOUSE-01').textContent).toContain('取得できません');
    });
    expect(screen.getAllByTestId('equipment-row').length).toBeGreaterThan(1);
  });

  it('ユーザーを管理する権限（user:manage）がなければ、列もボタンも出さず、割り当ての API も呼ばない', async () => {
    const { calls } = renderApp('/settings/equipment', routes(), {
      login: loginWith(['equipment:manage', 'equipment:view-all']),
    });

    await houseRow();

    expect(screen.queryByRole('columnheader', { name: '閲覧できるユーザー' })).toBeNull();
    expect(screen.queryByRole('button', { name: '閲覧の割り当て' })).toBeNull();
    expect(callsOf(calls, 'GET', '/facility-access')).toHaveLength(0);
  });

  it('参照のみの利用者（権限なし）にも、割り当ての操作は出さない', async () => {
    renderApp('/settings/equipment', routes(), { login: READ_ONLY_LOGIN });

    await screen.findByTestId('permission-notice');

    expect(screen.queryByRole('button', { name: '閲覧の割り当て' })).toBeNull();
  });
});

describe('ユーザー管理には、閲覧の割り当ての表を出さない（ハウスの画面で行う）', () => {
  it('ユーザー管理を開いても、割り当ての表・API の呼び出しはない', async () => {
    const { calls } = renderApp('/settings/users', {
      'GET /users': () =>
        jsonResponse({
          items: [{ userId: 'worker-1', userName: '管理者A', role: 'admin' }],
          roles: [],
        }),
    });

    await screen.findAllByTestId('user-row');

    expect(screen.queryByTestId('facility-access')).toBeNull();
    expect(callsOf(calls, 'GET', '/facility-access')).toHaveLength(0);
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
