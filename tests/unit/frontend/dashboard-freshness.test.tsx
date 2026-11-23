/**
 * ダッシュボード（SC-02）のデータ・評価の鮮度の表示（Issue #158 の PR1。D-12・SC-02-6・SC-11-9）の単体テスト。
 * - 古い設備の一覧（開くと、設備名・最終の受信日時・基準〔分〕）
 * - 評価が更新されていないときの警告（評価の間隔 5 分 × 3 = 15 分。境界の 14 分 59 秒・15 分・16 分）
 * - 最終の評価・最終のデータ取得のヘルプヒント
 * 現在の時刻は、`vi.setSystemTime`（Date だけを差し替える）で固定する（フィクスチャの最終の評価は、2026-10-09T03:00:00Z）。
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import { dashboard, jsonResponse } from '../../support/frontend.ts';
import { renderApp } from '../../support/management-frontend.ts';

const EVALUATED_AT = '2026-10-09T03:00:00.000Z';
const evaluatedMs = Date.parse(EVALUATED_AT);

function setNow(offsetSeconds: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(evaluatedMs + offsetSeconds * 1000));
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState(null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
});

const stale = (index: number, thresholdMinutes = 3) => ({
  equipmentId: toEquipmentId(`ROBOT-${String(index)}`),
  name: `ロボット${String(index)}`,
  lastReceivedAt: '2026-10-09T02:00:00.000Z',
  thresholdMinutes,
});

describe('古い設備の一覧（D-12）', () => {
  it('警告の文は、先頭 3 件と「ほか N 件」のまま。一覧は、閉じた状態から始まり、開くと、設備名・最終の受信日時・基準（分）を示す', async () => {
    setNow(60);
    renderApp('/', {
      'GET /dashboard': () =>
        jsonResponse(
          dashboard({
            dataFreshness: 'STALE',
            staleEquipment: [stale(1), stale(2, 15), stale(3), stale(4), stale(5)],
          }),
        ),
    });

    const text = await screen.findByTestId('stale-equipment');
    expect(text.textContent).toContain('ロボット3');
    expect(text.textContent).not.toContain('ロボット4');
    expect(text.textContent).toContain('ほか 2 件');

    const details = screen.getByTestId<HTMLDetailsElement>('stale-equipment-details');
    expect(details.open).toBe(false);
    expect(within(details).getByText('古い設備の一覧（5 件）')).toBeDefined();

    fireEvent.click(within(details).getByText('古い設備の一覧（5 件）'));
    expect(details.open).toBe(true);

    const table = within(details).getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers).toEqual(['設備名', '最終の受信日時', '基準（分）']);
    const rows = within(table).getAllByRole('row').slice(1);
    // 4 件目・5 件目も、一覧には示す
    expect(rows).toHaveLength(5);
    const secondRow = within(rows.slice(1, 2)[0] ?? document.body);
    const second = secondRow.getAllByRole('cell').map((cell) => cell.textContent);
    expect(secondRow.getByRole('rowheader').textContent).toBe('ロボット2');
    expect(second).toEqual(['2026/10/09 11:00:00', '15 分']);
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'ロボット1',
      'ロボット2',
      'ロボット3',
      'ロボット4',
      'ロボット5',
    ]);
  });

  it('古い設備がなければ（STALE でも、設備の指定がない）、一覧を出さない', async () => {
    setNow(60);
    renderApp('/', {
      'GET /dashboard': () => jsonResponse(dashboard({ dataFreshness: 'STALE' })),
    });

    await screen.findByText(/データが古くなっています/);
    expect(screen.queryByTestId('stale-equipment-details')).toBeNull();
  });
});

describe('評価の鮮度の警告（SC-02-6。評価の間隔 5 分 × 3 = 15 分）', () => {
  const dashboardWith = () => ({ 'GET /dashboard': () => jsonResponse(dashboard()) });

  it('15 分に満たなければ（14 分 59 秒）、警告を出さない', async () => {
    setNow(15 * 60 - 1);
    renderApp('/', dashboardWith());

    await screen.findByTestId('dashboard-meta');
    expect(screen.queryByTestId('evaluation-stale')).toBeNull();
  });

  it('ちょうど 15 分で、警告を出す。最終の評価の日時を含む', async () => {
    setNow(15 * 60);
    renderApp('/', dashboardWith());

    const warning = await screen.findByTestId('evaluation-stale');
    expect(warning.getAttribute('role')).toBe('alert');
    expect(warning.textContent).toContain(
      '評価が更新されていません（最終の評価: 2026/10/09 12:00:00）',
    );
  });

  it('15 分を超えたときも、警告を出す（16 分）', async () => {
    setNow(16 * 60);
    renderApp('/', dashboardWith());

    expect(await screen.findByTestId('evaluation-stale')).toBeDefined();
  });

  it('評価がまだなければ（最終の評価が null）、警告を出さない（「評価がまだ行われていません」は、観点ごとに示す）', async () => {
    setNow(60 * 60);
    renderApp('/', {
      'GET /dashboard': () => jsonResponse(dashboard({ evaluatedAt: null })),
    });

    await screen.findByTestId('dashboard-meta');
    expect(screen.queryByTestId('evaluation-stale')).toBeNull();
  });

  it('データの古い警告と、評価の古い警告は、別々に出る', async () => {
    setNow(20 * 60);
    renderApp('/', {
      'GET /dashboard': () =>
        jsonResponse(dashboard({ dataFreshness: 'STALE', staleEquipment: [stale(1)] })),
    });

    const evaluation = await screen.findByTestId('evaluation-stale');
    expect(evaluation.textContent).not.toContain('データが古くなっています');
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });
});

describe('ヘルプヒント（SC-02-6・SC-11-9。D-11）', () => {
  it('「最終の評価」の横のヒントは、評価が定期（5 分ごと）に更新され、反映が最大 5 分遅れること、15 分以上更新されないと警告を出すことを説明する', async () => {
    setNow(60);
    renderApp('/', { 'GET /dashboard': () => jsonResponse(dashboard()) });
    await screen.findByTestId('dashboard-meta');

    fireEvent.click(screen.getByRole('button', { name: '最終の評価の説明' }));

    const note = screen.getByRole('note').textContent;
    expect(note).toContain('5 分ごと');
    expect(note).toContain('最大 5 分');
    expect(note).toContain('15 分以上');
  });

  it('「最終のデータ取得」の横のヒントは、画面は 10 秒ごとに更新されるが、新しいデータが増えるのは取得間隔ごとであることと、自動取り込みを外した影響を説明する', async () => {
    setNow(60);
    renderApp('/', { 'GET /dashboard': () => jsonResponse(dashboard()) });
    await screen.findByTestId('dashboard-meta');

    fireEvent.click(screen.getByRole('button', { name: '最終のデータ取得の説明' }));

    const note = screen.getByRole('note').textContent;
    expect(note).toContain('10 秒ごとに更新');
    expect(note).toContain('取得間隔ごと');
    expect(note).toContain('自動取り込みを有効にする');
  });

  it('手動のみの運用では、「最終の手動入力」の説明にする（取得間隔の説明は出さない）', async () => {
    setNow(60);
    renderApp('/', {
      'GET /dashboard': () =>
        jsonResponse(
          dashboard({
            dataFreshness: 'MANUAL',
            lastReceivedAt: null,
            lastManualInputAt: '2026-10-09T02:30:00.000Z',
          }),
        ),
    });
    await screen.findByTestId('dashboard-meta');

    expect(screen.queryByRole('button', { name: '最終のデータ取得の説明' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '最終の手動入力の説明' }));
    expect(screen.getByRole('note').textContent).toContain('手動入力');
  });
});
