import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Observation } from '../../../src/shared/schemas/observation.ts';
import { jsonResponse } from '../../support/frontend.ts';
import { callsOf, errorBody, renderApp } from '../../support/management-frontend.ts';
import { expectCardLabels } from '../../support/card-table.ts';

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    equipmentId: 'ROBOT-01' as Observation['equipmentId'],
    category: 'ENVIRONMENT',
    itemKey: 'temperature',
    observedAt: '2026-10-09T02:00:00.000Z',
    value: 25.5,
    source: 'AUTO_IMPORT',
    quality: 'VALID',
    receivedAt: '2026-10-09T02:01:00.000Z',
    isDeleted: false,
    ...overrides,
  };
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('取り込み済みデータ一覧（UC-20。SC-09）', () => {
  it('データを、日時・設備・カテゴリ・項目・値・取得元・状態で表示する。値は、単位つきの数値・ステータスコードの名称・欠損は「—」', async () => {
    renderApp('/observations', {
      'GET /observations': () =>
        jsonResponse({
          items: [
            observation(),
            observation({
              itemKey: 'robotStatus',
              category: 'STATUS',
              value: 'HARVESTING',
              source: 'MANUAL',
              quality: 'LATE',
            }),
            observation({
              itemKey: 'robotStatus',
              category: 'STATUS',
              value: 'UNREGISTERED',
              quality: 'INVALID',
            }),
            observation({
              value: null,
              quality: 'MISSING',
              equipmentId: 'GONE-01' as never,
              itemKey: 'unknownItem',
            }),
          ],
          nextCursor: null,
        }),
    });

    const rows = await screen.findAllByTestId('observation-row');

    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain('収穫ロボット1');
    expect(rows[0]?.textContent).toContain('環境情報');
    expect(rows[0]?.textContent).toContain('自動取り込み');
    expect(rows[0]?.textContent).toContain('有効');
    expect(rows[0]?.textContent).toContain('25.5');
    expect(rows[1]?.textContent).toContain('収穫中');
    expect(rows[1]?.textContent).toContain('手動入力');
    expect(rows[1]?.textContent).toContain('遅延');
    expect(rows[2]?.textContent).toContain('UNREGISTERED');
    expect(rows[2]?.textContent).toContain('不正');
    expect(rows[3]?.textContent).toContain('GONE-01');
    expect(rows[3]?.textContent).toContain('unknownItem');
    expect(rows[3]?.querySelector('td.numeric')?.textContent).toBe('—');
    expect(rows[3]?.textContent).toContain('欠損');
  });

  it('データがなければ、取り込みの状況・データ入力への案内を示す。絞り込み中は、該当なしだけ', async () => {
    renderApp('/observations', {
      'GET /observations': () => jsonResponse({ items: [], nextCursor: null }),
    });
    const empty = await screen.findByTestId('observations-empty');
    expect(within(empty).getByRole('link', { name: '取り込みの状況へ' }).getAttribute('href')).toBe(
      '/settings/ingestion',
    );
    expect(within(empty).getByRole('link', { name: 'データ入力へ' }).getAttribute('href')).toBe(
      '/data-entry',
    );
  });

  it('絞り込み中でデータがなければ、該当なしを示す', async () => {
    renderApp('/observations?source=MANUAL', {
      'GET /observations': () => jsonResponse({ items: [], nextCursor: null }),
    });
    expect((await screen.findByTestId('observations-empty')).textContent).toBe(
      '該当するデータはありません',
    );
  });

  it('条件（キーワード・カテゴリ・設備・取得元・期間・並べ替え）は、URL と、API のクエリに反映する', async () => {
    const { calls } = renderApp('/observations', {
      'GET /observations': () => jsonResponse({ items: [observation()], nextCursor: null }),
    });
    await screen.findAllByTestId('observation-row');
    const panel = screen.getByRole('region', { name: '検索' });

    fireEvent.change(within(panel).getByLabelText('キーワード'), { target: { value: '温度' } });
    fireEvent.change(within(panel).getByLabelText('カテゴリ'), {
      target: { value: 'ENVIRONMENT' },
    });
    fireEvent.change(within(panel).getByLabelText('設備'), { target: { value: 'SENSOR-01' } });
    fireEvent.change(within(panel).getByLabelText('取得元'), { target: { value: 'MANUAL' } });
    fireEvent.change(within(panel).getByLabelText('期間（開始日）'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(within(panel).getByLabelText('期間（終了日）'), {
      target: { value: '2026-10-09' },
    });
    fireEvent.change(within(panel).getByLabelText('並べ替え'), { target: { value: 'value' } });
    fireEvent.change(within(panel).getByLabelText('並べ替えの向き'), { target: { value: 'asc' } });

    await waitFor(() => {
      const last = callsOf(calls, 'GET', '/observations').at(-1)?.query;
      expect(last?.get('q')).toBe('温度');
      expect(last?.get('category')).toBe('ENVIRONMENT');
      expect(last?.get('equipmentId')).toBe('SENSOR-01');
      expect(last?.get('source')).toBe('MANUAL');
      expect(last?.get('from')).toBe('2026-09-30T15:00:00.000Z');
      expect(last?.get('to')).toBe('2026-10-09T14:59:59.999Z');
      expect(last?.get('sort')).toBe('value');
      expect(last?.get('direction')).toBe('asc');
    });
  });

  it('不正なクエリの値は、無視する', async () => {
    const { calls } = renderApp(
      '/observations?category=BAD&source=BAD&sort=BAD&from=1&direction=x',
      {
        'GET /observations': () => jsonResponse({ items: [observation()], nextCursor: null }),
      },
    );
    await screen.findAllByTestId('observation-row');
    const query = callsOf(calls, 'GET', '/observations')[0]?.query;
    expect(query?.get('category')).toBeNull();
    expect(query?.get('source')).toBeNull();
    expect(query?.get('sort')).toBe('observedAt');
    expect(query?.get('from')).toBeNull();
    expect(query?.get('direction')).toBe('desc');
  });

  it('ページ分割と、取得失敗の表示（再読み込み）', async () => {
    let failing = false;
    const { calls } = renderApp('/observations?from=2026-10-01&to=2026-10-09', {
      'GET /observations': (request) =>
        failing
          ? errorBody(500, 'INTERNAL_ERROR', '取得できません')
          : jsonResponse({
              items: [observation()],
              nextCursor: request.query.get('cursor') === null ? 'c-2' : null,
            }),
    });
    await screen.findAllByTestId('observation-row');
    fireEvent.click(screen.getByRole('button', { name: '次へ' }));
    await waitFor(() => {
      expect(screen.getByTestId('pager-page').textContent).toBe('2');
    });
    expect(callsOf(calls, 'GET', '/observations').at(-1)?.query.get('cursor')).toBe('c-2');
    fireEvent.click(screen.getByRole('button', { name: '前へ' }));
    await waitFor(() => {
      expect(screen.getByTestId('pager-page').textContent).toBe('1');
    });

    failing = true;
    fireEvent.change(screen.getByLabelText('キーワード'), { target: { value: 'x' } });
    expect((await screen.findByRole('alert')).textContent).toContain('取得できません');
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));
    expect(await screen.findAllByTestId('observation-row')).toHaveLength(1);
  });
});

describe('並べ替え（値・カテゴリ）・キーワード検索は、期間（31 日以内）が必須（#91。SC-09）', () => {
  const GUIDANCE = '並べ替え・検索は、期間（31 日以内）を指定してください';
  const listRoute = {
    'GET /observations': () => jsonResponse({ items: [observation()], nextCursor: null }),
  };

  it.each([
    ['値の順', '/observations?sort=value'],
    ['カテゴリの順', '/observations?sort=category'],
    ['キーワード', '/observations?q=%E6%B8%A9%E5%BA%A6'],
    ['開始日だけ', '/observations?sort=value&from=2026-10-01'],
    ['終了日だけ', '/observations?q=x&to=2026-10-09'],
  ])('%s で、期間が足りなければ、案内を表示し、一覧の API を呼ばない', async (_name, path) => {
    const { calls } = renderApp(path, listRoute);

    const guidance = await screen.findByTestId('observations-period-guidance');

    expect(guidance.textContent).toBe(GUIDANCE);
    expect(screen.queryAllByTestId('observation-row')).toHaveLength(0);
    expect(callsOf(calls, 'GET', '/observations')).toHaveLength(0);
  });

  it('期間が 31 日を超えるとき（10/1〜11/1 の 32 日分）も、案内を表示し、一覧の API を呼ばない', async () => {
    const tooLong = renderApp('/observations?sort=value&from=2026-10-01&to=2026-11-01', listRoute);
    expect((await screen.findByTestId('observations-period-guidance')).textContent).toBe(GUIDANCE);
    expect(callsOf(tooLong.calls, 'GET', '/observations')).toHaveLength(0);
  });

  it('期間が 31 日以内なら、並べ替え・キーワードを付けて、一覧を取得する（案内は出さない）', async () => {
    const { calls } = renderApp(
      '/observations?sort=value&q=%E6%B8%A9%E5%BA%A6&from=2026-10-01&to=2026-10-31',
      listRoute,
    );

    await screen.findAllByTestId('observation-row');

    expect(screen.queryByTestId('observations-period-guidance')).toBeNull();
    const query = callsOf(calls, 'GET', '/observations')[0]?.query;
    expect(query?.get('sort')).toBe('value');
    expect(query?.get('q')).toBe('温度');
    expect(query?.get('from')).toBe('2026-09-30T15:00:00.000Z');
    expect(query?.get('to')).toBe('2026-10-31T14:59:59.999Z');
  });

  it('計測日時の順で、キーワードがなければ、期間がなくても、一覧を表示する。空白だけのキーワードも同じ', async () => {
    const { calls } = renderApp('/observations?q=%20', listRoute);

    await screen.findAllByTestId('observation-row');

    expect(screen.queryByTestId('observations-period-guidance')).toBeNull();
    expect(callsOf(calls, 'GET', '/observations')).toHaveLength(1);
  });

  it('画面の操作: 並べ替えを「値」にすると案内が出て、期間（開始日・終了日）を入れると、一覧に戻る', async () => {
    renderApp('/observations', listRoute);
    await screen.findAllByTestId('observation-row');
    const panel = screen.getByRole('region', { name: '検索' });

    fireEvent.change(within(panel).getByLabelText('並べ替え'), { target: { value: 'value' } });
    expect((await screen.findByTestId('observations-period-guidance')).textContent).toBe(GUIDANCE);

    fireEvent.change(within(panel).getByLabelText('期間（開始日）'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(within(panel).getByLabelText('期間（終了日）'), {
      target: { value: '2026-10-09' },
    });
    expect(await screen.findAllByTestId('observation-row')).toHaveLength(1);
    expect(screen.queryByTestId('observations-period-guidance')).toBeNull();
  });
});

describe('取り込み済みデータの表の、狭い幅のカード（#151。SC-09）', () => {
  it('各セルが、同じ列の見出しを、カードの項目名（data-label）として持つ', async () => {
    renderApp('/observations', {
      'GET /observations': () => jsonResponse({ items: [observation()], nextCursor: null }),
    });
    await screen.findAllByTestId('observation-row');

    expectCardLabels();
  });
});
