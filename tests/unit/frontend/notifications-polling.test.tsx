/**
 * 通知一覧（SC-05）の、約 10 秒の再取得と、新着の扱い（Issue #159 の SC-05-10）の単体テスト。
 * - 再現の確認: 再取得で、新しい通知が先頭に入ると、操作中の行が下へずれる（修正前の動作）。
 *   開いている「経過・メモ」の欄・入力途中のメモは、行が同じ通知のまま保たれるため、閉じない・失われない
 * - 修正後: 一覧は、自動では行を足さず、「新着あり（N 件）」を示す。押すと、新着を含めて更新する。既存の行の内容（既読・メモの件数）は、その場で更新する
 * 時間は、フェイクタイマーで進める。データはすべて合成データ。
 */

import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationItem } from '../../../src/shared/schemas/notification.ts';
import { POLLING_INTERVAL_MS } from '../../../src/frontend/hooks/use-polling.ts';
import { must } from '../../support/builders.ts';
import { jsonResponse } from '../../support/frontend.ts';
import { callsOf, noContent, notification, renderApp } from '../../support/management-frontend.ts';

const AS_OF = '2026-10-09T03:00:00.000Z';

const N1 = notification({ notificationId: 'n-1' as never, message: '【異常】通知1' });
const N2 = notification({ notificationId: 'n-2' as never, message: '【異常】通知2' });
const NEW_ONE = notification({
  notificationId: 'n-0' as never,
  message: '【異常】新着の通知',
  createdAt: '2026-10-09T02:30:00.000Z',
});

/** 取得のたびに、そのときの一覧（`current.items`）を返す。 */
function liveList(current: { items: NotificationItem[]; asOf?: string }) {
  return () =>
    jsonResponse({ items: current.items, nextCursor: null, asOf: current.asOf ?? AS_OF });
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function messages(): string[] {
  return screen
    .getAllByTestId('notification-row')
    .map((row) => row.querySelector('.notification-message p')?.textContent ?? '');
}

function newArrivalsButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: /^新着あり（/ });
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('通知一覧の再取得（SC-05-10）', () => {
  it('再取得で、新しい通知が届いても、表示中の行は動かず、「新着あり（N 件）」を示す。押すと、新着を先頭に加えて更新する', async () => {
    const current = { items: [N1, N2] };
    renderApp('/notifications', { 'GET /notifications': liveList(current) });
    await flush();
    expect(messages()).toEqual(['【異常】通知1', '【異常】通知2']);
    expect(newArrivalsButton()).toBeNull();

    current.items = [NEW_ONE, N1, N2];
    await flush(POLLING_INTERVAL_MS);

    // 行は、ずれない（先頭に、新しい行が入らない）
    expect(messages()).toEqual(['【異常】通知1', '【異常】通知2']);
    const button = newArrivalsButton();
    expect(button?.textContent).toBe('新着あり（1 件）。押すと更新します');

    fireEvent.click(must(button ?? undefined));

    expect(messages()).toEqual(['【異常】新着の通知', '【異常】通知1', '【異常】通知2']);
    expect(newArrivalsButton()).toBeNull();
  });

  it('新着の件数は、再取得のたびに数え直す（1 件 → 2 件）', async () => {
    const second = notification({ notificationId: 'n--1' as never, message: '【異常】新着2' });
    const current = { items: [N1, N2] };
    renderApp('/notifications', { 'GET /notifications': liveList(current) });
    await flush();

    current.items = [NEW_ONE, N1, N2];
    await flush(POLLING_INTERVAL_MS);
    expect(newArrivalsButton()?.textContent).toBe('新着あり（1 件）。押すと更新します');

    current.items = [second, NEW_ONE, N1, N2];
    await flush(POLLING_INTERVAL_MS);
    expect(newArrivalsButton()?.textContent).toBe('新着あり（2 件）。押すと更新します');
    expect(messages()).toEqual(['【異常】通知1', '【異常】通知2']);
  });

  it('開いている「経過・メモ」の欄と、入力途中のメモは、再取得で、閉じない・失われない（行が、同じ通知のまま保たれる）', async () => {
    const current = { items: [N1, N2] };
    renderApp('/notifications', {
      'GET /notifications': liveList(current),
      'GET /notifications/n-2/memos': () => jsonResponse({ items: [] }),
    });
    await flush();
    const row = must(screen.getAllByTestId('notification-row')[1]);
    const details = within(row).getByTestId<HTMLDetailsElement>('notification-details');
    fireEvent.click(within(details).getByText(/メモ（\d+ 件）/));
    await flush();
    const input = within(details).getByLabelText<HTMLTextAreaElement>('メモ');
    fireEvent.change(input, { target: { value: '入力の途中' } });

    current.items = [NEW_ONE, N1, N2];
    await flush(POLLING_INTERVAL_MS);

    const same = must(screen.getAllByTestId('notification-row')[1]);
    expect(same).toBe(row);
    expect(within(same).getByTestId<HTMLDetailsElement>('notification-details').open).toBe(true);
    expect(within(same).getByLabelText<HTMLTextAreaElement>('メモ').value).toBe('入力の途中');
  });

  it('表示中の通知の内容（既読・メモの件数）は、再取得で、その場で更新する（行の位置は、動かさない）', async () => {
    const current = { items: [N1, N2] };
    renderApp('/notifications', { 'GET /notifications': liveList(current) });
    await flush();
    const rows = screen.getAllByTestId('notification-row');
    expect(rows[1]?.getAttribute('data-read-state')).toBe('UNREAD');

    current.items = [N1, { ...N2, readState: 'READ', memoCount: 3 }];
    await flush(POLLING_INTERVAL_MS);

    const updated = must(screen.getAllByTestId('notification-row')[1]);
    expect(updated.getAttribute('data-read-state')).toBe('READ');
    expect(updated.textContent).toContain('メモ（3 件）');
    expect(newArrivalsButton()).toBeNull();
  });

  it('自分の操作（個別の既読）のあとは、新着を含めて、一覧を更新する', async () => {
    const current = { items: [N1, N2] };
    renderApp('/notifications', {
      'GET /notifications': liveList(current),
      'POST /notifications/n-1/read': () => noContent(),
    });
    await flush();
    current.items = [NEW_ONE, N1, N2];
    await flush(POLLING_INTERVAL_MS);
    expect(newArrivalsButton()).not.toBeNull();

    current.items = [NEW_ONE, { ...N1, readState: 'READ' }, N2];
    const row = must(screen.getAllByTestId('notification-row')[0]);
    fireEvent.click(within(row).getByRole('button', { name: '既読にする' }));
    await flush();

    expect(messages()).toEqual(['【異常】新着の通知', '【異常】通知1', '【異常】通知2']);
    expect(newArrivalsButton()).toBeNull();
  });

  it('絞り込みを変えると、新しい条件の一覧を、そのまま示す（「新着あり」は、出さない）', async () => {
    const current = { items: [N1, N2] };
    const { calls } = renderApp('/notifications', {
      'GET /notifications': (request) =>
        request.query.get('kind') === 'STATUS_CHANGE'
          ? jsonResponse({ items: [NEW_ONE, N1], nextCursor: null, asOf: AS_OF })
          : liveList(current)(),
    });
    await flush();

    fireEvent.change(screen.getByLabelText('種別'), { target: { value: 'STATUS_CHANGE' } });
    await flush();

    expect(messages()).toEqual(['【異常】新着の通知', '【異常】通知1']);
    expect(newArrivalsButton()).toBeNull();
    expect(callsOf(calls, 'GET', '/notifications').at(-1)?.query.get('kind')).toBe('STATUS_CHANGE');
  });
});
