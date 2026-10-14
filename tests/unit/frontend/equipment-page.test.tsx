import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { equipmentTree, jsonResponse } from '../../support/frontend.ts';
import {
  READ_ONLY_LOGIN,
  at,
  callsOf,
  errorBody,
  noContent,
  renderApp,
} from '../../support/management-frontend.ts';

const SAVED_EQUIPMENT = {
  equipmentId: 'ROBOT-02',
  equipmentType: 'ROBOT',
  name: 'ロボット2',
  facilityId: 'HOUSE-01',
  isDeleted: false,
  createdAt: '2026-10-01T00:00:00.000Z',
};

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

function facilityForm(): HTMLElement {
  return screen.getByRole('form', { name: 'ハウスを登録' });
}

function childForm(): HTMLElement {
  return screen.getByRole('form', { name: 'ロボット・環境センサーを登録' });
}

describe('設備管理（UC-12。SC-10）', () => {
  it('ハウス → ロボット・環境センサーの階層を、種別・設備ID・名称・データ上の識別子で表示する。識別子がなければ「—」', async () => {
    const tree = equipmentTree();
    const robot = tree.facilities[0]?.children[0];
    if (robot !== undefined) {
      Object.assign(robot, { externalId: 'R-001' });
    }
    renderApp('/settings/equipment', { 'GET /equipment': () => jsonResponse(tree) });

    const rows = await screen.findAllByTestId('equipment-row');

    expect(rows.map((row) => row.getAttribute('data-equipment-id'))).toEqual([
      'HOUSE-01',
      'ROBOT-01',
      'SENSOR-01',
    ]);
    expect(rows[0]?.textContent).toContain('ハウス');
    expect(rows[1]?.textContent).toContain('R-001');
    expect(rows[2]?.querySelectorAll('td')[3]?.textContent).toBe('—');
  });

  it('設備がなければ、その旨を表示する', async () => {
    renderApp('/settings/equipment', { 'GET /equipment': () => jsonResponse({ facilities: [] }) });
    expect((await screen.findByTestId('equipment-empty')).textContent).toContain(
      '設備が登録されていません',
    );
  });

  it('設備を変更する権限がなければ、参照のみ（操作・登録フォームを表示しない）', async () => {
    renderApp('/settings/equipment', {}, { login: READ_ONLY_LOGIN });
    await screen.findAllByTestId('equipment-row');
    expect(screen.getByTestId('permission-notice').textContent).toContain('権限がありません');
    expect(screen.queryByRole('button', { name: '修正' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'ハウスを登録' })).toBeNull();
  });

  it('設備の階層の取得に失敗した場合は、エラーを表示し、再読み込みできる', async () => {
    let failing = true;
    renderApp('/settings/equipment', {
      'GET /equipment': () =>
        failing
          ? errorBody(500, 'INTERNAL_ERROR', '取得できません')
          : jsonResponse(equipmentTree()),
    });
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toContain('取得できません');
    failing = false;
    fireEvent.click(at(screen.getAllByRole('button', { name: '再読み込み' }), 0));
    expect(await screen.findAllByTestId('equipment-row')).toHaveLength(3);
  });

  it('ハウスの登録: 設備ID・名称が必須。入力すると、種別をハウスとして登録し、階層を読み直す', async () => {
    const tree = equipmentTree();
    const { calls } = renderApp('/settings/equipment', {
      'GET /equipment': () => jsonResponse(tree),
      'POST /equipment': () => {
        tree.facilities.push({
          facility: {
            equipmentId: 'HOUSE-02' as never,
            equipmentType: 'FACILITY',
            name: 'ハウス2',
            isDeleted: false,
            createdAt: '2026-10-01T00:00:00.000Z',
          },
          children: [],
        });
        return jsonResponse(SAVED_EQUIPMENT, 201);
      },
    });
    await screen.findAllByTestId('equipment-row');
    const form = facilityForm();

    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    expect(within(form).getByText('設備IDは必須です')).toBeDefined();
    expect(within(form).getByText('名称は必須です')).toBeDefined();
    expect(callsOf(calls, 'POST', '/equipment')).toHaveLength(0);

    fireEvent.change(within(form).getByLabelText('設備ID', { exact: false }), {
      target: { value: 'HOUSE-02' },
    });
    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: 'ハウス2' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('登録しました');
    expect(callsOf(calls, 'POST', '/equipment')[0]?.body).toEqual({
      equipmentId: 'HOUSE-02',
      equipmentType: 'FACILITY',
      name: 'ハウス2',
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('equipment-row')).toHaveLength(4);
    });
    expect(
      within(facilityForm()).getByLabelText<HTMLInputElement>('設備ID', { exact: false }).value,
    ).toBe('');
  });

  it('設備IDが重複した場合は、サーバーのエラーを、項目に表示する。その他のエラーは、画面全体に表示する', async () => {
    let attempt = 0;
    renderApp('/settings/equipment', {
      'POST /equipment': () => {
        attempt += 1;
        return attempt === 1
          ? errorBody(409, 'CONFLICT', '入力内容を確認してください', [
              { name: 'equipmentId', message: '設備IDは、すでに使われています' },
            ])
          : errorBody(500, 'INTERNAL_ERROR', '登録できませんでした');
      },
    });
    await screen.findAllByTestId('equipment-row');
    const form = facilityForm();
    fireEvent.change(within(form).getByLabelText('設備ID', { exact: false }), {
      target: { value: 'HOUSE-01' },
    });
    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '重複' },
    });

    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    expect(await within(form).findByText('設備IDは、すでに使われています')).toBeDefined();

    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    await waitFor(() => {
      expect(within(form).getByRole('alert').textContent).toBe('登録できませんでした');
    });
  });

  it('ロボット・環境センサーの登録: 種別・親のハウス・設備ID・名称が必須。データ上の識別子は任意で、空なら送らない', async () => {
    const { calls } = renderApp('/settings/equipment', {
      'POST /equipment': () => jsonResponse(SAVED_EQUIPMENT, 201),
    });
    await screen.findAllByTestId('equipment-row');
    const form = childForm();

    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    expect(
      within(form).getByText('ロボット・センサーは親のハウスが必須で、ハウスは親を持てません'),
    ).toBeDefined();

    fireEvent.change(within(form).getByLabelText('種別', { exact: false }), {
      target: { value: 'SENSOR' },
    });
    fireEvent.change(within(form).getByLabelText('親のハウス', { exact: false }), {
      target: { value: 'HOUSE-01' },
    });
    fireEvent.change(within(form).getByLabelText('設備ID', { exact: false }), {
      target: { value: 'SENSOR-02' },
    });
    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '環境センサー2' },
    });
    fireEvent.change(within(form).getByLabelText('データ上の識別子'), { target: { value: '   ' } });
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    await screen.findByTestId('equipment-notice');
    expect(callsOf(calls, 'POST', '/equipment')[0]?.body).toEqual({
      equipmentId: 'SENSOR-02',
      equipmentType: 'SENSOR',
      name: '環境センサー2',
      facilityId: 'HOUSE-01',
    });
  });

  it('データ上の識別子を入力すれば、登録の内容に含める。登録後は、入力を空にする', async () => {
    const { calls } = renderApp('/settings/equipment', {
      'POST /equipment': () => jsonResponse(SAVED_EQUIPMENT, 201),
    });
    await screen.findAllByTestId('equipment-row');
    const form = childForm();
    fireEvent.change(within(form).getByLabelText('親のハウス', { exact: false }), {
      target: { value: 'HOUSE-01' },
    });
    fireEvent.change(within(form).getByLabelText('設備ID', { exact: false }), {
      target: { value: 'ROBOT-02' },
    });
    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: 'ロボット2' },
    });
    fireEvent.change(within(form).getByLabelText('データ上の識別子'), {
      target: { value: 'R-002' },
    });

    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    await screen.findByTestId('equipment-notice');
    expect(callsOf(calls, 'POST', '/equipment')[0]?.body).toMatchObject({
      equipmentType: 'ROBOT',
      externalId: 'R-002',
    });
    expect(within(childForm()).getByLabelText<HTMLInputElement>('データ上の識別子').value).toBe('');
  });

  it('ロボット・センサーの登録で、サーバーが失敗を返した場合は、エラーを表示する', async () => {
    renderApp('/settings/equipment', {
      'POST /equipment': () => errorBody(500, 'INTERNAL_ERROR', '登録できませんでした'),
    });
    await screen.findAllByTestId('equipment-row');
    const form = childForm();
    fireEvent.change(within(form).getByLabelText('親のハウス', { exact: false }), {
      target: { value: 'HOUSE-01' },
    });
    fireEvent.change(within(form).getByLabelText('設備ID', { exact: false }), {
      target: { value: 'ROBOT-02' },
    });
    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: 'ロボット2' },
    });

    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    expect((await within(form).findByRole('alert')).textContent).toBe('登録できませんでした');
  });

  it('修正（ロボット）: 名称・親のハウス・データ上の識別子を変更できる。設備IDと種別は変更できない', async () => {
    const { calls } = renderApp('/settings/equipment', {
      'PUT /equipment/ROBOT-01': () => jsonResponse(SAVED_EQUIPMENT),
    });
    const rows = await screen.findAllByTestId('equipment-row');
    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '修正' }));
    const form = await screen.findByTestId('equipment-edit');
    expect(within(form).queryByLabelText('設備ID', { exact: false })).toBeNull();

    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    expect(within(form).getByText('名称は必須です')).toBeDefined();

    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '収穫ロボット1号' },
    });
    fireEvent.change(within(form).getByLabelText('データ上の識別子'), {
      target: { value: 'R-100' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('修正しました');
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')[0]?.body).toEqual({
      name: '収穫ロボット1号',
      facilityId: 'HOUSE-01',
      externalId: 'R-100',
    });
    expect(screen.queryByTestId('equipment-edit')).toBeNull();
  });

  it('修正（ハウス）: 親のハウスの項目はない。キャンセルで閉じる。修正の失敗は、エラーを表示する', async () => {
    renderApp('/settings/equipment', {
      'PUT /equipment/HOUSE-01': () => errorBody(500, 'INTERNAL_ERROR', '修正できませんでした'),
    });
    const rows = await screen.findAllByTestId('equipment-row');
    fireEvent.click(within(at(rows, 0)).getByRole('button', { name: '修正' }));
    const form = await screen.findByTestId('equipment-edit');
    expect(within(form).queryByLabelText('親のハウス')).toBeNull();

    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('修正できませんでした');

    fireEvent.click(within(form).getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByTestId('equipment-edit')).toBeNull();
  });

  it('削除: ロボットは確認のダイアログ。ハウスは、配下も対象外になる旨を示す。確定すると、削除して階層を読み直す', async () => {
    const { calls } = renderApp('/settings/equipment', {
      'DELETE /equipment/ROBOT-01': () => noContent(),
      'DELETE /equipment/HOUSE-01': () => noContent(),
    });
    const rows = await screen.findAllByTestId('equipment-row');

    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '削除' }));
    let dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain('過去のデータは残ります');
    expect(dialog.textContent).not.toContain('配下の');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    expect(callsOf(calls, 'DELETE', '/equipment/ROBOT-01')).toHaveLength(0);

    fireEvent.click(within(at(rows, 0)).getByRole('button', { name: '削除' }));
    dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain('配下のロボット・環境センサーも含めて');
    fireEvent.click(within(dialog).getByRole('button', { name: '削除' }));

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('削除しました');
    expect(callsOf(calls, 'DELETE', '/equipment/HOUSE-01')).toHaveLength(1);
  });

  it('削除に失敗した場合は、エラーを表示する', async () => {
    renderApp('/settings/equipment', {
      'DELETE /equipment/ROBOT-01': () => errorBody(500, 'INTERNAL_ERROR', '削除できませんでした'),
    });
    const rows = await screen.findAllByTestId('equipment-row');
    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '削除' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', { name: '削除' }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole('alert').some((node) => node.textContent === '削除できませんでした'),
      ).toBe(true);
    });
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });
});
