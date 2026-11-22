/**
 * 一覧の共通部品の、各画面への適用（Issue #152 の PR1。SC-05・SC-07・SC-08・SC-09・SC-11）の単体テスト。
 * 条件のクリアは、URL・API の条件を初期値に戻す。適用中の条件の数と、ページ送りの表示範囲を示す。
 * 部品そのものは、list-filter-parts.test.tsx。
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import {
  callsOf,
  manualEntry,
  notification,
  renderApp,
  type Routes,
} from '../../support/management-frontend.ts';

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

const entryRoute = (items = [manualEntry()], nextCursor: string | null = null): Routes => ({
  'GET /manual-entries': () => jsonResponse({ items, nextCursor }),
});

describe('入力済みデータ一覧（SC-07）への適用', () => {
  it('設備の絞り込みの選択肢は、ハウスの下にロボット・センサーを字下げし、種別を付ける（SC-07-8）', async () => {
    renderApp('/data-entry/list', entryRoute());
    await screen.findAllByTestId('entry-row');

    const panel = screen.getByRole('region', { name: '検索' });
    const options = within(within(panel).getByLabelText('設備')).getAllByRole('option');

    expect(options.map((option) => option.textContent)).toEqual([
      'すべて',
      'ハウス1',
      '　収穫ロボット1（ロボット）',
      '　環境センサー1（センサー）',
    ]);
  });

  it('キーワードが一致する項目（設備名・カテゴリ・入力者・備考・入力項目の名称と値）を、説明文に示す', async () => {
    renderApp('/data-entry/list', entryRoute());
    await screen.findAllByTestId('entry-row');

    expect(screen.getByTestId('entries-keyword-note').textContent).toBe(
      'キーワードは、設備名・カテゴリ・入力者・備考・入力項目の名称と値から探します',
    );
  });

  it('適用中の条件の数を示し（絞り込み・並べ替えの、初期値でないもの）、条件のクリアで、すべて初期値に戻る（URL・API の条件）', async () => {
    const { calls } = renderApp(
      '/data-entry/list?q=abc&category=FAILURE&equipmentId=ROBOT-01&sort=category&direction=asc',
      entryRoute(),
    );
    await screen.findAllByTestId('entry-row');

    expect(screen.getByTestId('filter-active-count').textContent).toBe('適用中の条件 5 件');

    fireEvent.click(screen.getByRole('button', { name: '条件のクリア' }));

    await waitFor(() => {
      expect(window.location.search).toBe('');
    });
    await waitFor(() => {
      const last = callsOf(calls, 'GET', '/manual-entries').at(-1)?.query;
      expect(last?.get('q')).toBeNull();
      expect(last?.get('category')).toBeNull();
      expect(last?.get('equipmentId')).toBeNull();
      expect(last?.get('sort')).toBe('observedAt');
      expect(last?.get('direction')).toBe('desc');
    });
    expect(screen.queryByTestId('filter-active-count')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('キーワード').value).toBe('');
  });

  it('並べ替えを既定の値に選び直しても、適用中の条件には数えない（URL にクエリが残っても、初期値と同じ）', async () => {
    renderApp('/data-entry/list?sort=observedAt&direction=desc', entryRoute());
    await screen.findAllByTestId('entry-row');

    expect(screen.queryByTestId('filter-active-count')).toBeNull();
  });

  it('ページの表示範囲を示す（1 ページ目: 1〜2 件目。次のページ: 21〜22 件目）', async () => {
    renderApp('/data-entry/list', {
      'GET /manual-entries': (request) =>
        request.query.get('cursor') === 'c-2'
          ? jsonResponse({
              items: [manualEntry({ entryId: 'e-8' }), manualEntry({ entryId: 'e-9' })],
              nextCursor: null,
            })
          : jsonResponse({
              items: [manualEntry(), manualEntry({ entryId: 'e-2' })],
              nextCursor: 'c-2',
            }),
    });
    await screen.findAllByTestId('entry-row');
    expect(screen.getByTestId('pager-range').textContent).toBe('1〜2 件目');

    fireEvent.click(screen.getByRole('button', { name: '次へ' }));

    await waitFor(() => {
      expect(screen.getByTestId('pager-range').textContent).toBe('21〜22 件目');
    });
  });
});

const AUDIT_ENTRY = {
  auditId: 'a-1',
  occurredAt: '2026-10-09T02:00:00.000Z',
  operation: 'UPDATE',
  targetType: 'manual-entry',
  targetId: 'e-1',
  actor: 'worker-1',
  before: { items: { failureCount: 1 } },
  after: { items: { failureCount: 2 } },
};

describe('変更履歴（SC-08）への適用', () => {
  it('適用中の条件の数を示し、条件のクリアで、すべて初期値に戻る', async () => {
    const { calls } = renderApp(
      '/data-entry/history?operation=UPDATE&targetType=manual-entry&actor=worker-1&from=2026-10-01&direction=asc',
      { 'GET /audit-logs': () => jsonResponse({ items: [AUDIT_ENTRY], nextCursor: null }) },
    );
    await screen.findAllByTestId('audit-row');

    expect(screen.getByTestId('filter-active-count').textContent).toBe('適用中の条件 5 件');

    fireEvent.click(screen.getByRole('button', { name: '条件のクリア' }));

    await waitFor(() => {
      expect(window.location.search).toBe('');
    });
    await waitFor(() => {
      const last = callsOf(calls, 'GET', '/audit-logs').at(-1)?.query;
      expect(last?.get('operation')).toBeNull();
      expect(last?.get('targetType')).toBeNull();
      expect(last?.get('actor')).toBeNull();
      expect(last?.get('from')).toBeNull();
      expect(last?.get('direction')).toBe('desc');
    });
  });

  it('ページの表示範囲を示す', async () => {
    renderApp('/data-entry/history', {
      'GET /audit-logs': () => jsonResponse({ items: [AUDIT_ENTRY], nextCursor: 'c-2' }),
    });
    await screen.findAllByTestId('audit-row');

    expect(screen.getByTestId('pager-range').textContent).toBe('1〜1 件目');
  });
});

const OBSERVATION = {
  equipmentId: 'ROBOT-01',
  category: 'ENVIRONMENT',
  itemKey: 'temperatureCelsius',
  observedAt: '2026-10-09T02:00:00.000Z',
  value: 25.5,
  source: 'AUTO_IMPORT',
  quality: 'VALID',
  receivedAt: '2026-10-09T02:01:00.000Z',
  isDeleted: false,
};

describe('取り込み済みデータ（SC-09）への適用', () => {
  const routes: Routes = {
    'GET /observations': () => jsonResponse({ items: [OBSERVATION], nextCursor: 'c-2' }),
    'GET /observations/measurements': () => jsonResponse({ items: [], nextCursor: null }),
  };

  it('適用中の条件の数を示し、条件のクリアで、すべて初期値（日時順）に戻る', async () => {
    const { calls } = renderApp(
      '/observations?category=ENVIRONMENT&source=MANUAL&equipmentId=ROBOT-01&sort=value&direction=asc&from=2026-10-01&to=2026-10-09',
      routes,
    );
    await screen.findAllByTestId('observation-row');

    expect(screen.getByTestId('filter-active-count').textContent).toBe('適用中の条件 7 件');

    fireEvent.click(screen.getByRole('button', { name: '条件のクリア' }));

    await waitFor(() => {
      expect(window.location.search).toBe('');
    });
    await waitFor(() => {
      expect(callsOf(calls, 'GET', '/observations/measurements').length).toBeGreaterThan(0);
    });
    const last = callsOf(calls, 'GET', '/observations/measurements').at(-1)?.query;
    expect(last?.get('category')).toBeNull();
    expect(last?.get('source')).toBeNull();
    expect(last?.get('equipmentId')).toBeNull();
    expect(last?.get('from')).toBeNull();
    expect(last?.get('direction')).toBe('desc');
  });

  it('ページの表示範囲を示す', async () => {
    renderApp('/observations?sort=value&from=2026-10-01&to=2026-10-09', routes);
    await screen.findAllByTestId('observation-row');

    expect(screen.getByTestId('pager-range').textContent).toBe('1〜1 件目');
  });
});

describe('通知一覧（SC-05）への適用', () => {
  it('適用中の条件の数を示し、条件のクリアで、種別・既読状態が初期値に戻る', async () => {
    const { calls } = renderApp('/notifications?kind=STATUS_CHANGE&readState=UNREAD', {
      'GET /notifications': () =>
        jsonResponse({
          items: [notification()],
          nextCursor: 'c-2',
          asOf: '2026-10-09T03:00:00.000Z',
        }),
    });
    await screen.findAllByTestId('notification-row');

    expect(screen.getByTestId('filter-active-count').textContent).toBe('適用中の条件 2 件');
    expect(screen.getByTestId('pager-range').textContent).toBe('1〜1 件目');

    fireEvent.click(screen.getByRole('button', { name: '条件のクリア' }));

    await waitFor(() => {
      expect(window.location.search).toBe('');
    });
    await waitFor(() => {
      const last = callsOf(calls, 'GET', '/notifications').at(-1)?.query;
      expect(last?.get('kind')).toBeNull();
      expect(last?.get('readState')).toBeNull();
    });
  });

  it('既読にする操作（絞り込みの範囲・すべて）は、絞り込みの枠の中のまま（条件のクリアと並ぶ）', async () => {
    renderApp('/notifications', {
      'GET /notifications': () =>
        jsonResponse({
          items: [notification()],
          nextCursor: null,
          asOf: '2026-10-09T03:00:00.000Z',
        }),
    });
    await screen.findAllByTestId('notification-row');

    const panel = screen.getByRole('region', { name: '絞り込み' });
    expect(within(panel).getByRole('button', { name: 'すべての通知を既読にする' })).toBeDefined();
    expect(within(panel).getByRole('button', { name: '条件のクリア' })).toBeDefined();
  });
});

const INGESTION_SETTINGS = {
  sources: [
    {
      sourceId: 'robot',
      kind: 'ROBOT',
      profileId: 'robot-v1',
      isEnabled: true,
      formatProfile: { versionLabel: 'v0.1', status: 'PROVISIONAL' },
      lastStartedAt: null,
      lastSuccessAt: null,
      equipment: [
        {
          equipmentId: 'ROBOT-1',
          name: '収穫ロボット1',
          lastStartedAt: null,
          lastResult: null,
          lastSuccessAt: null,
          lastDataAt: null,
        },
      ],
      isRunning: false,
    },
  ],
};

const INGESTION_LOG = {
  logId: 'l-1',
  sourceId: 'robot',
  equipmentId: 'ROBOT-1',
  startedAt: '2026-10-09T02:00:00.000Z',
  finishedAt: '2026-10-09T02:00:05.000Z',
  result: 'SUCCESS',
  filesProcessed: 2,
  recordCount: 10,
  rejectedCount: 1,
  attempts: 1,
};

describe('取り込み・連携のログ（SC-11）への適用', () => {
  const routes: Routes = {
    'GET /ingestion/settings': () => jsonResponse(INGESTION_SETTINGS),
    'GET /ingestion/logs': () => jsonResponse({ items: [INGESTION_LOG], nextCursor: 'c-2' }),
    'GET /federation/logs': () =>
      jsonResponse({
        items: [],
        nextCursor: null,
        queue: { PENDING: 0, SENT: 0, FAILED: 0, HELD: 0, EXPIRED: 0 },
      }),
  };

  it('適用中の条件の数を示し、条件のクリアで、ログの条件（設備・結果・期間）だけが初期値に戻る（ほかのクエリは残す）', async () => {
    const { calls } = renderApp(
      '/settings/ingestion?equipment=ROBOT-1&result=FAILURE&from=2026-10-01&to=2026-10-09&keep=1',
      routes,
    );
    const section = await screen.findByTestId('ingestion-logs');
    await within(section).findAllByTestId('ingestion-log-row');

    expect(within(section).getByTestId('filter-active-count').textContent).toBe(
      '適用中の条件 4 件',
    );

    fireEvent.click(within(section).getByRole('button', { name: '条件のクリア' }));

    await waitFor(() => {
      expect(window.location.search).toBe('?keep=1');
    });
    await waitFor(() => {
      const last = callsOf(calls, 'GET', '/ingestion/logs').at(-1)?.query;
      expect(last?.get('equipmentId')).toBeNull();
      expect(last?.get('result')).toBeNull();
      expect(last?.get('from')).toBeNull();
      expect(last?.get('to')).toBeNull();
    });
  });

  it('ログの設備の絞り込みは、取り込み元ごとの設備の名称のまま。ページの表示範囲を示す', async () => {
    renderApp('/settings/ingestion', routes);
    const section = await screen.findByTestId('ingestion-logs');
    await within(section).findAllByTestId('ingestion-log-row');

    expect(within(section).getByTestId('pager-range').textContent).toBe('1〜1 件目');
    expect(within(section).queryByTestId('filter-active-count')).toBeNull();
  });
});
