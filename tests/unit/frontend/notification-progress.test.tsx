/**
 * 通知一覧（SC-05）の、経過・回復日時・メモ（Issue #159 の SC-05-1。ADR-0019 の D-42）と、種別名（SC-05-2）の単体テスト。
 * データはすべて合成データ。
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  NotificationItem,
  NotificationMemo,
} from '../../../src/shared/schemas/notification.ts';
import { formatElapsed, formatShortDateTimeJst } from '../../../src/frontend/components/format.ts';
import { must } from '../../support/builders.ts';
import { jsonResponse } from '../../support/frontend.ts';
import {
  callsOf,
  errorBody,
  loginWith,
  notification,
  READ_ONLY_LOGIN,
  renderApp,
} from '../../support/management-frontend.ts';

const AS_OF = '2026-10-09T03:00:00.000Z';

/** 通知は、JST 11:00（UTC 02:00）に作られた、異常の通知。 */
function withProgress(
  overrides: Partial<NotificationItem> = {},
  progress: NotificationItem['progress'] = {
    changes: [
      { status: 'ERROR', changedAt: '2026-10-09T02:00:00.000Z' },
      { status: 'NORMAL', changedAt: '2026-10-09T02:20:00.000Z' },
      { status: 'ERROR', changedAt: '2026-10-09T02:40:00.000Z' },
    ],
    recovery: { recoveredAt: '2026-10-09T02:20:00.000Z', elapsedSeconds: 1200 },
  },
): NotificationItem {
  return notification({ progress, ...overrides });
}

function listOf(items: NotificationItem[]) {
  return () => jsonResponse({ items, nextCursor: null, asOf: AS_OF });
}

function memo(overrides: Partial<NotificationMemo> = {}): NotificationMemo {
  return {
    memoId: 'm-1',
    notificationId: 'n-1' as NotificationMemo['notificationId'],
    enteredBy: 'worker-1' as NotificationMemo['enteredBy'],
    body: 'ファイルサーバーを再起動した',
    createdAt: '2026-10-09T02:05:00.000Z',
    ...overrides,
  };
}

async function openDetails(): Promise<HTMLDetailsElement> {
  const details = await screen.findByTestId<HTMLDetailsElement>('notification-details');
  fireEvent.click(within(details).getByText(/メモ（\d+ 件）/));
  return details;
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('通知の種別名（SC-05-2）', () => {
  it('状態変化の通知の種別は「状態の悪化」。種別の絞り込みの選択肢も同じ語で、「異常検知」は使わない', async () => {
    renderApp('/notifications', { 'GET /notifications': listOf([notification()]) });

    const [row] = await screen.findAllByTestId('notification-row');

    expect(row?.querySelectorAll('td')[1]?.textContent).toBe('状態の悪化');
    const options = [...screen.getByLabelText<HTMLSelectElement>('種別').options].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(['すべて', '状態の悪化', 'データ取得失敗', '連携の期限切れ']);
  });
});

describe('通知の経過・回復日時（SC-05-1）', () => {
  it('回復した通知は、経過（異常 → 正常 → 異常）と、回復日時・かかった時間を示す', async () => {
    renderApp('/notifications', { 'GET /notifications': listOf([withProgress()]) });

    const recovery = await screen.findByTestId('notification-recovery');

    expect(recovery.textContent).toBe('11:20 に回復（20 分）');
    expect(screen.getByTestId('notification-progress').textContent).toContain(
      '11:00 異常 → 11:20 正常 → 11:40 異常',
    );
  });

  it('回復していない通知は「未回復」。経過は、通知の時点の状態だけ', async () => {
    renderApp('/notifications', {
      'GET /notifications': listOf([
        withProgress(
          {},
          {
            changes: [{ status: 'CAUTION', changedAt: '2026-10-09T02:00:00.000Z' }],
            recovery: null,
          },
        ),
      ]),
    });

    const recovery = await screen.findByTestId('notification-recovery');

    expect(recovery.textContent).toBe('未回復');
    expect(screen.getByTestId('notification-progress').textContent).toContain('11:00 注意');
    expect(screen.getByTestId('notification-progress').textContent).not.toContain('→');
  });

  it('日付をまたぐ変化は、日付つきで示す（通知と同じ日の時刻は、日付なし）。回復までの時間は、時間・分で示す', async () => {
    renderApp('/notifications', {
      'GET /notifications': listOf([
        withProgress(
          {},
          {
            changes: [
              { status: 'ERROR', changedAt: '2026-10-09T02:00:00.000Z' },
              { status: 'NORMAL', changedAt: '2026-10-09T17:20:00.000Z' },
            ],
            recovery: { recoveredAt: '2026-10-09T17:20:00.000Z', elapsedSeconds: 55_200 },
          },
        ),
      ]),
    });

    const recovery = await screen.findByTestId('notification-recovery');

    expect(recovery.textContent).toBe('10/10 02:20 に回復（15 時間 20 分）');
    expect(screen.getByTestId('notification-progress').textContent).toContain(
      '11:00 異常 → 10/10 02:20 正常',
    );
  });

  it('経過を示せない通知（progress が null）・状態変化ではない通知（progress なし）は、経過・回復を出さない。メモは出す', async () => {
    renderApp('/notifications', {
      'GET /notifications': listOf([
        notification({ notificationId: 'n-1' as never, progress: null }),
        notification({
          notificationId: 'n-2' as never,
          kind: 'INGESTION_FAILURE',
          viewpointId: undefined,
          equipmentId: undefined,
          sourceId: 'robot',
          status: undefined,
          memoCount: 3,
        }),
      ]),
    });

    const rows = await screen.findAllByTestId('notification-row');

    for (const row of rows) {
      expect(within(row).queryByTestId('notification-recovery')).toBeNull();
      expect(within(row).queryByTestId('notification-progress')).toBeNull();
    }
    expect(within(must(rows[0])).getByTestId('notification-details').textContent).toContain(
      'メモ（0 件）',
    );
    expect(within(must(rows[1])).getByTestId('notification-details').textContent).toContain(
      'メモ（3 件）',
    );
  });

  it('推奨アクションは、一覧に出さない（観点の詳細で確認する）', async () => {
    renderApp('/notifications', { 'GET /notifications': listOf([withProgress()]) });

    await screen.findByTestId('notification-recovery');

    expect(document.body.textContent).not.toContain('推奨アクション');
  });
});

describe('通知のメモ（SC-05-1）', () => {
  it('欄の見出しに、メモの件数を示す。開くまで、メモは読み込まない。開くと、入力の古い順に、入力者・日時つきで示す', async () => {
    const { calls } = renderApp('/notifications', {
      'GET /notifications': listOf([withProgress({ memoCount: 2 })]),
      'GET /notifications/n-1/memos': () =>
        jsonResponse({
          items: [
            memo(),
            memo({
              memoId: 'm-2',
              enteredBy: 'worker-2' as never,
              body: '復旧を確認した',
              createdAt: '2026-10-09T02:30:00.000Z',
            }),
          ],
        }),
    });
    const summary = (await screen.findByTestId('notification-details')).querySelector('summary');
    expect(summary?.textContent).toBe('経過・メモ（2 件）');
    expect(callsOf(calls, 'GET', '/notifications/n-1/memos')).toHaveLength(0);

    await openDetails();

    const items = await screen.findAllByTestId('notification-memo');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('ファイルサーバーを再起動した'),
      expect.stringContaining('復旧を確認した'),
    ]);
    expect(items[0]?.textContent).toContain('worker-1');
    expect(items[0]?.textContent).toContain('2026/10/09 11:05:00');
    expect(items[1]?.textContent).toContain('worker-2');
    expect(callsOf(calls, 'GET', '/notifications/n-1/memos')).toHaveLength(1);
  });

  it('メモがなければ、その旨を示す。編集・削除の操作は、ない（追記のみ）', async () => {
    renderApp('/notifications', {
      'GET /notifications': listOf([withProgress()]),
      'GET /notifications/n-1/memos': () => jsonResponse({ items: [] }),
    });

    const details = await openDetails();

    expect((await within(details).findByTestId('notification-memo-empty')).textContent).toBe(
      'メモはありません',
    );
    expect(within(details).queryByRole('button', { name: /編集|削除/ })).toBeNull();
  });

  it('メモを追記すると、本文を送り、結果を示し、入力欄を空にして、一覧を読み直す（メモの件数も更新する）', async () => {
    let memos: NotificationMemo[] = [];
    const { calls } = renderApp('/notifications', {
      'GET /notifications': () =>
        jsonResponse({
          items: [withProgress({ memoCount: memos.length })],
          nextCursor: null,
          asOf: AS_OF,
        }),
      'GET /notifications/n-1/memos': () => jsonResponse({ items: memos }),
      'POST /notifications/n-1/memos': (request) => {
        const created = memo({ body: (request.body as { body: string }).body });
        memos = [...memos, created];
        return jsonResponse(created, 201);
      },
    });
    const details = await openDetails();
    const input = await within(details).findByLabelText('メモ');

    fireEvent.change(input, { target: { value: '  ケーブルを差し直した  ' } });
    fireEvent.click(within(details).getByRole('button', { name: 'メモを追加' }));

    expect((await screen.findByTestId('notification-memo-notice')).textContent).toContain(
      'メモを追加しました',
    );
    expect(callsOf(calls, 'POST', '/notifications/n-1/memos')[0]?.body).toEqual({
      body: 'ケーブルを差し直した',
    });
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect((await within(details).findByTestId('notification-memo')).textContent).toContain(
      'ケーブルを差し直した',
    );
    await waitFor(() => {
      expect(details.querySelector('summary')?.textContent).toBe('経過・メモ（1 件）');
    });
  });

  it('空（空白だけ）のメモは、送らず、入力欄のエラーを示す', async () => {
    const { calls } = renderApp('/notifications', {
      'GET /notifications': listOf([withProgress()]),
      'GET /notifications/n-1/memos': () => jsonResponse({ items: [] }),
    });
    const details = await openDetails();
    const input = await within(details).findByLabelText('メモ');

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(within(details).getByRole('button', { name: 'メモを追加' }));

    expect((await within(details).findByText('メモを入力してください')).textContent).toBe(
      'メモを入力してください',
    );
    expect(callsOf(calls, 'POST', '/notifications/n-1/memos')).toHaveLength(0);
  });

  it('追記に失敗したら、エラーを示す（入力した内容は残す）', async () => {
    renderApp('/notifications', {
      'GET /notifications': listOf([withProgress()]),
      'GET /notifications/n-1/memos': () => jsonResponse({ items: [] }),
      'POST /notifications/n-1/memos': () => errorBody(404, 'NOT_FOUND', '通知が見つかりません'),
    });
    const details = await openDetails();
    const input = await within(details).findByLabelText('メモ');

    fireEvent.change(input, { target: { value: '復旧した' } });
    fireEvent.click(within(details).getByRole('button', { name: 'メモを追加' }));

    expect((await within(details).findByRole('alert')).textContent).toBe('通知が見つかりません');
    expect((input as HTMLTextAreaElement).value).toBe('復旧した');
  });

  it('メモの読み込みに失敗したら、その旨を示す', async () => {
    renderApp('/notifications', {
      'GET /notifications': listOf([withProgress({ memoCount: 1 })]),
      'GET /notifications/n-1/memos': () =>
        errorBody(500, 'INTERNAL', 'サーバーでエラーが発生しました'),
    });

    const details = await openDetails();

    expect((await within(details).findByTestId('notification-memo-error')).textContent).toBe(
      'メモを読み込めませんでした',
    );
  });

  it('手動入力の権限がない利用者は、メモを読めるが、入力できない（入力欄と追加の操作を出さず、その旨を示す）', async () => {
    renderApp(
      '/notifications',
      {
        'GET /notifications': listOf([withProgress({ memoCount: 1 })]),
        'GET /notifications/n-1/memos': () => jsonResponse({ items: [memo()] }),
      },
      { login: READ_ONLY_LOGIN },
    );

    const details = await openDetails();

    expect((await within(details).findByTestId('notification-memo')).textContent).toContain(
      'ファイルサーバーを再起動した',
    );
    expect(within(details).queryByLabelText('メモ')).toBeNull();
    expect(within(details).queryByRole('button', { name: 'メモを追加' })).toBeNull();
    expect(within(details).getByTestId('notification-memo-no-permission').textContent).toBe(
      'メモを入力する権限がありません',
    );
  });

  it('手動入力の権限があれば、入力できる', async () => {
    renderApp(
      '/notifications',
      {
        'GET /notifications': listOf([withProgress()]),
        'GET /notifications/n-1/memos': () => jsonResponse({ items: [] }),
      },
      { login: loginWith(['manual-entry:write']) },
    );

    const details = await openDetails();

    expect(await within(details).findByLabelText('メモ')).not.toBeNull();
  });
});

describe('表示の整形', () => {
  it('formatShortDateTimeJst: 基準の日時と同じ日（日本時間）は時刻だけ、違う日は月/日つき', () => {
    const base = '2026-10-09T02:00:00.000Z';

    expect(formatShortDateTimeJst('2026-10-09T02:20:00.000Z', base)).toBe('11:20');
    // 日本時間の 0 時台は「00:xx」（24 時表記にしない）
    expect(formatShortDateTimeJst('2026-10-09T15:05:00.000Z', base)).toBe('10/10 00:05');
    // 日本時間で同じ日（UTC では前日）
    expect(formatShortDateTimeJst('2026-10-08T15:00:00.000Z', '2026-10-09T10:00:00.000Z')).toBe(
      '00:00',
    );
  });

  it('formatElapsed: 1 分未満・分・時間と分・日と時間', () => {
    expect(formatElapsed(0)).toBe('1 分未満');
    expect(formatElapsed(59)).toBe('1 分未満');
    expect(formatElapsed(60)).toBe('1 分');
    expect(formatElapsed(1200)).toBe('20 分');
    expect(formatElapsed(3600)).toBe('1 時間');
    expect(formatElapsed(5400)).toBe('1 時間 30 分');
    expect(formatElapsed(86_400)).toBe('1 日');
    expect(formatElapsed(90_000)).toBe('1 日 1 時間');
  });
});
