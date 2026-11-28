/**
 * 設備・ステータスコード・判断基準の保存後のメッセージの出し分け（Issue #404。ADR-0014 の対象の拡張）。
 * 応答の評価の状態が `DEFERRED`（AWS）のときは、評価の更新が定期の評価で行われ、反映に数分かかる旨を示す。
 * `DONE`（ローカル・E2E）・項目なしのときは、従来どおり。
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { withEvaluationNote } from '../../../src/frontend/lib/evaluation-note.ts';
import { getDefaultCriteria } from '../../../src/shared/constants/default-criteria.ts';
import { equipmentTree, jsonResponse } from '../../support/frontend.ts';
import { STATUS_CODES_RESPONSE } from '../../support/viewpoint-fixtures.ts';
import { at, callsOf, renderApp } from '../../support/management-frontend.ts';

const NOTE = '評価の更新は、定期の評価で行われ、反映には、数分かかります';

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('withEvaluationNote（評価の状態に応じた補足）', () => {
  it('DEFERRED のときだけ、メッセージの後に、定期の評価で行われる旨を加える。DONE・項目なしは、そのまま', () => {
    expect(withEvaluationNote('登録しました', 'DEFERRED')).toBe(`登録しました。${NOTE}`);
    expect(withEvaluationNote('登録しました', 'DONE')).toBe('登録しました');
    expect(withEvaluationNote('登録しました', undefined)).toBe('登録しました');
  });
});

describe('設備の保存後のメッセージ（SC-10）', () => {
  const SAVED = {
    equipmentId: 'ROBOT-01',
    equipmentType: 'ROBOT',
    name: '収穫ロボット1号',
    facilityId: 'HOUSE-01',
    isDeleted: false,
    createdAt: '2026-10-01T00:00:00.000Z',
  };

  it('修正: DEFERRED なら、定期の評価で行われる旨を示す', async () => {
    renderApp('/settings/equipment', {
      'GET /equipment': () => jsonResponse(equipmentTree()),
      'PUT /equipment/ROBOT-01': () => jsonResponse({ ...SAVED, evaluation: 'DEFERRED' }),
    });
    const rows = await screen.findAllByTestId('equipment-row');
    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '修正' }));
    fireEvent.click(
      within(await screen.findByTestId('equipment-edit')).getByRole('button', { name: '保存' }),
    );

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe(
      `修正しました。${NOTE}`,
    );
  });

  it('修正: DONE なら、従来どおり「修正しました」', async () => {
    renderApp('/settings/equipment', {
      'GET /equipment': () => jsonResponse(equipmentTree()),
      'PUT /equipment/ROBOT-01': () => jsonResponse({ ...SAVED, evaluation: 'DONE' }),
    });
    const rows = await screen.findAllByTestId('equipment-row');
    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '修正' }));
    fireEvent.click(
      within(await screen.findByTestId('equipment-edit')).getByRole('button', { name: '保存' }),
    );

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe('修正しました');
  });

  it('ハウスの登録: DEFERRED なら、定期の評価で行われる旨を示す', async () => {
    renderApp('/settings/equipment', {
      'GET /equipment': () => jsonResponse(equipmentTree()),
      'POST /equipment': () =>
        jsonResponse(
          {
            equipmentId: 'HOUSE-02',
            equipmentType: 'FACILITY',
            name: 'ハウス2',
            isDeleted: false,
            createdAt: SAVED.createdAt,
            evaluation: 'DEFERRED',
          },
          201,
        ),
    });
    await screen.findAllByTestId('equipment-row');
    fireEvent.click(screen.getByRole('button', { name: 'ハウスの登録' }));
    const form = screen.getByRole('form', { name: 'ハウスを登録' });
    fireEvent.change(within(form).getByLabelText('設備ID', { exact: false }), {
      target: { value: 'HOUSE-02' },
    });
    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: 'ハウス2' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    expect((await screen.findByTestId('equipment-notice')).textContent).toBe(
      `登録しました。${NOTE}`,
    );
  });

  it('削除: DEFERRED なら、定期の評価で行われる旨を示す。DONE なら、従来どおり', async () => {
    renderApp('/settings/equipment', {
      'GET /equipment': () => jsonResponse(equipmentTree()),
      'DELETE /equipment/ROBOT-01': () => jsonResponse({ evaluation: 'DEFERRED' }),
      'DELETE /equipment/SENSOR-01': () => jsonResponse({ evaluation: 'DONE' }),
    });
    const rows = await screen.findAllByTestId('equipment-row');

    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '削除' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', { name: '削除' }),
    );
    expect((await screen.findByTestId('equipment-notice')).textContent).toBe(
      `削除を始めました。データの削除には、数分かかることがあります。${NOTE}`,
    );

    fireEvent.click(
      within(at(await screen.findAllByTestId('equipment-row'), 2)).getByRole('button', {
        name: '削除',
      }),
    );
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', { name: '削除' }),
    );
    await screen.findByText('削除を始めました。データの削除には、数分かかることがあります');
  });
});

describe('ステータスコードの保存後のメッセージ（SC-12）', () => {
  const SAVED = { code: 'FALLEN', name: '転倒', category: 'ERROR', isDeleted: false };

  it('登録: DEFERRED なら、定期の評価で行われる旨を示す', async () => {
    renderApp('/settings/status-codes', {
      'GET /status-codes': () => jsonResponse(STATUS_CODES_RESPONSE),
      'POST /status-codes': () =>
        jsonResponse({ ...SAVED, code: 'CHARGING', evaluation: 'DEFERRED' }, 201),
    });
    await screen.findAllByTestId('status-code-row');
    fireEvent.click(screen.getByRole('button', { name: 'ステータスコードの登録' }));
    const form = screen.getByTestId('status-code-add');
    fireEvent.change(within(form).getByLabelText('コード値', { exact: false }), {
      target: { value: 'CHARGING' },
    });
    fireEvent.change(within(form).getByLabelText('名称', { exact: false }), {
      target: { value: '充電中' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登録する' }));

    expect((await screen.findByTestId('status-codes-notice')).textContent).toBe(
      `登録しました。${NOTE}`,
    );
  });

  it('修正: DEFERRED なら、定期の評価で行われる旨を示す。DONE なら、従来どおり', async () => {
    let state: 'DEFERRED' | 'DONE' = 'DEFERRED';
    renderApp('/settings/status-codes', {
      'GET /status-codes': () => jsonResponse(STATUS_CODES_RESPONSE),
      'PUT /status-codes/HARVESTING': () => jsonResponse({ ...SAVED, evaluation: state }),
    });
    const edit = async () => {
      const rows = await screen.findAllByTestId('status-code-row');
      fireEvent.click(within(at(rows, 0)).getByRole('button', { name: '修正' }));
      fireEvent.click(
        within(await screen.findByTestId('status-code-edit')).getByRole('button', {
          name: '保存',
        }),
      );
    };

    await edit();
    expect((await screen.findByTestId('status-codes-notice')).textContent).toBe(
      `修正しました。${NOTE}`,
    );

    state = 'DONE';
    await edit();
    await screen.findByText('修正しました');
  });

  it('削除: DEFERRED なら、定期の評価で行われる旨を示す', async () => {
    const { calls } = renderApp('/settings/status-codes', {
      'GET /status-codes': () => jsonResponse(STATUS_CODES_RESPONSE),
      'DELETE /status-codes/FALLEN': () => jsonResponse({ evaluation: 'DEFERRED' }),
    });
    const rows = await screen.findAllByTestId('status-code-row');
    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: '削除' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', { name: '削除' }),
    );

    expect((await screen.findByTestId('status-codes-notice')).textContent).toBe(
      `削除しました。${NOTE}`,
    );
    expect(callsOf(calls, 'DELETE', '/status-codes/FALLEN')).toHaveLength(1);
  });
});

describe('判断基準の保存後のメッセージ（SC-13。#158 の SC-13-8）', () => {
  const PATH = '/viewpoints/environmentalAdaptability/criteria';
  const BASE = {
    ...getDefaultCriteria('environmentalAdaptability'),
    usesStatusIndicator: false,
  };

  it('保存: DEFERRED なら、「現在の評価を更新しました」と言い切らず、定期の評価で行われる旨を示す', async () => {
    renderApp(PATH, {
      [`GET ${PATH}`]: () => jsonResponse(BASE),
      [`PUT ${PATH}`]: () =>
        jsonResponse({ ...BASE, version: 'CUSTOM-1', isDefault: false, evaluation: 'DEFERRED' }),
    });
    await screen.findByTestId('criteria-state');

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect((await screen.findByTestId('criteria-notice')).textContent).toBe(
      `保存しました。${NOTE}`,
    );
  });

  it.each([
    ['DONE', { evaluation: 'DONE' }],
    ['項目なし', {}],
  ])('保存: 評価の状態が%sなら、従来どおり「現在の評価を更新しました」', async (_name, extra) => {
    renderApp(PATH, {
      [`GET ${PATH}`]: () => jsonResponse(BASE),
      [`PUT ${PATH}`]: () =>
        jsonResponse({ ...BASE, version: 'CUSTOM-1', isDefault: false, ...extra }),
    });
    await screen.findByTestId('criteria-state');

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect((await screen.findByTestId('criteria-notice')).textContent).toBe(
      '保存しました。現在の評価を更新しました',
    );
  });

  it('既定値へ戻す: DEFERRED なら、定期の評価で行われる旨を示す。DONE なら、従来どおり', async () => {
    let evaluation: 'DEFERRED' | 'DONE' = 'DEFERRED';
    renderApp(PATH, {
      [`GET ${PATH}`]: () =>
        jsonResponse({ ...BASE, version: 'CUSTOM-1', isDefault: false, updatedBy: 'worker-1' }),
      [`POST ${PATH}/reset`]: () => jsonResponse({ ...BASE, evaluation }),
    });
    await screen.findByTestId('criteria-state');
    const reset = async () => {
      fireEvent.click(screen.getByRole('button', { name: '既定値へ戻す' }));
      fireEvent.click(
        within(await screen.findByTestId('confirm-dialog')).getByRole('button', {
          name: '既定値へ戻す',
        }),
      );
    };

    await reset();
    expect((await screen.findByTestId('criteria-notice')).textContent).toBe(
      `既定値へ戻しました。${NOTE}`,
    );

    evaluation = 'DONE';
    await reset();
    await screen.findByText('既定値へ戻しました');
  });
});
