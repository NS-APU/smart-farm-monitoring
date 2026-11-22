import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { equipmentTree, jsonResponse, twoFacilityTree } from '../../support/frontend.ts';
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

/** 登録のフォーム。登録は、ダイアログで行う（#364）。開いていなければ、表の上のボタンで開く。 */
function registrationForm(formName: string, buttonName: string): HTMLElement {
  if (screen.queryByRole('form', { name: formName }) === null) {
    fireEvent.click(screen.getByRole('button', { name: buttonName }));
  }
  return screen.getByRole('form', { name: formName });
}

function facilityForm(): HTMLElement {
  return registrationForm('ハウスを登録', 'ハウスの登録');
}

function childForm(): HTMLElement {
  return registrationForm('ロボット・環境センサーを登録', 'ロボット・環境センサーの登録');
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

  it('一覧に、ファイルパス（取得するファイルの場所）を表示する。ハウス・未設定は「—」', async () => {
    const tree = equipmentTree();
    const robot = tree.facilities[0]?.children[0];
    if (robot !== undefined) {
      Object.assign(robot, { sourceFilePath: '/data/robot-01.json' });
    }
    renderApp('/settings/equipment', { 'GET /equipment': () => jsonResponse(tree) });

    const rows = await screen.findAllByTestId('equipment-row');

    expect(rows[1]?.querySelectorAll('td')[4]?.textContent).toBe('/data/robot-01.json');
    expect(rows[2]?.querySelectorAll('td')[4]?.textContent).toBe('—');
    expect(rows[0]?.querySelectorAll('td')[4]?.textContent).toBe('—');
  });

  it('ファイルパスを入力すれば、登録の内容に含める。空なら送らない。不正な形式は、送らずに項目に表示する。登録後は、入力を空にする', async () => {
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

    fireEvent.change(within(form).getByLabelText('ファイルパス'), {
      target: { value: 'data/robot-02.json' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    expect(
      within(form).getByText('ファイルパスは、/ で始まるファイル 1 つを', { exact: false }),
    ).toBeDefined();
    expect(callsOf(calls, 'POST', '/equipment')).toHaveLength(0);

    fireEvent.change(within(form).getByLabelText('ファイルパス'), {
      target: { value: '/data/robot-02.json' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    await screen.findByTestId('equipment-notice');
    expect(callsOf(calls, 'POST', '/equipment')[0]?.body).toMatchObject({
      equipmentType: 'ROBOT',
      sourceFilePath: '/data/robot-02.json',
    });
    expect(within(childForm()).getByLabelText<HTMLInputElement>('ファイルパス').value).toBe('');
  });

  it('修正（ロボット）: ファイルパスを変更・解除できる。ハウスには、ファイルパスの項目がない', async () => {
    const tree = equipmentTree();
    const robot = tree.facilities[0]?.children[0];
    if (robot !== undefined) {
      Object.assign(robot, { sourceFilePath: '/data/robot-01.json' });
    }
    const { calls } = renderApp('/settings/equipment', {
      'GET /equipment': () => jsonResponse(tree),
      'PUT /equipment/ROBOT-01': () => jsonResponse(SAVED_EQUIPMENT),
    });
    const rows = await screen.findAllByTestId('equipment-row');
    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '修正' }));
    let form = await screen.findByTestId('equipment-edit');
    expect(within(form).getByLabelText<HTMLInputElement>('ファイルパス').value).toBe(
      '/data/robot-01.json',
    );

    fireEvent.change(within(form).getByLabelText('ファイルパス'), {
      target: { value: '/data/robot-new.json' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    await screen.findByTestId('equipment-notice');
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')[0]?.body).toMatchObject({
      sourceFilePath: '/data/robot-new.json',
    });

    fireEvent.click(
      within(at(await screen.findAllByTestId('equipment-row'), 1)).getByRole('button', {
        name: '修正',
      }),
    );
    form = await screen.findByTestId('equipment-edit');
    fireEvent.change(within(form).getByLabelText('ファイルパス'), { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(2);
    });
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')[1]?.body).toEqual({
      name: '収穫ロボット1',
      facilityId: 'HOUSE-01',
    });

    fireEvent.click(
      within(at(await screen.findAllByTestId('equipment-row'), 0)).getByRole('button', {
        name: '修正',
      }),
    );
    form = await screen.findByTestId('equipment-edit');
    expect(within(form).queryByLabelText('ファイルパス')).toBeNull();
  });

  it('一覧に、取得間隔を表示する。指定があればその値、なければ種別ごとの既定（ロボット 1 分・環境センサー 5 分）。ハウスは「—」（#197）', async () => {
    const tree = equipmentTree();
    const robot = tree.facilities[0]?.children[0];
    if (robot !== undefined) {
      Object.assign(robot, { intervalMinutes: 10 });
    }
    renderApp('/settings/equipment', { 'GET /equipment': () => jsonResponse(tree) });

    const rows = await screen.findAllByTestId('equipment-row');

    expect(rows[1]?.querySelectorAll('td')[5]?.textContent).toBe('10 分');
    expect(rows[2]?.querySelectorAll('td')[5]?.textContent).toBe('既定（5 分）');
    expect(rows[0]?.querySelectorAll('td')[5]?.textContent).toBe('—');
    expect(screen.getByRole('columnheader', { name: '取得間隔' })).toBeDefined();
  });

  it('登録: 取得間隔を選べる（1・5・10・15・30・60 分。既定は、種別ごと）。選べば登録の内容に含め、既定のままなら送らない。登録後は、既定に戻す（#197）', async () => {
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
    const select = within(form).getByLabelText<HTMLSelectElement>('取得間隔', { exact: false });

    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      '既定（ロボット 1 分・環境センサー 5 分）',
      '1 分',
      '5 分',
      '10 分',
      '15 分',
      '30 分',
      '60 分',
    ]);
    expect(select.value).toBe('');
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));
    await screen.findByTestId('equipment-notice');
    expect(callsOf(calls, 'POST', '/equipment')[0]?.body).not.toHaveProperty('intervalMinutes');

    // 登録に成功すると、ダイアログは閉じる。開き直すと、取得間隔は、既定に戻っている
    expect(screen.queryByRole('form', { name: 'ロボット・環境センサーを登録' })).toBeNull();
    expect(
      within(childForm()).getByLabelText<HTMLSelectElement>('取得間隔', { exact: false }).value,
    ).toBe('');
    fireEvent.change(within(childForm()).getByLabelText('親のハウス', { exact: false }), {
      target: { value: 'HOUSE-01' },
    });
    fireEvent.change(within(childForm()).getByLabelText('設備ID', { exact: false }), {
      target: { value: 'ROBOT-03' },
    });
    fireEvent.change(within(childForm()).getByLabelText('名称', { exact: false }), {
      target: { value: 'ロボット3' },
    });
    fireEvent.change(within(childForm()).getByLabelText('取得間隔', { exact: false }), {
      target: { value: '15' },
    });
    fireEvent.click(within(childForm()).getByRole('button', { name: '登録する' }));

    await waitFor(() => {
      expect(callsOf(calls, 'POST', '/equipment')).toHaveLength(2);
    });
    expect(callsOf(calls, 'POST', '/equipment')[1]?.body).toMatchObject({ intervalMinutes: 15 });
    await waitFor(() => {
      expect(
        within(childForm()).getByLabelText<HTMLSelectElement>('取得間隔', { exact: false }).value,
      ).toBe('');
    });
  });

  it('修正（ロボット）: 取得間隔を変更・既定に戻せる。ハウスには、取得間隔の項目がない（#197）', async () => {
    const tree = equipmentTree();
    const robot = tree.facilities[0]?.children[0];
    if (robot !== undefined) {
      Object.assign(robot, { intervalMinutes: 30 });
    }
    const { calls } = renderApp('/settings/equipment', {
      'GET /equipment': () => jsonResponse(tree),
      'PUT /equipment/ROBOT-01': () => jsonResponse(SAVED_EQUIPMENT),
    });
    const rows = await screen.findAllByTestId('equipment-row');
    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '修正' }));
    let form = await screen.findByTestId('equipment-edit');
    expect(within(form).getByLabelText<HTMLSelectElement>('取得間隔', { exact: false }).value).toBe(
      '30',
    );

    fireEvent.change(within(form).getByLabelText('取得間隔', { exact: false }), {
      target: { value: '5' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    await screen.findByTestId('equipment-notice');
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')[0]?.body).toMatchObject({
      intervalMinutes: 5,
    });

    fireEvent.click(
      within(at(await screen.findAllByTestId('equipment-row'), 1)).getByRole('button', {
        name: '修正',
      }),
    );
    form = await screen.findByTestId('equipment-edit');
    fireEvent.change(within(form).getByLabelText('取得間隔', { exact: false }), {
      target: { value: '' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(2);
    });
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')[1]?.body).toEqual({
      name: '収穫ロボット1',
      facilityId: 'HOUSE-01',
    });

    fireEvent.click(
      within(at(await screen.findAllByTestId('equipment-row'), 0)).getByRole('button', {
        name: '修正',
      }),
    );
    form = await screen.findByTestId('equipment-edit');
    expect(within(form).queryByLabelText('取得間隔', { exact: false })).toBeNull();
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

describe('設備管理: 登録・修正は、ダイアログで行う（Issue #364）', () => {
  it('題名は「ハウス・設備」。表の上に、2 つの登録のボタンがあり、ボタンを押すまで、登録のフォームは出ない', async () => {
    renderApp('/settings/equipment');
    await screen.findAllByTestId('equipment-row');

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ハウス・設備');
    expect(screen.getByRole('button', { name: 'ハウスの登録' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'ロボット・環境センサーの登録' })).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('form', { name: 'ハウスを登録' })).toBeNull();
    // 登録のボタンは、表の上（表より前）にある
    const button = screen.getByRole('button', { name: 'ハウスの登録' });
    const table = document.querySelector('table') as HTMLElement;
    expect(button.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('登録のボタンで、ダイアログが開く（名前は、フォームの名前と同じ）。キャンセル・Esc で閉じる', async () => {
    renderApp('/settings/equipment');
    await screen.findAllByTestId('equipment-row');

    fireEvent.click(screen.getByRole('button', { name: 'ハウスの登録' }));
    expect(screen.getByRole('dialog', { name: 'ハウスを登録' })).toBeDefined();
    fireEvent.click(within(facilityForm()).getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'ロボット・環境センサーの登録' }));
    expect(screen.getByRole('dialog', { name: 'ロボット・環境センサーを登録' })).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('修正のボタンで、ダイアログが開く（名前は、種別と設備 ID を含む）。キャンセルで閉じる。保存すると、閉じて、「修正しました」を示す', async () => {
    renderApp('/settings/equipment', {
      'PUT /equipment/ROBOT-01': () => jsonResponse(SAVED_EQUIPMENT),
    });
    const rows = await screen.findAllByTestId('equipment-row');

    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '修正' }));
    expect(screen.getByRole('dialog', { name: /ロボット（ROBOT-01）を修正/ })).toBeDefined();
    fireEvent.click(
      within(screen.getByTestId('equipment-edit')).getByRole('button', { name: 'キャンセル' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '修正' }));
    fireEvent.click(
      within(screen.getByTestId('equipment-edit')).getByRole('button', { name: '保存' }),
    );

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('修正しました');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('参照のみの利用者には、登録のボタンを表示しない', async () => {
    renderApp('/settings/equipment', {}, { login: READ_ONLY_LOGIN });
    await screen.findAllByTestId('equipment-row');

    expect(screen.queryByRole('button', { name: 'ハウスの登録' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ロボット・環境センサーの登録' })).toBeNull();
  });
});

describe('設備管理: 親のハウスの付け替えは、確認を挟んで、影響を示す（Issue #163。SC-10-7）', () => {
  /** ハウスが 2 つ（ハウス1・ハウス2）の階層で、ROBOT-01（ハウス1 の配下）の修正のダイアログを開く。 */
  async function openRobotEdit(calls: ReturnType<typeof renderApp>['calls']): Promise<HTMLElement> {
    const rows = await screen.findAllByTestId('equipment-row');
    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '修正' }));
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(0);
    return await screen.findByTestId('equipment-edit');
  }

  function render() {
    return renderApp('/settings/equipment', {
      'GET /equipment': () => jsonResponse(twoFacilityTree()),
      'PUT /equipment/ROBOT-01': () => jsonResponse(SAVED_EQUIPMENT),
    });
  }

  function chooseFacility(form: HTMLElement, facilityId: string): void {
    fireEvent.change(within(form).getByLabelText('親のハウス', { exact: false }), {
      target: { value: facilityId },
    });
  }

  it('親のハウスを変えて保存すると、保存の前に、確認を示す。対象の設備と、変更前・変更後のハウスの名称（ID でなく）と、影響を示す', async () => {
    const { calls } = render();
    const form = await openRobotEdit(calls);

    chooseFacility(form, 'HOUSE-02');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    const dialog = await screen.findByTestId('confirm-dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe('親のハウスを変更しますか');
    const details = Array.from(dialog.querySelectorAll('.dialog-details > div')).map(
      (item) => item.textContent,
    );
    expect(details).toEqual([
      '設備収穫ロボット1',
      '変更前のハウスハウス1',
      '変更後のハウスハウス2',
    ]);
    expect(dialog.textContent).toContain(
      '親のハウスをハウス1からハウス2に変えます。閲覧できる利用者（割り当て）と、ハウスの評価が変わります',
    );
    const notes = Array.from(dialog.querySelectorAll('.dialog-notes li')).map(
      (item) => item.textContent,
    );
    expect(notes).toEqual([
      'この設備のデータは、新しいハウスの配下のものとして評価されます',
      '通知と過去の評価は、元のハウスのまま残ります',
    ]);
    expect(dialog.textContent).not.toContain('HOUSE-0');
    // 確認の前は、保存しない
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(0);
    // 修正のダイアログは、背面に残る
    expect(screen.getByTestId('equipment-edit')).toBeDefined();
  });

  it('確認でキャンセルすると、保存せず、修正のダイアログに戻る（入力は、そのまま）', async () => {
    const { calls } = render();
    const form = await openRobotEdit(calls);
    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '付け替えるロボット' },
    });
    chooseFacility(form, 'HOUSE-02');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    const dialog = await screen.findByTestId('confirm-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(0);
    const back = screen.getByTestId('equipment-edit');
    expect(within(back).getByLabelText<HTMLSelectElement>('親のハウス').value).toBe('HOUSE-02');
    expect(within(back).getByLabelText<HTMLInputElement>('名称', { exact: false }).value).toBe(
      '付け替えるロボット',
    );
    expect(screen.queryByTestId('equipment-notice')).toBeNull();
  });

  it('確認で Esc を押すと、確認だけを閉じる（保存せず、修正のダイアログは閉じない）', async () => {
    const { calls } = render();
    const form = await openRobotEdit(calls);
    chooseFacility(form, 'HOUSE-02');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    const dialog = await screen.findByTestId('confirm-dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(screen.getByTestId('equipment-edit')).toBeDefined();
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(0);
  });

  it('確認で確定すると、新しい親のハウスで保存して、ダイアログを閉じ、「修正しました」を示す', async () => {
    const { calls } = render();
    const form = await openRobotEdit(calls);
    chooseFacility(form, 'HOUSE-02');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    const dialog = await screen.findByTestId('confirm-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '親のハウスを変更して保存' }));

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('修正しました');
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(1);
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')[0]?.body).toEqual({
      name: '収穫ロボット1',
      facilityId: 'HOUSE-02',
    });
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(screen.queryByTestId('equipment-edit')).toBeNull();
  });

  it('親のハウスを変えない修正（名称だけ）は、確認を出さず、そのまま保存する', async () => {
    const { calls } = render();
    const form = await openRobotEdit(calls);
    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '改名したロボット' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('修正しました');
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(1);
  });

  it('親のハウスを変えてから元に戻した修正は、確認を出さない', async () => {
    const { calls } = render();
    const form = await openRobotEdit(calls);
    chooseFacility(form, 'HOUSE-02');
    chooseFacility(form, 'HOUSE-01');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('修正しました');
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('入力に誤りがあるとき（名称が空）は、確認より先に、エラーを示す', async () => {
    const { calls } = render();
    const form = await openRobotEdit(calls);
    chooseFacility(form, 'HOUSE-02');
    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    expect(within(form).getByText('名称は必須です')).toBeDefined();
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(callsOf(calls, 'PUT', '/equipment/ROBOT-01')).toHaveLength(0);
  });

  it('確定した保存が失敗したときは、確認を閉じ、修正のダイアログにエラーを示す', async () => {
    const { calls } = renderApp('/settings/equipment', {
      'GET /equipment': () => jsonResponse(twoFacilityTree()),
      'PUT /equipment/ROBOT-01': () => errorBody(500, 'INTERNAL_ERROR', '修正できませんでした'),
    });
    const form = await openRobotEdit(calls);
    chooseFacility(form, 'HOUSE-02');
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', {
        name: '親のハウスを変更して保存',
      }),
    );

    expect((await within(form).findByRole('alert')).textContent).toBe('修正できませんでした');
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(screen.getByTestId('equipment-edit')).toBeDefined();
  });
});
