/**
 * 入力の補助（レビュー V-150・V-155）の単体テスト。全角の数字・記号の入力、検証エラーのときのフォーカスとエラーの要約。
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeNumberText } from '../../../src/frontend/components/number-text.ts';
import { jsonResponse } from '../../support/frontend.ts';
import { callsOf, manualEntry, renderApp } from '../../support/management-frontend.ts';

const SAVED = { entry: manualEntry(), viewpointStatuses: [] };

function entryForm(): HTMLElement {
  const form = document.querySelector<HTMLElement>('form.entry-form');
  if (form === null) {
    throw new Error('入力のフォームがありません');
  }
  return form;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState(null, '', '/');
});

describe('normalizeNumberText（全角の数字・記号。V-155）', () => {
  it.each([
    ['１２', '12'],
    ['－５', '-5'],
    ['−5', '-5'],
    ['３．５', '3.5'],
    ['3。5', '3.5'],
    ['＋７', '+7'],
    ['1,5', '1,5'],
    [' 　4 　', '4'],
    ['abc', 'abc'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizeNumberText(input)).toBe(expected);
  });
});

describe('データ入力: 全角の数字（V-155）', () => {
  it('全角の数字・符号・小数点で入力しても、数値として保存できる', async () => {
    const { calls } = renderApp('/data-entry', {
      'POST /manual-entries': () => jsonResponse(SAVED, 201),
    });
    await screen.findByRole('button', { name: '保存する' });
    fireEvent.change(within(entryForm()).getByLabelText('対象の設備', { exact: false }), {
      target: { value: 'ROBOT-01' },
    });
    fireEvent.change(within(entryForm()).getByLabelText('カテゴリ', { exact: false }), {
      target: { value: 'FAILURE' },
    });
    fireEvent.change(screen.getByLabelText('故障回数（回）'), { target: { value: '１２' } });
    fireEvent.change(screen.getByLabelText('復旧に要した時間（分）'), {
      target: { value: '３．５' },
    });

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    await screen.findByTestId('entry-result');
    expect(callsOf(calls, 'POST', '/manual-entries')[0]?.body).toMatchObject({
      items: { failureCount: 12, recoveryMinutes: 3.5 },
    });
  });
});

describe('データ入力: 検証エラーのとき（V-150）', () => {
  it('最初のエラーの項目へフォーカスを移し、エラーの件数を、通知（role=alert）で示す', async () => {
    renderApp('/data-entry');
    await screen.findByRole('button', { name: '保存する' });
    const equipment = within(entryForm()).getByLabelText('対象の設備', { exact: false });
    fireEvent.change(equipment, { target: { value: '' } });
    fireEvent.change(within(entryForm()).getByLabelText('計測日時', { exact: false }), {
      target: { value: '' },
    });

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/入力内容に誤りがあります（\d+件）/);
    expect(document.activeElement).toBe(equipment);
    expect(equipment.getAttribute('aria-invalid')).toBe('true');
  });
});
