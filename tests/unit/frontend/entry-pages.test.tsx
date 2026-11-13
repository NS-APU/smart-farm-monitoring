import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { satisfactionItemKey } from '../../../src/shared/constants/items.ts';
import { PERMISSIONS } from '../../../src/shared/constants/permissions.ts';
import { SATISFACTION_TARGET_VIEWPOINT_IDS } from '../../../src/shared/constants/viewpoints.ts';
import { toEquipmentId } from '../../../src/shared/schemas/common.ts';
import { jsonResponse } from '../../support/frontend.ts';
import {
  FULL_LOGIN,
  READ_ONLY_LOGIN,
  callsOf,
  errorBody,
  loginWith,
  manualEntry,
  noContent,
  renderApp,
  type Routes,
} from '../../support/management-frontend.ts';
import { expectCardLabels } from '../../support/card-table.ts';

const SAVED = {
  entry: manualEntry(),
  viewpointStatuses: [
    { viewpointId: 'durability', name: '耐久性', status: 'CAUTION' },
    { viewpointId: 'maintainability', name: 'メンテナンス性', status: 'NORMAL' },
  ],
};

function entryForm(): HTMLElement {
  const form = document.querySelector<HTMLElement>('form.entry-form');
  if (form === null) {
    throw new Error('入力のフォームがありません');
  }
  return form;
}

function field(label: string): HTMLElement {
  return within(entryForm()).getByLabelText(label, { exact: false });
}

/** 満足度の観点のスター（ラジオ）のグループ。名前は、観点の項目名（例: 満足度（収穫精度））。 */
function starGroup(container: HTMLElement, label: string): HTMLElement {
  return within(container).getByRole('radiogroup', { name: label });
}

function starRadio(container: HTMLElement, label: string, stars: number): HTMLInputElement {
  return within(starGroup(container, label)).getByRole<HTMLInputElement>('radio', {
    name: `${String(stars)}スター`,
  });
}

function pickStars(container: HTMLElement, label: string, stars: number): void {
  fireEvent.click(starRadio(container, label, stars));
}

const SATISFACTION_LABELS = [
  '満足度（収穫精度）',
  '満足度（収穫速度）',
  '満足度（環境適応性）',
  '満足度（操作性）',
  '満足度（メンテナンス性）',
  '満足度（コスト効率）',
  '満足度（安全性）',
  '満足度（データ活用度合い）',
  '満足度（耐久性）',
];

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState(null, '', '/');
});

describe('データ入力（UC-06。SC-06）', () => {
  it('権限（manual-entry:write）がなければ、入力できない旨を示し、フォームを表示しない', async () => {
    renderApp('/data-entry', {}, { login: READ_ONLY_LOGIN });
    expect((await screen.findByTestId('permission-notice')).textContent).toBe(
      'この操作を行う権限がありません',
    );
    expect(document.querySelector('form.entry-form')).toBeNull();
  });

  it('設備が登録されていなければ、その旨と、設備の管理への案内を示す', async () => {
    renderApp('/data-entry', { 'GET /equipment': () => jsonResponse({ facilities: [] }) });
    expect((await screen.findByTestId('no-equipment')).textContent).toContain(
      '設備が登録されていません',
    );
    expect(screen.getByRole('link', { name: '設備の管理へ' }).getAttribute('href')).toBe(
      '/settings/equipment',
    );
  });

  it('必須の項目が未入力のまま保存すると、項目ごとのエラーを表示し、API は呼ばない', async () => {
    const { calls } = renderApp('/data-entry');
    await screen.findByRole('button', { name: '保存する' });

    fireEvent.change(field('対象の設備'), { target: { value: '' } });
    fireEvent.change(field('計測日時'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect(await screen.findByText('対象の設備を選択してください')).toBeDefined();
    expect(screen.getByText('カテゴリを選択してください')).toBeDefined();
    expect(screen.getByText('計測日時を入力してください')).toBeDefined();
    expect(callsOf(calls, 'POST', '/manual-entries')).toHaveLength(0);
  });

  it('カテゴリを選ぶと、そのカテゴリの項目だけを、値の範囲の説明つきで表示する。カテゴリを変えると、入力した値を消す', async () => {
    renderApp('/data-entry');
    await screen.findByRole('button', { name: '保存する' });
    expect(screen.queryByTestId('entry-items')).toBeNull();

    fireEvent.change(field('カテゴリ'), { target: { value: 'FAILURE' } });

    const items = screen.getByTestId('entry-items');
    expect(within(items).getByLabelText('故障回数（回）')).toBeDefined();
    expect(within(items).getByLabelText('復旧に要した時間（分）')).toBeDefined();
    expect(within(items).getByText('0以上の整数')).toBeDefined();
    expect(within(items).queryByLabelText('操作時間（分）')).toBeNull();

    fireEvent.change(within(items).getByLabelText('故障回数（回）'), { target: { value: '3' } });
    fireEvent.change(field('カテゴリ'), { target: { value: 'OPERABILITY' } });
    expect(
      within(screen.getByTestId('entry-items')).getByLabelText<HTMLInputElement>('操作時間（分）')
        .value,
    ).toBe('');
  });

  it('自動取り込みの項目も、手動入力のカテゴリ（稼働情報・収穫情報）で選べる。1 果実あたりの収穫時間は、手動入力の範囲（0〜300）を示す（#192）', async () => {
    renderApp('/data-entry');
    await screen.findByRole('button', { name: '保存する' });
    expect(
      within(field('カテゴリ'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toContain('稼働情報');

    fireEvent.change(field('カテゴリ'), { target: { value: 'OPERATION' } });
    const operation = screen.getByTestId('entry-items');
    for (const label of [
      '稼働時間（時間）',
      '待機時間（時間）',
      '収穫稼働時間（時間）',
      '走行停止時間（時間）',
    ]) {
      expect(within(operation).getByLabelText(label)).toBeDefined();
    }

    fireEvent.change(field('カテゴリ'), { target: { value: 'HARVEST' } });
    const harvest = screen.getByTestId('entry-items');
    expect(within(harvest).getByLabelText('収穫数（個）')).toBeDefined();
    expect(within(harvest).getByLabelText('1果実あたりの収穫時間（秒/果実）')).toBeDefined();
    expect(within(harvest).getByText('0以上300以下の数値')).toBeDefined();
  });

  describe('満足度は、スターで選び、9観点が揃わないと保存できない（D-18）', () => {
    async function openSatisfactionForm(routes: Routes = {}) {
      const rendered = renderApp('/data-entry', routes);
      await screen.findByRole('button', { name: '保存する' });
      fireEvent.change(field('対象の設備'), { target: { value: 'HOUSE-01' } });
      fireEvent.change(field('カテゴリ'), { target: { value: 'SATISFACTION' } });
      return { ...rendered, items: screen.getByTestId('entry-items') };
    }

    it('9観点それぞれに、1〜5 のスターを選ぶグループを表示する（数値の文字入力ではない）', async () => {
      const { items } = await openSatisfactionForm();

      expect(within(items).getAllByRole('radiogroup')).toHaveLength(9);
      for (const label of SATISFACTION_LABELS) {
        expect(within(starGroup(items, label)).getAllByRole('radio')).toHaveLength(5);
      }
      expect(within(items).queryByRole('textbox')).toBeNull();
      expect(within(items).queryByRole('spinbutton')).toBeNull();
      expect(within(items).getByText('9観点すべてを選んでください（1〜5 スター）')).toBeDefined();
    });

    it('スターを選ぶと、その値が選ばれた状態になる。選び直せる', async () => {
      const { items } = await openSatisfactionForm();

      pickStars(items, '満足度（収穫精度）', 4);
      expect(starRadio(items, '満足度（収穫精度）', 4).checked).toBe(true);
      pickStars(items, '満足度（収穫精度）', 2);

      expect(starRadio(items, '満足度（収穫精度）', 2).checked).toBe(true);
      expect(starRadio(items, '満足度（収穫精度）', 4).checked).toBe(false);
    });

    it('何も選ばずに保存すると、9観点すべてのエラーを示し、API は呼ばない', async () => {
      const { calls, items } = await openSatisfactionForm();

      fireEvent.click(screen.getByRole('button', { name: '保存する' }));

      for (const label of SATISFACTION_LABELS) {
        expect(await screen.findByText(`${label}を選択してください`)).toBeDefined();
        expect(starGroup(items, label).getAttribute('aria-invalid')).toBe('true');
      }
      expect(callsOf(calls, 'POST', '/manual-entries')).toHaveLength(0);
    });

    it('一部の観点だけを選んで保存すると、選んでいない観点のエラーだけを示し、API は呼ばない', async () => {
      const { calls, items } = await openSatisfactionForm();
      for (const label of SATISFACTION_LABELS.slice(1)) {
        pickStars(items, label, 3);
      }

      fireEvent.click(screen.getByRole('button', { name: '保存する' }));

      expect(await screen.findByText('満足度（収穫精度）を選択してください')).toBeDefined();
      expect(screen.getAllByText(/を選択してください/)).toHaveLength(1);
      expect(callsOf(calls, 'POST', '/manual-entries')).toHaveLength(0);
    });

    it('9観点すべてを選んで保存すると、9観点の整数の値を送り、保存後は選択を空に戻す', async () => {
      const { calls, items } = await openSatisfactionForm({
        'POST /manual-entries': () => jsonResponse(SAVED, 201),
      });
      SATISFACTION_LABELS.forEach((label, index) => {
        pickStars(items, label, (index % 5) + 1);
      });

      fireEvent.click(screen.getByRole('button', { name: '保存する' }));

      await screen.findByTestId('entry-result');
      expect(callsOf(calls, 'POST', '/manual-entries')[0]?.body).toMatchObject({
        equipmentId: 'HOUSE-01',
        category: 'SATISFACTION',
        items: Object.fromEntries(
          SATISFACTION_TARGET_VIEWPOINT_IDS.map((viewpointId, index) => [
            satisfactionItemKey(viewpointId),
            (index % 5) + 1,
          ]),
        ),
      });
      expect(
        within(screen.getByTestId('entry-items')).queryAllByRole('radio', { checked: true }),
      ).toHaveLength(0);
    });

    it('スターは、観点ごとに 1 つのラジオのグループ（矢印キーで選べ、Tab の停止は 1 つ）', async () => {
      const { items } = await openSatisfactionForm();
      const radios = within(starGroup(items, '満足度（収穫精度）')).getAllByRole<HTMLInputElement>(
        'radio',
      );

      expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
      expect(radios.map((radio) => radio.value)).toEqual(['1', '2', '3', '4', '5']);
    });
  });

  it('項目を1つも入力していなければ、「1つ以上の項目を入力」のエラー。数値でない値・範囲外の値は、項目ごとのエラー', async () => {
    const { calls } = renderApp('/data-entry');
    await screen.findByRole('button', { name: '保存する' });
    fireEvent.change(field('対象の設備'), { target: { value: 'ROBOT-01' } });
    fireEvent.change(field('カテゴリ'), { target: { value: 'FAILURE' } });

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(await screen.findByText('1つ以上の項目を入力してください')).toBeDefined();

    fireEvent.change(screen.getByLabelText('故障回数（回）'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText('復旧に要した時間（分）'), { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect(await screen.findByText('故障回数は0以上の整数で指定してください')).toBeDefined();
    expect(screen.getByText('復旧に要した時間は0以上の数値で指定してください')).toBeDefined();
    expect(callsOf(calls, 'POST', '/manual-entries')).toHaveLength(0);
  });

  it('計測日時が未来・備考が上限を超える場合は、エラーを表示する', async () => {
    renderApp('/data-entry');
    await screen.findByRole('button', { name: '保存する' });
    fireEvent.change(field('対象の設備'), { target: { value: 'ROBOT-01' } });
    fireEvent.change(field('カテゴリ'), { target: { value: 'FAILURE' } });
    fireEvent.change(screen.getByLabelText('故障回数（回）'), { target: { value: '1' } });
    fireEvent.change(field('計測日時'), { target: { value: '2999-01-01T00:00' } });
    fireEvent.change(field('備考'), { target: { value: 'あ'.repeat(2001) } });

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect(await screen.findByText('計測日時に未来の日時は指定できません')).toBeDefined();
    expect(screen.getByText('備考は2000文字以内で入力してください')).toBeDefined();
  });

  it('保存: 日本時間の計測日時を UTC にして送り、入力した項目だけを送る。保存後は、関連観点のステータスを示し、フォームをクリアして、設備・カテゴリを引き継ぐ', async () => {
    const { calls } = renderApp('/data-entry', {
      'POST /manual-entries': () => jsonResponse(SAVED, 201),
    });
    await screen.findByRole('button', { name: '保存する' });
    fireEvent.change(field('対象の設備'), { target: { value: 'ROBOT-01' } });
    fireEvent.change(field('カテゴリ'), { target: { value: 'FAILURE' } });
    fireEvent.change(field('計測日時'), { target: { value: '2026-10-09T11:00' } });
    fireEvent.change(screen.getByLabelText('故障回数（回）'), { target: { value: ' 2 ' } });
    fireEvent.change(field('備考'), { target: { value: 'ケーブルを交換した' } });

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    const result = await screen.findByTestId('entry-result');
    expect(callsOf(calls, 'POST', '/manual-entries')[0]?.body).toEqual({
      equipmentId: 'ROBOT-01',
      category: 'FAILURE',
      observedAt: '2026-10-09T02:00:00.000Z',
      items: { failureCount: 2 },
      note: 'ケーブルを交換した',
    });
    expect(within(result).getByTestId('related-durability').textContent).toContain('耐久性');
    expect(within(result).getByTestId('related-maintainability').textContent).toContain(
      'メンテナンス性',
    );
    expect(within(result).getByRole('link', { name: '耐久性' }).getAttribute('href')).toBe(
      '/viewpoints/durability',
    );
    expect(screen.getByLabelText<HTMLInputElement>('故障回数（回）').value).toBe('');
    expect((field('備考') as HTMLTextAreaElement).value).toBe('');
    expect((field('対象の設備') as HTMLSelectElement).value).toBe('ROBOT-01');
    expect(
      JSON.parse(window.localStorage.getItem('smart-farm:last-entry-target') ?? 'null'),
    ).toEqual({
      equipmentId: 'ROBOT-01',
      category: 'FAILURE',
    });
  });

  describe('ステータスコード（文字列の項目）は、登録済みのコードから選ぶ（#192 の PR 2）', () => {
    it('ステータスのカテゴリで、登録済みのコードを、名称（コード）の選択肢で示す（削除済みは、出ない）。選んだコードを、文字列で送る', async () => {
      const { calls } = renderApp('/data-entry', {
        'GET /status-codes': () =>
          jsonResponse({
            items: [
              { code: 'HARVESTING', name: '収穫中', category: 'NORMAL', isDeleted: false },
              { code: 'FALLEN', name: '転倒（姿勢異常）', category: 'ERROR', isDeleted: false },
            ],
          }),
        'POST /manual-entries': () => jsonResponse(SAVED, 201),
      });
      await screen.findByRole('button', { name: '保存する' });
      fireEvent.change(field('対象の設備'), { target: { value: 'ROBOT-01' } });
      fireEvent.change(field('カテゴリ'), { target: { value: 'STATUS' } });
      fireEvent.change(field('計測日時'), { target: { value: '2026-10-09T11:00' } });

      const select = await within(screen.getByTestId('entry-items')).findByLabelText(
        'ステータスコード',
      );
      await waitFor(() => {
        expect(
          within(select)
            .getAllByRole('option')
            .map((option) => option.textContent),
        ).toEqual(['選択してください', '収穫中（HARVESTING）', '転倒（姿勢異常）（FALLEN）']);
      });
      fireEvent.change(select, { target: { value: 'FALLEN' } });
      fireEvent.click(screen.getByRole('button', { name: '保存する' }));

      await screen.findByTestId('entry-result');
      expect(callsOf(calls, 'POST', '/manual-entries')[0]?.body).toEqual({
        equipmentId: 'ROBOT-01',
        category: 'STATUS',
        observedAt: '2026-10-09T02:00:00.000Z',
        items: { statusCode: 'FALLEN' },
      });
    });

    it('コードを選ばずに保存すると、選択を求めるエラーを示し、送らない', async () => {
      const { calls } = renderApp('/data-entry', {
        'POST /manual-entries': () => jsonResponse(SAVED, 201),
      });
      await screen.findByRole('button', { name: '保存する' });
      fireEvent.change(field('対象の設備'), { target: { value: 'ROBOT-01' } });
      fireEvent.change(field('カテゴリ'), { target: { value: 'STATUS' } });
      fireEvent.change(field('計測日時'), { target: { value: '2026-10-09T11:00' } });

      fireEvent.click(screen.getByRole('button', { name: '保存する' }));

      expect(await screen.findByText('1つ以上の項目を入力してください')).toBeDefined();
      expect(callsOf(calls, 'POST', '/manual-entries')).toHaveLength(0);
    });

    it('入力済みデータの一覧に、コードの文字列を示す', async () => {
      renderApp('/data-entry/list', {
        'GET /manual-entries': () =>
          jsonResponse({
            items: [manualEntry({ category: 'STATUS', items: { statusCode: 'FALLEN' } })],
            nextCursor: null,
          }),
      });

      const row = await screen.findByTestId('entry-row');

      expect(row.textContent).toContain('ステータスコード');
      expect(row.textContent).toContain('FALLEN');
    });
  });

  it.each([
    ['DEFERRED', '数分かかります', '前回の評価のステータスです'],
    ['DONE', '評価を更新しました', '現在のステータスです'],
    [undefined, '評価を更新しました', '現在のステータスです'],
  ])(
    '保存後の説明は、評価の状態（%s）に合わせる。遅延（DEFERRED）なら、反映に数分かかり、前回の評価のステータスであることを示す',
    async (evaluation, expectedLead, expectedStatusNote) => {
      renderApp('/data-entry', {
        'POST /manual-entries': () =>
          jsonResponse({ ...SAVED, ...(evaluation === undefined ? {} : { evaluation }) }, 201),
      });
      await screen.findByRole('button', { name: '保存する' });
      fireEvent.change(field('対象の設備'), { target: { value: 'ROBOT-01' } });
      fireEvent.change(field('カテゴリ'), { target: { value: 'FAILURE' } });
      fireEvent.change(screen.getByLabelText('故障回数（回）'), { target: { value: '1' } });

      fireEvent.click(screen.getByRole('button', { name: '保存する' }));

      const lead = (await screen.findByTestId('entry-lead')).textContent;
      expect(lead).toContain(expectedLead);
      expect(lead).toContain(expectedStatusNote);
    },
  );

  it('備考が空なら、備考を送らない。関連する観点がなければ、その旨を示す', async () => {
    const { calls } = renderApp('/data-entry', {
      'POST /manual-entries': () => jsonResponse({ ...SAVED, viewpointStatuses: [] }, 201),
    });
    await screen.findByRole('button', { name: '保存する' });
    fireEvent.change(field('対象の設備'), { target: { value: 'ROBOT-01' } });
    fireEvent.change(field('カテゴリ'), { target: { value: 'FAILURE' } });
    fireEvent.change(screen.getByLabelText('故障回数（回）'), { target: { value: '0' } });
    fireEvent.change(field('備考'), { target: { value: '   ' } });

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect((await screen.findByTestId('entry-result')).textContent).toContain(
      '関連する観点の評価は、まだありません',
    );
    expect(callsOf(calls, 'POST', '/manual-entries')[0]?.body).not.toHaveProperty('note');
  });

  it('次に開いたときは、直前に入力した設備・カテゴリを選んでおく。記憶が壊れていても、入力に支障はない', async () => {
    window.localStorage.setItem(
      'smart-farm:last-entry-target',
      JSON.stringify({ equipmentId: 'SENSOR-01', category: 'ENVIRONMENT' }),
    );
    renderApp('/data-entry');
    await screen.findByRole('button', { name: '保存する' });
    expect((field('対象の設備') as HTMLSelectElement).value).toBe('SENSOR-01');
    expect((field('カテゴリ') as HTMLSelectElement).value).toBe('ENVIRONMENT');
  });

  it.each([
    ['JSON ではない', 'not-json'],
    ['形が違う', JSON.stringify({ equipmentId: 1 })],
    ['null', 'null'],
  ])('記憶の内容が%sときは、無視して、未選択にする', async (_name, stored) => {
    window.localStorage.setItem('smart-farm:last-entry-target', stored);
    renderApp('/data-entry');
    await screen.findByRole('button', { name: '保存する' });
    expect((field('カテゴリ') as HTMLSelectElement).value).toBe('');
  });

  it('記憶の保存・読み出しができない環境でも、保存できる', async () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('使えません');
    });
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('使えません');
    });
    renderApp('/data-entry', { 'POST /manual-entries': () => jsonResponse(SAVED, 201) });
    await screen.findByRole('button', { name: '保存する' });
    fireEvent.change(field('対象の設備'), { target: { value: 'ROBOT-01' } });
    fireEvent.change(field('カテゴリ'), { target: { value: 'FAILURE' } });
    fireEvent.change(screen.getByLabelText('故障回数（回）'), { target: { value: '1' } });

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect(await screen.findByTestId('entry-result')).toBeDefined();
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('サーバーが項目ごとのエラーを返したら、その項目に表示する。それ以外のエラーは、画面全体に表示する', async () => {
    let attempt = 0;
    renderApp('/data-entry', {
      'POST /manual-entries': () => {
        attempt += 1;
        return attempt === 1
          ? errorBody(422, 'VALIDATION_ERROR', '入力内容を確認してください', [
              { name: 'items.failureCount', message: 'サーバー側の検証: 範囲外です' },
            ])
          : errorBody(500, 'INTERNAL_ERROR', '保存できませんでした');
      },
    });
    await screen.findByRole('button', { name: '保存する' });
    fireEvent.change(field('対象の設備'), { target: { value: 'ROBOT-01' } });
    fireEvent.change(field('カテゴリ'), { target: { value: 'FAILURE' } });
    fireEvent.change(screen.getByLabelText('故障回数（回）'), { target: { value: '1' } });

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(await screen.findByText('サーバー側の検証: 範囲外です')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('保存できませんでした');
    });
  });

  it('入力のクリア: 入力した値・備考・エラーを消す', async () => {
    renderApp('/data-entry');
    await screen.findByRole('button', { name: '保存する' });
    fireEvent.change(field('対象の設備'), { target: { value: 'ROBOT-01' } });
    fireEvent.change(field('カテゴリ'), { target: { value: 'FAILURE' } });
    fireEvent.change(screen.getByLabelText('故障回数（回）'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await screen.findByText('故障回数は0以上の整数で指定してください');

    fireEvent.click(screen.getByRole('button', { name: '入力のクリア' }));

    expect(screen.queryByText('故障回数は0以上の整数で指定してください')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('故障回数（回）').value).toBe('');
  });

  it('データ入力から、入力済みデータの一覧へ移れる', async () => {
    renderApp('/data-entry');
    fireEvent.click(await screen.findByRole('link', { name: '入力済みデータの一覧へ' }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/data-entry/list');
    });
  });
});

function listRoutes(items = [manualEntry()], nextCursor: string | null = null): Routes {
  return { 'GET /manual-entries': () => jsonResponse({ items, nextCursor }) };
}

describe('入力済みデータ一覧（UC-18。SC-07）', () => {
  it('入力データを、計測日時・設備・カテゴリ・項目と値（単位つき）・入力者・備考で表示する。設備が階層にない場合は設備ID、備考がなければ「—」、未知の項目は項目名のまま', async () => {
    renderApp(
      '/data-entry/list',
      listRoutes([
        manualEntry(),
        manualEntry({
          entryId: 'e-2',
          equipmentId: 'ROBOT-99' as never,
          items: { unknownItem: 5 },
          note: undefined,
        }),
      ]),
    );

    const rows = await screen.findAllByTestId('entry-row');

    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('収穫ロボット1');
    expect(rows[0]?.textContent).toContain('故障情報');
    expect(rows[0]?.textContent).toContain('故障回数: 2回');
    expect(rows[0]?.textContent).toContain('復旧に要した時間: 90分');
    expect(rows[0]?.textContent).toContain('ケーブルを交換した');
    expect(rows[1]?.textContent).toContain('ROBOT-99');
    expect(rows[1]?.textContent).toContain('unknownItem: 5');
    expect(rows[1]?.querySelectorAll('td')[5]?.textContent).toBe('—');
  });

  it('データがなければ、データ入力への案内を表示する。絞り込み中は、案内なしで「該当するデータがありません」', async () => {
    renderApp('/data-entry/list', listRoutes([]));
    expect((await screen.findByTestId('entries-empty')).textContent).toContain(
      '入力済みのデータはありません',
    );
    expect(screen.getAllByRole('link', { name: 'データ入力へ' }).length).toBeGreaterThan(0);
  });

  it('絞り込み中でデータがなければ、該当なしを示す', async () => {
    renderApp('/data-entry/list?q=abc', listRoutes([]));
    const empty = await screen.findByTestId('entries-empty');
    expect(empty.textContent).toBe('該当するデータがありません');
  });

  it('条件（キーワード・カテゴリ・設備・期間・並べ替え）は、URL と、API のクエリに反映する。期間は日本時間の日の始め・終わり', async () => {
    const { calls } = renderApp('/data-entry/list', listRoutes());
    await screen.findAllByTestId('entry-row');
    const panel = screen.getByRole('region', { name: '検索' });

    fireEvent.change(within(panel).getByLabelText('キーワード'), {
      target: { value: ' ケーブル ' },
    });
    fireEvent.change(within(panel).getByLabelText('カテゴリ'), { target: { value: 'FAILURE' } });
    fireEvent.change(within(panel).getByLabelText('設備'), { target: { value: 'ROBOT-01' } });
    fireEvent.change(within(panel).getByLabelText('期間（開始日）'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(within(panel).getByLabelText('期間（終了日）'), {
      target: { value: '2026-10-09' },
    });
    fireEvent.change(within(panel).getByLabelText('並べ替え'), { target: { value: 'category' } });
    fireEvent.change(within(panel).getByLabelText('並べ替えの向き'), { target: { value: 'asc' } });

    await waitFor(() => {
      const last = callsOf(calls, 'GET', '/manual-entries').at(-1)?.query;
      expect(last?.get('q')).toBe('ケーブル');
      expect(last?.get('category')).toBe('FAILURE');
      expect(last?.get('equipmentId')).toBe('ROBOT-01');
      expect(last?.get('from')).toBe('2026-09-30T15:00:00.000Z');
      expect(last?.get('to')).toBe('2026-10-09T14:59:59.999Z');
      expect(last?.get('sort')).toBe('category');
      expect(last?.get('direction')).toBe('asc');
      expect(last?.get('limit')).toBe('20');
    });
    expect(window.location.search).toContain('sort=category');
  });

  it('不正なクエリの値（カテゴリ・並べ替え・日付）は、無視する', async () => {
    const { calls } = renderApp(
      '/data-entry/list?category=UNKNOWN&sort=bad&from=xxxx&direction=up',
      listRoutes(),
    );
    await screen.findAllByTestId('entry-row');
    const query = callsOf(calls, 'GET', '/manual-entries')[0]?.query;
    expect(query?.get('category')).toBeNull();
    expect(query?.get('sort')).toBe('observedAt');
    expect(query?.get('from')).toBeNull();
    expect(query?.get('direction')).toBe('desc');
  });

  it('ページ分割: 次へ・前へで、カーソルを使って移動する', async () => {
    const { calls } = renderApp('/data-entry/list', {
      'GET /manual-entries': (request) =>
        request.query.get('cursor') === 'c-2'
          ? jsonResponse({ items: [manualEntry({ entryId: 'e-9' })], nextCursor: null })
          : jsonResponse({ items: [manualEntry()], nextCursor: 'c-2' }),
    });
    await screen.findAllByTestId('entry-row');

    fireEvent.click(screen.getByRole('button', { name: '次へ' }));
    await waitFor(() => {
      expect(screen.getByTestId('pager-page').textContent).toBe('2');
    });
    expect(callsOf(calls, 'GET', '/manual-entries').at(-1)?.query.get('cursor')).toBe('c-2');
    fireEvent.click(screen.getByRole('button', { name: '前へ' }));
    await waitFor(() => {
      expect(screen.getByTestId('pager-page').textContent).toBe('1');
    });
  });

  it('入力の権限がなければ、操作の列を表示しない。変更履歴の権限があれば、変更履歴へのリンクを表示する', async () => {
    renderApp('/data-entry/list', listRoutes(), { login: loginWith(['audit:read']) });
    await screen.findAllByTestId('entry-row');
    expect(screen.queryByRole('button', { name: '修正' })).toBeNull();
    expect(screen.getByRole('link', { name: '変更履歴を見る' })).toBeDefined();
  });

  it('変更履歴の権限がなければ、変更履歴へのリンクを表示しない', async () => {
    renderApp('/data-entry/list', listRoutes(), { login: loginWith(['manual-entry:write']) });
    await screen.findAllByTestId('entry-row');
    expect(screen.queryByRole('link', { name: '変更履歴を見る' })).toBeNull();
  });

  it('修正: 入力内容をフォームに表示し、保存すると、更新の API を呼び、一覧を読み直して「修正しました」', async () => {
    let updated = false;
    const { calls } = renderApp('/data-entry/list', {
      'GET /manual-entries': () =>
        jsonResponse({
          items: [updated ? manualEntry({ items: { failureCount: 5 } }) : manualEntry()],
          nextCursor: null,
        }),
      'PUT /manual-entries/e-1': () => {
        updated = true;
        return jsonResponse(SAVED);
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: '修正' }));
    const edit = await screen.findByTestId('entry-edit');
    expect(within(edit).getByLabelText<HTMLInputElement>('故障回数（回）').value).toBe('2');
    fireEvent.change(within(edit).getByLabelText('故障回数（回）'), { target: { value: '5' } });

    fireEvent.click(within(edit).getByRole('button', { name: '保存' }));

    expect((await screen.findByTestId('entries-notice')).textContent).toBe('修正しました');
    expect(callsOf(calls, 'PUT', '/manual-entries/e-1')[0]?.body).toMatchObject({
      items: { failureCount: 5, recoveryMinutes: 90 },
    });
    expect(screen.queryByTestId('entry-edit')).toBeNull();
    await waitFor(() => {
      expect(screen.getAllByTestId('entry-row')[0]?.textContent).toContain('故障回数: 5回');
    });
  });

  it('修正: 一部の観点だけの既存の満足度の入力は、未入力の観点を空のまま示し、9観点を揃えるまで保存できない', async () => {
    const legacy = manualEntry({
      equipmentId: toEquipmentId('HOUSE-01'),
      category: 'SATISFACTION',
      items: { 'satisfaction.safety': 3 },
    });
    const { calls } = renderApp('/data-entry/list', {
      'GET /manual-entries': () => jsonResponse({ items: [legacy], nextCursor: null }),
      'PUT /manual-entries/e-1': () => jsonResponse(SAVED),
    });
    fireEvent.click(await screen.findByRole('button', { name: '修正' }));
    const edit = await screen.findByTestId('entry-edit');
    expect(starRadio(edit, '満足度（安全性）', 3).checked).toBe(true);

    fireEvent.click(within(edit).getByRole('button', { name: '保存' }));

    expect(await within(edit).findByText('満足度（収穫精度）を選択してください')).toBeDefined();
    expect(callsOf(calls, 'PUT', '/manual-entries/e-1')).toHaveLength(0);

    for (const label of SATISFACTION_LABELS.filter((item) => item !== '満足度（安全性）')) {
      pickStars(edit, label, 5);
    }
    fireEvent.click(within(edit).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(callsOf(calls, 'PUT', '/manual-entries/e-1')).toHaveLength(1);
    });
    expect(callsOf(calls, 'PUT', '/manual-entries/e-1')[0]?.body).toMatchObject({
      items: { 'satisfaction.safety': 3, 'satisfaction.harvestAccuracy': 5 },
    });
  });

  it('修正をキャンセルすると、フォームを閉じる', async () => {
    renderApp('/data-entry/list', listRoutes());
    fireEvent.click(await screen.findByRole('button', { name: '修正' }));
    const edit = await screen.findByTestId('entry-edit');

    fireEvent.click(within(edit).getByRole('button', { name: 'キャンセル' }));

    expect(screen.queryByTestId('entry-edit')).toBeNull();
  });

  it('削除: 確認のダイアログを表示し、確定すると、削除の API を呼んで、一覧を読み直す。キャンセルなら、何もしない', async () => {
    const { calls } = renderApp('/data-entry/list', {
      ...listRoutes(),
      'DELETE /manual-entries/e-1': () => noContent(),
    });
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    const dialog = await screen.findByTestId('confirm-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(callsOf(calls, 'DELETE', '/manual-entries/e-1')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', { name: '削除' }),
    );

    expect((await screen.findByTestId('entries-notice')).textContent).toBe('削除しました');
    expect(callsOf(calls, 'DELETE', '/manual-entries/e-1')).toHaveLength(1);
  });

  it('削除に失敗した場合は、エラーを表示し、ダイアログを閉じる', async () => {
    renderApp('/data-entry/list', {
      ...listRoutes(),
      'DELETE /manual-entries/e-1': () => errorBody(404, 'NOT_FOUND', 'データが見つかりません'),
    });
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', { name: '削除' }),
    );

    expect((await screen.findByRole('alert')).textContent).toBe('データが見つかりません');
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('一覧の取得に失敗した場合は、エラーを表示し、再読み込みできる', async () => {
    let failing = true;
    renderApp('/data-entry/list', {
      'GET /manual-entries': () =>
        failing
          ? errorBody(500, 'INTERNAL_ERROR', '取得できません')
          : jsonResponse({ items: [manualEntry()], nextCursor: null }),
    });
    expect((await screen.findByRole('alert')).textContent).toContain('取得できません');
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));
    expect(await screen.findAllByTestId('entry-row')).toHaveLength(1);
  });
});

const AUDIT_ENTRY = {
  auditId: 'a-1',
  occurredAt: '2026-10-09T02:00:00.000Z',
  operation: 'UPDATE',
  targetType: 'manual-entry',
  targetId: 'e-1',
  actor: 'worker-1',
  before: { items: { failureCount: 1, note: 'テキスト' } },
  after: { items: { failureCount: 2, unknownItem: 'x' } },
};

describe('変更履歴（UC-18。SC-08）', () => {
  it('権限（audit:read）がなければ、その旨を示し、API は呼ばない', async () => {
    const { calls } = renderApp(
      '/data-entry/history',
      {},
      { login: loginWith(['manual-entry:write']) },
    );
    expect((await screen.findByTestId('permission-notice')).textContent).toBe(
      '変更履歴を参照する権限がありません',
    );
    expect(callsOf(calls, 'GET', '/audit-logs')).toHaveLength(0);
  });

  it('履歴を、日時・操作種別・対象・変更者・変更前後の値で表示する。手動入力は、項目と値、その他は内容を開いて確認する', async () => {
    renderApp('/data-entry/history', {
      'GET /audit-logs': () =>
        jsonResponse({
          items: [
            AUDIT_ENTRY,
            {
              ...AUDIT_ENTRY,
              auditId: 'a-2',
              operation: 'CREATE',
              targetType: 'equipment',
              targetId: 'ROBOT-01',
              before: undefined,
              after: { name: '収穫ロボット1' },
            },
            {
              ...AUDIT_ENTRY,
              auditId: 'a-3',
              operation: 'DELETE',
              targetType: 'something-new',
              before: { items: 'not-object' },
              after: undefined,
            },
          ],
          nextCursor: null,
        }),
    });

    const rows = await screen.findAllByTestId('audit-row');

    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('編集');
    expect(rows[0]?.textContent).toContain('手動入力');
    expect(rows[0]?.textContent).toContain('故障回数: 1回');
    expect(rows[0]?.textContent).toContain('故障回数: 2回');
    expect(rows[0]?.textContent).toContain('unknownItem: x');
    expect(rows[1]?.textContent).toContain('登録');
    expect(rows[1]?.textContent).toContain('設備');
    expect(rows[1]?.textContent).toContain('内容を表示');
    expect(rows[1]?.querySelector('pre')?.textContent).toContain('収穫ロボット1');
    expect(rows[1]?.querySelectorAll('td')[4]?.textContent).toBe('—');
    expect(rows[2]?.textContent).toContain('削除');
    expect(rows[2]?.textContent).toContain('something-new');
  });

  it('手動入力の履歴は、項目の値のほかに、計測日時・設備・カテゴリ・備考を示す（備考が空・カテゴリが未知でも表示できる）', async () => {
    renderApp('/data-entry/history', {
      'GET /audit-logs': () =>
        jsonResponse({
          items: [
            {
              ...AUDIT_ENTRY,
              before: {
                items: { failureCount: 1 },
                observedAt: '2026-10-09T02:00:00.000Z',
                equipmentId: 'ROBOT-01',
                category: 'FAILURE',
                note: '修正前の備考',
              },
              after: {
                items: { failureCount: 1 },
                observedAt: '2026-10-09T03:00:00.000Z',
                equipmentId: 'ROBOT-02',
                category: 'new-category',
                note: '',
              },
            },
          ],
          nextCursor: null,
        }),
    });

    const row = (await screen.findAllByTestId('audit-row'))[0];

    const [before, after] = Array.from(row?.querySelectorAll('td') ?? []).slice(4);
    expect(before?.textContent).toContain('計測日時');
    expect(before?.textContent).toContain('2026/10/09 11:00:00');
    expect(before?.textContent).toContain('ROBOT-01');
    expect(before?.textContent).toContain('故障情報');
    expect(before?.textContent).toContain('修正前の備考');
    expect(after?.textContent).toContain('2026/10/09 12:00:00');
    expect(after?.textContent).toContain('ROBOT-02');
    expect(after?.textContent).toContain('new-category');
    expect(after?.textContent).not.toContain('備考');
  });

  it('条件（操作種別・対象・変更者・期間・並べ替え）は、API のクエリに反映する。不正なクエリの値は、無視する', async () => {
    const { calls } = renderApp('/data-entry/history?operation=BAD&targetType=BAD', {
      'GET /audit-logs': () => jsonResponse({ items: [AUDIT_ENTRY], nextCursor: null }),
    });
    await screen.findAllByTestId('audit-row');
    expect(callsOf(calls, 'GET', '/audit-logs')[0]?.query.get('operation')).toBeNull();
    const panel = screen.getByRole('region', { name: '検索' });

    fireEvent.change(within(panel).getByLabelText('操作種別'), { target: { value: 'UPDATE' } });
    fireEvent.change(within(panel).getByLabelText('対象'), { target: { value: 'manual-entry' } });
    fireEvent.change(within(panel).getByLabelText('変更者'), { target: { value: ' worker-1 ' } });
    fireEvent.change(within(panel).getByLabelText('期間（開始日）'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(within(panel).getByLabelText('期間（終了日）'), {
      target: { value: '2026-10-09' },
    });
    fireEvent.change(within(panel).getByLabelText('並べ替え'), { target: { value: 'asc' } });

    await waitFor(() => {
      const last = callsOf(calls, 'GET', '/audit-logs').at(-1)?.query;
      expect(last?.get('operation')).toBe('UPDATE');
      expect(last?.get('targetType')).toBe('manual-entry');
      expect(last?.get('actor')).toBe('worker-1');
      expect(last?.get('from')).toBe('2026-09-30T15:00:00.000Z');
      expect(last?.get('to')).toBe('2026-10-09T14:59:59.999Z');
      expect(last?.get('direction')).toBe('asc');
    });
  });

  it('履歴がなければ、その旨を示す。取得に失敗したら、エラーを表示する', async () => {
    renderApp('/data-entry/history', {
      'GET /audit-logs': () => jsonResponse({ items: [], nextCursor: null }),
    });
    expect((await screen.findByTestId('audit-empty')).textContent).toBe('該当する履歴はありません');
  });

  it('取得に失敗したら、エラーを表示する', async () => {
    renderApp('/data-entry/history', {
      'GET /audit-logs': () => errorBody(500, 'INTERNAL_ERROR', '取得できません'),
    });
    expect((await screen.findByRole('alert')).textContent).toContain('取得できません');
  });

  it('ページ分割: 次へ・前へで移動する', async () => {
    const { calls } = renderApp('/data-entry/history', {
      'GET /audit-logs': (request) =>
        jsonResponse({
          items: [AUDIT_ENTRY],
          nextCursor: request.query.get('cursor') === null ? 'c-2' : null,
        }),
    });
    await screen.findAllByTestId('audit-row');
    fireEvent.click(screen.getByRole('button', { name: '次へ' }));
    await waitFor(() => {
      expect(screen.getByTestId('pager-page').textContent).toBe('2');
    });
    expect(callsOf(calls, 'GET', '/audit-logs').at(-1)?.query.get('cursor')).toBe('c-2');
    fireEvent.click(screen.getByRole('button', { name: '前へ' }));
    await waitFor(() => {
      expect(screen.getByTestId('pager-page').textContent).toBe('1');
    });
  });

  it('入力済みデータへ戻るリンクがある', async () => {
    renderApp(
      '/data-entry/history',
      { 'GET /audit-logs': () => jsonResponse({ items: [], nextCursor: null }) },
      { login: { ...FULL_LOGIN, user: { ...FULL_LOGIN.user, permissions: [...PERMISSIONS] } } },
    );
    expect(
      (await screen.findByRole('link', { name: '入力済みデータへ戻る' })).getAttribute('href'),
    ).toBe('/data-entry/list');
  });
});

describe('入力済みデータ・変更履歴の表の、狭い幅のカード（#151。SC-07・SC-08）', () => {
  it('入力済みデータ（SC-07）: 各セルが、同じ列の見出しを、カードの項目名（data-label）として持つ', async () => {
    renderApp('/data-entry/list', listRoutes());
    await screen.findAllByTestId('entry-row');

    expectCardLabels();
  });

  it('変更履歴（SC-08）: 各セルが、同じ列の見出しを、カードの項目名（data-label）として持つ', async () => {
    renderApp('/data-entry/history', {
      'GET /audit-logs': () => jsonResponse({ items: [AUDIT_ENTRY], nextCursor: null }),
    });
    await screen.findAllByTestId('audit-row');

    expectCardLabels();
  });
});
