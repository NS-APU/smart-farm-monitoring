/**
 * 変更履歴への導線（#155 PR3。SC-07-10・SC-09-5・SC-13-6、#152 の SC-08-4）。
 * 入力済みデータの各行・計測データの手動入力の行・判断基準の編集画面から、対象を指定して変更履歴を開く。
 * 変更履歴は、対象の絞り込みのチップを示し、対象を絞った表示では、自動の更新を止める（手動の「更新」）。
 */

import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { useCallback } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolling, POLLING_INTERVAL_MS } from '../../../src/frontend/hooks/use-polling.ts';
import type { Measurement, Observation } from '../../../src/shared/schemas/observation.ts';
import { jsonResponse } from '../../support/frontend.ts';
import {
  at,
  callsOf,
  loginWith,
  manualEntry,
  renderApp,
  type Routes,
} from '../../support/management-frontend.ts';

const HISTORY_OF_E1 = '/data-entry/history?targetType=manual-entry&targetId=e-1';

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

function listRoutes(): Routes {
  return {
    'GET /manual-entries': () => jsonResponse({ items: [manualEntry()], nextCursor: null }),
  };
}

describe('入力済みデータ（SC-07。SC-07-10）: 各行の「履歴」', () => {
  it('変更履歴の権限があれば、各行に「履歴」を示し、その入力（手動入力・入力の ID）の変更履歴を開く', async () => {
    renderApp('/data-entry/list', listRoutes());
    const row = at(await screen.findAllByTestId('entry-row'), 0);

    expect(within(row).getByRole('link', { name: '履歴' }).getAttribute('href')).toBe(
      HISTORY_OF_E1,
    );
  });

  it('入力の ID が URL に使えない文字を含んでも、そのまま渡せる（エンコードする）', async () => {
    renderApp('/data-entry/list', {
      'GET /manual-entries': () =>
        jsonResponse({ items: [manualEntry({ entryId: 'a b&c' })], nextCursor: null }),
    });
    const row = at(await screen.findAllByTestId('entry-row'), 0);

    expect(within(row).getByRole('link', { name: '履歴' }).getAttribute('href')).toBe(
      '/data-entry/history?targetType=manual-entry&targetId=a+b%26c',
    );
  });

  it('変更履歴の権限がなければ、「履歴」を示さない（修正・削除は、入力の権限で示す）', async () => {
    renderApp('/data-entry/list', listRoutes(), { login: loginWith(['manual-entry:write']) });
    await screen.findAllByTestId('entry-row');

    expect(screen.queryByRole('link', { name: '履歴' })).toBeNull();
    expect(screen.getByRole('button', { name: '修正' })).toBeDefined();
  });

  it('入力の権限がなくても、変更履歴の権限があれば、「履歴」を示す（修正・削除は示さない）', async () => {
    renderApp('/data-entry/list', listRoutes(), { login: loginWith(['audit:read']) });
    await screen.findAllByTestId('entry-row');

    expect(screen.getByRole('link', { name: '履歴' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '修正' })).toBeNull();
  });

  it('どちらの権限もなければ、操作の列を示さない', async () => {
    renderApp('/data-entry/list', listRoutes(), { login: loginWith([]) });
    await screen.findAllByTestId('entry-row');

    expect(screen.queryByRole('columnheader', { name: '操作' })).toBeNull();
    expect(screen.queryByRole('link', { name: '履歴' })).toBeNull();
  });
});

/** 日時順（既定）の一覧の API（計測単位）。 */
function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    equipmentId: 'ROBOT-01' as Observation['equipmentId'],
    category: 'FAILURE',
    itemKey: 'failureCount',
    observedAt: '2026-10-09T02:00:00.000Z',
    value: 2,
    source: 'MANUAL',
    quality: 'VALID',
    receivedAt: '2026-10-09T02:01:00.000Z',
    isDeleted: false,
    manualEntryId: 'e-1',
    ...overrides,
  };
}

function measurement(overrides: Partial<Measurement> = {}): Measurement {
  return {
    equipmentId: 'ROBOT-01' as Measurement['equipmentId'],
    observedAt: '2026-10-09T02:00:00.000Z',
    source: 'MANUAL',
    manualEntryId: 'e-1',
    receivedAt: '2026-10-09T02:01:00.000Z',
    items: [observation()],
    ...overrides,
  };
}

function measurementRoutes(items: Measurement[]): Routes {
  return {
    'GET /observations/measurements': () => jsonResponse({ items, nextCursor: null }),
  };
}

describe('計測データ（SC-09。SC-09-5）: 手動入力の行の「入力データを開く」「履歴」', () => {
  it('手動入力の行に、入力データ一覧（設備・計測日時の日で絞る）と、その入力の変更履歴へのリンクを示す', async () => {
    renderApp('/observations', measurementRoutes([measurement()]));
    const row = at(await screen.findAllByTestId('measurement-row'), 0);

    expect(within(row).getByRole('link', { name: '入力データを開く' }).getAttribute('href')).toBe(
      '/data-entry/list?equipmentId=ROBOT-01&from=2026-10-09&to=2026-10-09',
    );
    expect(within(row).getByRole('link', { name: '履歴' }).getAttribute('href')).toBe(
      HISTORY_OF_E1,
    );
  });

  it('計測日時の日は、日本時間の日付にする（UTC では前日でも、日本時間の日）', async () => {
    renderApp(
      '/observations',
      measurementRoutes([measurement({ observedAt: '2026-10-08T16:30:00.000Z' })]),
    );
    const row = at(await screen.findAllByTestId('measurement-row'), 0);

    expect(within(row).getByRole('link', { name: '入力データを開く' }).getAttribute('href')).toBe(
      '/data-entry/list?equipmentId=ROBOT-01&from=2026-10-09&to=2026-10-09',
    );
  });

  it('自動取り込みの行には、リンクを示さない', async () => {
    renderApp(
      '/observations',
      measurementRoutes([
        measurement({ source: 'AUTO_IMPORT', manualEntryId: undefined as never }),
      ]),
    );
    await screen.findAllByTestId('measurement-row');

    expect(screen.queryByRole('link', { name: '入力データを開く' })).toBeNull();
    expect(screen.queryByRole('link', { name: '履歴' })).toBeNull();
  });

  it('変更履歴の権限がなければ、「履歴」を示さない（「入力データを開く」は示す）', async () => {
    renderApp('/observations', measurementRoutes([measurement()]), { login: loginWith([]) });
    await screen.findAllByTestId('measurement-row');

    expect(screen.getByRole('link', { name: '入力データを開く' })).toBeDefined();
    expect(screen.queryByRole('link', { name: '履歴' })).toBeNull();
  });

  it('項目ごとの一覧（日時以外の並べ替え）の手動入力の行にも、同じリンクを示す', async () => {
    renderApp('/observations?sort=category&from=2026-10-01&to=2026-10-09', {
      'GET /observations': () =>
        jsonResponse({
          items: [
            observation(),
            observation({ source: 'AUTO_IMPORT', manualEntryId: undefined as never }),
          ],
          nextCursor: null,
        }),
    });
    const rows = await screen.findAllByTestId('observation-row');

    expect(within(at(rows, 0)).getByRole('link', { name: '履歴' }).getAttribute('href')).toBe(
      HISTORY_OF_E1,
    );
    expect(within(at(rows, 1)).queryByRole('link')).toBeNull();
  });
});

const CRITERIA = {
  viewpointId: 'environmentalAdaptability',
  version: 'DEFAULT',
  isDefault: true,
  usesStatusIndicator: false,
  criteria: [
    {
      indicator: 'humidityPercent',
      kind: 'UPPER',
      label: '湿度',
      thresholds: { cautionFrom: 80, errorFrom: 90 },
    },
  ],
};

describe('判断基準の編集（SC-13。SC-13-6）: 「変更履歴を見る」', () => {
  const route = {
    'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(CRITERIA),
  };

  it('変更履歴の権限があれば、その観点（判断基準・観点の ID）の変更履歴を開くリンクを示す', async () => {
    renderApp('/viewpoints/environmentalAdaptability/criteria', route);

    expect((await screen.findByRole('link', { name: '変更履歴を見る' })).getAttribute('href')).toBe(
      '/data-entry/history?targetType=criteria&targetId=environmentalAdaptability',
    );
  });

  it('変更履歴の権限がなければ、リンクを示さない', async () => {
    renderApp('/viewpoints/environmentalAdaptability/criteria', route, {
      login: loginWith(['criteria:edit']),
    });
    await screen.findByTestId('criteria-state');

    expect(screen.queryByRole('link', { name: '変更履歴を見る' })).toBeNull();
  });
});

const AUDIT_OF_E1 = {
  auditId: 'a-2',
  occurredAt: '2026-10-09T03:00:00.000Z',
  operation: 'UPDATE',
  targetType: 'manual-entry',
  targetId: 'e-1',
  actor: 'worker-1',
  before: {
    observedAt: '2026-10-09T02:00:00.000Z',
    equipmentId: 'ROBOT-01',
    category: 'FAILURE',
    items: { failureCount: 1 },
  },
  after: {
    observedAt: '2026-10-09T02:00:00.000Z',
    equipmentId: 'ROBOT-01',
    category: 'FAILURE',
    items: { failureCount: 2, recoveryMinutes: 30 },
  },
};

function auditRoutes(items: unknown[] = [AUDIT_OF_E1]): Routes {
  return { 'GET /audit-logs': () => jsonResponse({ items, nextCursor: null }) };
}

describe('変更履歴（SC-08。SC-08-4）: 対象の絞り込み', () => {
  it('URL の対象の種類と ID を、API のクエリに渡し、チップ「対象: …」に、名前（計測日時・設備名・項目）で示す。ID の入力欄は設けない', async () => {
    const { calls } = renderApp(HISTORY_OF_E1, auditRoutes());
    const chip = await screen.findByTestId('audit-target-chip');
    await screen.findAllByTestId('audit-row');

    expect(chip.textContent).toContain('対象: 手動入力');
    expect(chip.textContent).toContain('2026/10/09 11:00');
    expect(chip.textContent).toContain('収穫ロボット1');
    expect(chip.textContent).toContain('故障回数');
    expect(chip.textContent).toContain('復旧に要した時間');
    expect(chip.textContent).not.toContain('e-1');
    const query = callsOf(calls, 'GET', '/audit-logs')[0]?.query;
    expect(query?.get('targetType')).toBe('manual-entry');
    expect(query?.get('targetId')).toBe('e-1');
    expect(screen.queryByLabelText('対象の ID')).toBeNull();
    expect(screen.queryByLabelText('対象ID')).toBeNull();
  });

  it('判断基準は観点名、設備は設備名で示す。名前を解決できないときは、種類だけを示す', async () => {
    const { unmount } = renderApp(
      '/data-entry/history?targetType=criteria&targetId=durability',
      auditRoutes([{ ...AUDIT_OF_E1, targetType: 'criteria', targetId: 'durability' }]),
    );
    expect((await screen.findByTestId('audit-target-chip')).textContent).toContain(
      '対象: 判断基準（耐久性）',
    );
    unmount();
    window.history.pushState(null, '', '/');

    const second = renderApp(
      '/data-entry/history?targetType=equipment&targetId=ROBOT-01',
      auditRoutes([{ ...AUDIT_OF_E1, targetType: 'equipment', targetId: 'ROBOT-01' }]),
    );
    expect((await screen.findByTestId('audit-target-chip')).textContent).toContain(
      '対象: 設備（収穫ロボット1）',
    );
    second.unmount();
    window.history.pushState(null, '', '/');

    renderApp('/data-entry/history?targetType=user&targetId=worker-9', auditRoutes([]));
    const chip = await screen.findByTestId('audit-target-chip');
    expect(chip.textContent).toContain('対象: ユーザー');
    expect(chip.textContent).not.toContain('worker-9');
    expect(chip.textContent).not.toContain('（');
  });

  it('手動入力の履歴がなくて名前を解決できなければ、種類だけを示す', async () => {
    renderApp(HISTORY_OF_E1, auditRoutes([]));
    const chip = await screen.findByTestId('audit-target-chip');

    expect(chip.textContent).toContain('対象: 手動入力');
    expect(chip.textContent).not.toContain('（');
  });

  it('チップの「解除」で、対象の絞り込み（ID）だけを外す。ほかの条件（種類・操作種別）は残す', async () => {
    const { calls } = renderApp(`${HISTORY_OF_E1}&operation=UPDATE`, auditRoutes());
    const chip = await screen.findByTestId('audit-target-chip');

    fireEvent.click(within(chip).getByRole('button', { name: /解除/ }));

    await waitFor(() => {
      expect(screen.queryByTestId('audit-target-chip')).toBeNull();
    });
    expect(window.location.search).toContain('targetType=manual-entry');
    expect(window.location.search).toContain('operation=UPDATE');
    expect(window.location.search).not.toContain('targetId');
    await waitFor(() => {
      const last = callsOf(calls, 'GET', '/audit-logs').at(-1)?.query;
      expect(last?.get('targetId')).toBeNull();
      expect(last?.get('targetType')).toBe('manual-entry');
    });
  });

  it('対象の絞り込みは、適用中の条件に数え、条件のクリアで、対象も外す', async () => {
    renderApp(HISTORY_OF_E1, auditRoutes());
    await screen.findByTestId('audit-target-chip');
    // 対象の種類（1）と対象の ID（1）
    expect(screen.getByTestId('filter-active-count').textContent).toContain('2');

    fireEvent.click(screen.getByRole('button', { name: '条件のクリア' }));

    await waitFor(() => {
      expect(screen.queryByTestId('audit-target-chip')).toBeNull();
    });
    expect(window.location.search).toBe('');
  });

  it('種類のない対象の ID は、無視する（チップを示さず、API にも渡さない）', async () => {
    const { calls } = renderApp('/data-entry/history?targetId=e-1', auditRoutes());
    await screen.findAllByTestId('audit-row');

    expect(screen.queryByTestId('audit-target-chip')).toBeNull();
    expect(callsOf(calls, 'GET', '/audit-logs')[0]?.query.get('targetId')).toBeNull();
  });

  it('対象を絞らない表示には、チップも「更新」のボタンも示さない', async () => {
    renderApp('/data-entry/history?targetType=manual-entry', auditRoutes());
    await screen.findAllByTestId('audit-row');

    expect(screen.queryByTestId('audit-target-chip')).toBeNull();
    expect(screen.queryByRole('button', { name: '更新' })).toBeNull();
  });
});

describe('変更履歴（SC-08）: 対象を絞った表示は、自動で更新せず、手動の「更新」で取り直す', () => {
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

  it('対象を絞った表示は、定期の取得をしない。「更新」を押すと、取り直す', async () => {
    const { calls } = renderApp(HISTORY_OF_E1, auditRoutes());
    await screen.findByTestId('audit-target-chip');
    const count = () => callsOf(calls, 'GET', '/audit-logs').length;
    const initial = count();

    await tick(POLLING_INTERVAL_MS * 6);
    expect(count()).toBe(initial);

    // タブへ戻ったときの自動の取得も、しない
    fireEvent(document, new Event('visibilitychange'));
    await tick(0);
    expect(count()).toBe(initial);

    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => {
      expect(count()).toBe(initial + 1);
    });
    expect(screen.getByTestId('audit-manual-refresh-note').textContent).toContain('自動では更新');
  });

  it('対象を絞らない表示は、これまでどおり、定期に取得する', async () => {
    const { calls } = renderApp('/data-entry/history', auditRoutes());
    await screen.findAllByTestId('audit-row');
    const count = () => callsOf(calls, 'GET', '/audit-logs').length;
    const initial = count();

    await tick(POLLING_INTERVAL_MS * 2);

    await waitFor(() => {
      expect(count()).toBeGreaterThan(initial);
    });
  });
});

describe('定期的な取得（usePolling）: 間隔に null を指定すると、自動の取得をしない', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('最初の取得と、reload だけで取得する（定期・タブへ戻ったときの取得はしない）', async () => {
    const fetcher = vi.fn<() => Promise<string>>().mockResolvedValue('x');
    const { result } = renderHook(() => usePolling(fetcher, null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 5);
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.reload();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('間隔が null から数値へ変わると、定期の取得を始める', async () => {
    const fetcher = vi.fn<() => Promise<string>>().mockResolvedValue('x');
    const { rerender } = renderHook(
      ({ interval }: { interval: number | null }) =>
        usePolling(
          useCallback(() => fetcher(), []),
          interval,
        ),
      { initialProps: { interval: null as number | null } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    rerender({ interval: POLLING_INTERVAL_MS });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    });

    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  });
});
