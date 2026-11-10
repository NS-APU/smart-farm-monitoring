import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import {
  READ_ONLY_LOGIN,
  callsOf,
  errorBody,
  renderApp,
  type Routes,
} from '../../support/management-frontend.ts';

/**
 * 取り込み・連携のハウス別の記録（一般ユーザー向け。Issue #332。ADR-0013）。
 * 取り込みの参照権限（ingestion:read）がない利用者に、閲覧できるハウスの分だけを見せる。
 * 設定・接続先・認証情報・失敗の理由・全体の件数・連携キューの件数は、表示しない（取得もしない）。
 */

function ingestionEntry(overrides: Record<string, unknown> = {}) {
  return {
    logId: 'i-1',
    facilityId: 'HOUSE-01',
    sourceId: 'robot',
    occurredAt: '2026-10-09T02:00:00.000Z',
    result: 'SUCCESS',
    recordCount: 12,
    ...overrides,
  };
}

function federationEntry(overrides: Record<string, unknown> = {}) {
  return {
    logId: 'f-1',
    facilityId: 'HOUSE-01',
    occurredAt: '2026-10-09T02:00:00.000Z',
    result: 'SENT',
    itemCount: 4,
    ...overrides,
  };
}

function facilityRoutes(extra: Routes = {}): Routes {
  return {
    'GET /ingestion/facility-logs': () =>
      jsonResponse({
        items: [
          ingestionEntry(),
          ingestionEntry({ logId: 'i-2', result: 'FAILURE', recordCount: 0, sourceId: 'unknown' }),
        ],
        nextCursor: null,
      }),
    'GET /federation/facility-logs': () =>
      jsonResponse({
        items: [federationEntry(), federationEntry({ logId: 'f-2', result: 'HELD', itemCount: 1 })],
        nextCursor: null,
      }),
    ...extra,
  };
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('取り込み・連携のハウス別の記録（一般ユーザー向け。#332）', () => {
  it('取りこみの参照権限がなければ、ハウス別の記録を表示する。ハウス名・取り込み元・結果・件数を示す', async () => {
    renderApp('/settings/ingestion', facilityRoutes(), { login: READ_ONLY_LOGIN });

    const rows = await screen.findAllByTestId('facility-ingestion-row');

    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('ハウス1');
    expect(rows[0]?.textContent).toContain('ロボットデータ');
    expect(rows[0]?.textContent).toContain('成功');
    expect(rows[0]?.textContent).toContain('12');
    expect(rows[0]?.getAttribute('data-result')).toBe('SUCCESS');
    // 取り込み元の名前が未定義でも、そのまま示す
    expect(rows[1]?.textContent).toContain('unknown');
    expect(rows[1]?.textContent).toContain('失敗');
    const federationRows = await screen.findAllByTestId('facility-federation-row');
    expect(federationRows).toHaveLength(2);
    expect(federationRows[0]?.textContent).toContain('ハウス1');
    expect(federationRows[0]?.textContent).toContain('成功');
    expect(federationRows[1]?.textContent).toContain('保留');
  });

  it('管理用の取り込みの設定・ログ・連携のログ・認証情報・連携キューの件数は、取得も表示もしない', async () => {
    const { calls } = renderApp('/settings/ingestion', facilityRoutes(), {
      login: READ_ONLY_LOGIN,
    });

    await screen.findAllByTestId('facility-ingestion-row');

    expect(calls.filter((call) => call.path.startsWith('/ingestion/settings'))).toEqual([]);
    expect(callsOf(calls, 'GET', '/ingestion/logs')).toEqual([]);
    expect(callsOf(calls, 'GET', '/federation/logs')).toEqual([]);
    expect(screen.queryByTestId('source-robot')).toBeNull();
    expect(screen.queryByTestId('federation-queue')).toBeNull();
    expect(screen.queryByText('認証情報', { exact: false })).toBeNull();
  });

  it('記録がなければ、割り当てたハウスに記録がない旨を示す', async () => {
    renderApp(
      '/settings/ingestion',
      facilityRoutes({
        'GET /ingestion/facility-logs': () => jsonResponse({ items: [], nextCursor: null }),
        'GET /federation/facility-logs': () => jsonResponse({ items: [], nextCursor: null }),
      }),
      { login: READ_ONLY_LOGIN },
    );

    expect((await screen.findByTestId('facility-ingestion-empty')).textContent).toBe(
      '閲覧できるハウスの取り込みの記録はありません',
    );
    expect((await screen.findByTestId('facility-federation-empty')).textContent).toBe(
      '閲覧できるハウスの連携の記録はありません',
    );
  });

  it('続きがあれば、ページで次の記録を取得する', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      facilityRoutes({
        'GET /ingestion/facility-logs': (request) =>
          jsonResponse(
            request.query.get('cursor') === 'c-1'
              ? { items: [ingestionEntry({ logId: 'i-9', recordCount: 99 })], nextCursor: null }
              : { items: [ingestionEntry()], nextCursor: 'c-1' },
          ),
      }),
      { login: READ_ONLY_LOGIN },
    );
    await screen.findAllByTestId('facility-ingestion-row');

    const panel = screen.getByTestId('facility-ingestion');
    fireEvent.click(within(panel).getByRole('button', { name: '次へ' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('facility-ingestion-row')[0]?.textContent).toContain('99');
    });
    expect(
      callsOf(calls, 'GET', '/ingestion/facility-logs').some(
        (call) => call.query.get('cursor') === 'c-1',
      ),
    ).toBe(true);
  });

  it('取得に失敗したら、エラーを示して、再試行できる', async () => {
    let failing = true;
    renderApp(
      '/settings/ingestion',
      facilityRoutes({
        'GET /ingestion/facility-logs': () =>
          failing
            ? errorBody(500, 'INTERNAL_ERROR', 'サーバーで問題が発生しました')
            : jsonResponse({ items: [ingestionEntry()], nextCursor: null }),
      }),
      { login: READ_ONLY_LOGIN },
    );
    const panel = await screen.findByTestId('facility-ingestion');
    const retry = await within(panel).findByRole('button', { name: '再読み込み' });

    failing = false;
    fireEvent.click(retry);

    expect((await screen.findAllByTestId('facility-ingestion-row')).length).toBe(1);
  });
});
