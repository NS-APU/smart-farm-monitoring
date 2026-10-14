/**
 * 画面の改善（レビュー V-062・V-153・V-200）の単体テスト。
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/frontend/app.tsx';
import {
  SERVICE_WORKER_READY_TIMEOUT_MS,
  createBrowserPush,
  type BrowserEnvironment,
} from '../../../src/frontend/push/browser-push.ts';
import {
  WORKER_LOGIN,
  createFakeFetch,
  createMemorySession,
  dashboard,
  equipmentTree,
  jsonResponse,
} from '../../support/frontend.ts';
import { noContent, renderApp, withBaseRoutes } from '../../support/management-frontend.ts';
import { detail, observationList, series } from '../../support/viewpoint-fixtures.ts';

function firstOf(rows: readonly HTMLElement[]): HTMLElement {
  const first = rows[0];
  if (first === undefined) {
    throw new Error('行がありません');
  }
  return first;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState(null, '', '/');
});

describe('ハウスの削除の確認（V-200）', () => {
  it('配下の設備の名称と件数を示す。ロボット・センサーの削除には、配下の説明を付けない', async () => {
    renderApp('/settings/equipment', {
      'DELETE /equipment/HOUSE-01': () => noContent(),
    });
    const rows = await screen.findAllByTestId('equipment-row');

    fireEvent.click(within(firstOf(rows)).getByRole('button', { name: '削除' }));

    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain('対象: 収穫ロボット1、環境センサー1の2件');
  });

  it('配下の設備がないハウスは、その旨を示す', async () => {
    renderApp('/settings/equipment', {
      'GET /equipment': () =>
        jsonResponse({
          facilities: [{ facility: equipmentTree().facilities[0]?.facility, children: [] }],
        }),
    });
    const rows = await screen.findAllByTestId('equipment-row');

    fireEvent.click(within(firstOf(rows)).getByRole('button', { name: '削除' }));

    expect((await screen.findByTestId('confirm-dialog')).textContent).toContain(
      '配下の設備はありません',
    );
  });
});

describe('推移のグラフの数値の表（V-153）', () => {
  it('グラフの点の値を、見えない表（スクリーンリーダー用）としても提供する。値がない時刻は「—」', async () => {
    window.history.pushState(null, '', '/viewpoints/environmentalAdaptability');
    const routes = withBaseRoutes({
      'GET /equipment': () => jsonResponse(equipmentTree()),
      'GET /dashboard': () => jsonResponse(dashboard()),
      'GET /viewpoints/environmentalAdaptability': () => jsonResponse(detail()),
      'GET /viewpoints/environmentalAdaptability/series': () => jsonResponse(series()),
      'GET /observations': () => jsonResponse(observationList()),
    });
    const { fetchFn } = createFakeFetch(routes);
    render(<App session={createMemorySession(WORKER_LOGIN)} fetchFn={fetchFn} />);

    const table = await screen.findByTestId('trend-table-temperatureCelsius');

    // 表は、見えない枠（div.visually-hidden）の中。表自体に付けると、行がページの下に空白を作る
    expect(table.closest('.visually-hidden')).not.toBeNull();
    expect(table.className).not.toContain('visually-hidden');
    expect(within(table).getByText('温度の推移（数値）')).toBeDefined();
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    expect(within(table).getAllByText('—')).toHaveLength(1);
  });
});

describe('サービスワーカーの準備の待ち時間（V-062）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function environmentWith(ready: Promise<unknown>): BrowserEnvironment {
    return {
      navigator: {
        serviceWorker: { register: () => Promise.resolve({}), ready },
      },
      Notification: { permission: 'default', requestPermission: () => Promise.resolve('granted') },
      PushManager: {},
    } as unknown as BrowserEnvironment;
  }

  it('準備が完了しない（ready が保留のまま）場合は、時間の上限で、エラーにする（画面が止まらない）', async () => {
    vi.useFakeTimers();
    const push = createBrowserPush(environmentWith(new Promise(() => undefined)));

    const result = push.currentEndpoint();
    const expectation =
      expect(result).rejects.toThrow('サービスワーカーの準備が完了しませんでした');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVICE_WORKER_READY_TIMEOUT_MS);
    });

    await expectation;
  });
});
