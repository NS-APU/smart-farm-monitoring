import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '../../../src/shared/constants/permissions.ts';
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
      '/data-entry/list?category=OPERATION&sort=bad&from=xxxx&direction=up',
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
