/**
 * 計測データ（SC-09）の「問題あり（欠損・遅延・不正を含む）」の絞り込み（Issue #152 の SC-09-3）の単体テスト。
 * 期間（31 日以内）が必須。選んでいる間は、自動で更新せず、手動の「更新」で取り直す（読み取りが多いため。ADR-0007）。
 * 適用中の条件の数・条件のクリア・API のクエリにも含める。
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLLING_INTERVAL_MS } from '../../../src/frontend/hooks/use-polling.ts';
import type { Measurement, Observation } from '../../../src/shared/schemas/observation.ts';
import { jsonResponse } from '../../support/frontend.ts';
import {
  at,
  callsOf,
  errorBody,
  renderApp,
  type Routes,
} from '../../support/management-frontend.ts';

const PROBLEM_GUIDANCE =
  '「問題あり」の絞り込みは、期間（31 日以内）を指定してください。多いときは、期間を狭めてください';
const PERIOD = 'from=2026-10-01&to=2026-10-09';

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    equipmentId: 'ROBOT-01' as Observation['equipmentId'],
    category: 'ENVIRONMENT',
    itemKey: 'temperatureCelsius',
    observedAt: '2026-10-09T02:00:00.000Z',
    value: 25.5,
    source: 'AUTO_IMPORT',
    quality: 'VALID',
    receivedAt: '2026-10-09T02:01:00.000Z',
    isDeleted: false,
    ...overrides,
  };
}

const PROBLEM_MEASUREMENT: Measurement = {
  equipmentId: 'ROBOT-01' as Measurement['equipmentId'],
  observedAt: '2026-10-09T02:00:00.000Z',
  source: 'AUTO_IMPORT',
  receivedAt: '2026-10-09T02:01:00.000Z',
  items: [
    observation({ itemKey: 'temperatureCelsius', value: 25.5 }),
    observation({ itemKey: 'humidityPercent', value: null, quality: 'MISSING' }),
  ],
};

const routes: Routes = {
  'GET /observations/measurements': () =>
    jsonResponse({ items: [PROBLEM_MEASUREMENT], nextCursor: null }),
  'GET /observations': () =>
    jsonResponse({
      items: [observation({ value: null, quality: 'MISSING' })],
      nextCursor: null,
    }),
};

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('「問題あり」の絞り込みの入力欄', () => {
  it('絞り込みの枠に、「問題あり（欠損・遅延・不正を含む）」のチェックボックスと、期間・件数の説明を示す。既定は、外れている', async () => {
    renderApp('/observations', routes);
    await screen.findAllByTestId('measurement-row');
    const panel = screen.getByRole('region', { name: '検索' });

    const checkbox = within(panel).getByRole('checkbox', {
      name: '問題あり（欠損・遅延・不正を含む）',
    });

    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('observations-problem-note').textContent).toBe(
      '期間は 31 日以内。多いときは、期間を狭めてください',
    );
    expect(screen.queryByTestId('filter-active-count')).toBeNull();
    // 選んでいないときは、手動の「更新」も、自動で更新しない旨の案内も、示さない
    expect(screen.queryByRole('button', { name: '更新' })).toBeNull();
    expect(screen.queryByTestId('observations-manual-refresh-note')).toBeNull();
  });

  it('URL の problemOnly=true で、選んだ状態になる。true 以外の値は、無視する', async () => {
    renderApp(`/observations?problemOnly=true&${PERIOD}`, routes);
    await screen.findAllByTestId('measurement-row');
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /問題あり/ }).checked).toBe(true);
  });

  it('true 以外の値は、選んでいない扱い（期間も不要）', async () => {
    const { calls } = renderApp('/observations?problemOnly=yes', routes);
    await screen.findAllByTestId('measurement-row');

    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /問題あり/ }).checked).toBe(
      false,
    );
    expect(
      callsOf(calls, 'GET', '/observations/measurements')[0]?.query.get('problemOnly'),
    ).toBeNull();
  });
});

describe('「問題あり」は、期間（31 日以内）が必須', () => {
  it('期間がなければ、「問題あり」の案内を示し、一覧の API を呼ばない', async () => {
    const { calls } = renderApp('/observations?problemOnly=true', routes);

    const guidance = await screen.findByTestId('observations-period-guidance');

    expect(guidance.textContent).toBe(PROBLEM_GUIDANCE);
    expect(callsOf(calls, 'GET', '/observations/measurements')).toHaveLength(0);
    expect(callsOf(calls, 'GET', '/observations')).toHaveLength(0);
  });

  it('期間が 31 日を超えるとき（10/1〜11/1 の 32 日分）・片方だけのときも、案内を示し、API を呼ばない', async () => {
    const tooLong = renderApp(
      '/observations?problemOnly=true&from=2026-10-01&to=2026-11-01',
      routes,
    );
    expect((await screen.findByTestId('observations-period-guidance')).textContent).toBe(
      PROBLEM_GUIDANCE,
    );
    expect(callsOf(tooLong.calls, 'GET', '/observations/measurements')).toHaveLength(0);
    tooLong.unmount();

    const half = renderApp('/observations?problemOnly=true&from=2026-10-01', routes);
    expect((await screen.findByTestId('observations-period-guidance')).textContent).toBe(
      PROBLEM_GUIDANCE,
    );
    expect(callsOf(half.calls, 'GET', '/observations/measurements')).toHaveLength(0);
  });

  it('画面の操作: 「問題あり」を選ぶと案内が出て、期間（開始日・終了日）を入れると、計測ごとの一覧に戻る', async () => {
    const { calls } = renderApp('/observations', routes);
    await screen.findAllByTestId('measurement-row');
    const panel = screen.getByRole('region', { name: '検索' });

    fireEvent.click(within(panel).getByRole('checkbox', { name: /問題あり/ }));
    expect((await screen.findByTestId('observations-period-guidance')).textContent).toBe(
      PROBLEM_GUIDANCE,
    );
    expect(window.location.search).toBe('?problemOnly=true');

    fireEvent.change(within(panel).getByLabelText('期間（開始日）'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(within(panel).getByLabelText('期間（終了日）'), {
      target: { value: '2026-10-09' },
    });

    expect(await screen.findAllByTestId('measurement-row')).toHaveLength(1);
    expect(screen.queryByTestId('observations-period-guidance')).toBeNull();
    const last = callsOf(calls, 'GET', '/observations/measurements').at(-1)?.query;
    expect(last?.get('problemOnly')).toBe('true');
    expect(last?.get('from')).toBe('2026-09-30T15:00:00.000Z');
    expect(last?.get('to')).toBe('2026-10-09T14:59:59.999Z');
  });

  it('日時順は計測ごと、日時以外の並べ替えは項目ごとの API に、problemOnly=true を付ける', async () => {
    const byTime = renderApp(`/observations?problemOnly=true&${PERIOD}`, routes);
    await screen.findAllByTestId('measurement-row');
    expect(
      callsOf(byTime.calls, 'GET', '/observations/measurements')[0]?.query.get('problemOnly'),
    ).toBe('true');
    byTime.unmount();

    const byValue = renderApp(`/observations?problemOnly=true&sort=value&${PERIOD}`, routes);
    await screen.findAllByTestId('observation-row');
    expect(callsOf(byValue.calls, 'GET', '/observations')[0]?.query.get('problemOnly')).toBe(
      'true',
    );
  });

  it('計測ごとの一覧は、有効でない項目（欠損）と、有効な項目の、全項目を示す。状態は、有効でない項目の件数', async () => {
    renderApp(`/observations?problemOnly=true&${PERIOD}`, routes);

    const row = at(await screen.findAllByTestId('measurement-row'), 0);

    expect(within(row).getAllByTestId('measurement-item')).toHaveLength(2);
    expect(row.textContent).toContain('欠損');
    expect(row.textContent).toContain('25.5℃');
  });

  it('該当がなければ、絞り込み中の「該当するデータはありません」を示す（データがないときの案内は出さない）', async () => {
    renderApp(`/observations?problemOnly=true&${PERIOD}`, {
      'GET /observations/measurements': () => jsonResponse({ items: [], nextCursor: null }),
    });

    expect((await screen.findByTestId('observations-empty')).textContent).toBe(
      '該当するデータはありません',
    );
  });

  it('上限（5 万件）を超えたときのエラーは、期間を絞り込む案内を、そのまま示し、再読み込みできる', async () => {
    renderApp(`/observations?problemOnly=true&${PERIOD}`, {
      'GET /observations/measurements': () =>
        errorBody(
          400,
          'VALIDATION_ERROR',
          '条件に合う観測値が多すぎます。期間を絞り込んでください',
        ),
    });

    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toContain('期間を絞り込んでください');
    expect(screen.getByRole('button', { name: '再読み込み' })).toBeDefined();
  });
});

describe('適用中の条件の数・条件のクリア', () => {
  it('「問題あり」は、適用中の条件に数える。条件のクリアで、外れる（URL・API の条件）', async () => {
    const { calls } = renderApp(
      `/observations?problemOnly=true&category=ENVIRONMENT&${PERIOD}`,
      routes,
    );
    await screen.findAllByTestId('measurement-row');

    expect(screen.getByTestId('filter-active-count').textContent).toBe('適用中の条件 4 件');

    fireEvent.click(screen.getByRole('button', { name: '条件のクリア' }));

    await waitFor(() => {
      expect(window.location.search).toBe('');
    });
    expect(screen.queryByTestId('filter-active-count')).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /問題あり/ }).checked).toBe(
      false,
    );
    await waitFor(() => {
      const last = callsOf(calls, 'GET', '/observations/measurements').at(-1)?.query;
      expect(last?.get('problemOnly')).toBeNull();
      expect(last?.get('category')).toBeNull();
    });
    expect(screen.queryByRole('button', { name: '更新' })).toBeNull();
  });

  it('チェックを外すと、「問題あり」の条件が外れ、期間のないときの案内も消える', async () => {
    renderApp('/observations?problemOnly=true', routes);
    await screen.findByTestId('observations-period-guidance');

    fireEvent.click(screen.getByRole('checkbox', { name: /問題あり/ }));

    expect(await screen.findAllByTestId('measurement-row')).toHaveLength(1);
    expect(screen.queryByTestId('observations-period-guidance')).toBeNull();
    expect(window.location.search).toBe('');
  });
});

describe('「問題あり」を選んでいる間は、自動で更新せず、手動の「更新」で取り直す', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function tick(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('定期の取得も、タブへ戻ったときの取得もしない。「更新」を押すと、取り直す。自動で更新しない旨を示す', async () => {
    const { calls } = renderApp(`/observations?problemOnly=true&${PERIOD}`, routes);
    await screen.findAllByTestId('measurement-row');
    const count = () => callsOf(calls, 'GET', '/observations/measurements').length;
    const initial = count();

    await tick(POLLING_INTERVAL_MS * 6);
    expect(count()).toBe(initial);

    fireEvent(document, new Event('visibilitychange'));
    await tick(0);
    expect(count()).toBe(initial);

    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => {
      expect(count()).toBe(initial + 1);
    });
    expect(screen.getByTestId('observations-manual-refresh-note').textContent).toContain(
      '自動では更新',
    );
  });

  it('選んでいないときは、これまでどおり、定期に取得する', async () => {
    const { calls } = renderApp(`/observations?${PERIOD}`, routes);
    await screen.findAllByTestId('measurement-row');
    const count = () => callsOf(calls, 'GET', '/observations/measurements').length;
    const initial = count();

    await tick(POLLING_INTERVAL_MS * 2);

    await waitFor(() => {
      expect(count()).toBeGreaterThan(initial);
    });
  });

  it('選んだあとに外すと、定期の取得に戻る', async () => {
    const { calls } = renderApp(`/observations?problemOnly=true&${PERIOD}`, routes);
    await screen.findAllByTestId('measurement-row');
    const count = () => callsOf(calls, 'GET', '/observations/measurements').length;

    fireEvent.click(screen.getByRole('checkbox', { name: /問題あり/ }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '更新' })).toBeNull();
    });
    const afterUncheck = count();
    await tick(POLLING_INTERVAL_MS * 2);

    await waitFor(() => {
      expect(count()).toBeGreaterThan(afterUncheck);
    });
  });
});
