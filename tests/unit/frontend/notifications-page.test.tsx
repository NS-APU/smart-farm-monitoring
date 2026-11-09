import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import {
  callsOf,
  errorBody,
  noContent,
  notification,
  renderApp,
  type Routes,
} from '../../support/management-frontend.ts';

const FAILURE = notification({
  notificationId: 'n-2' as never,
  kind: 'INGESTION_FAILURE',
  viewpointId: undefined,
  equipmentId: undefined,
  sourceId: 'robot',
  status: undefined,
  message: '【データ取得失敗】ロボットデータ: ファイルサーバーに接続できませんでした',
  readState: 'READ',
});

/** サーバーが通知を読み込んだ時点（一括既読の until に使う。#240）。 */
const AS_OF = '2026-10-09T03:00:00.000Z';

function listOf(items: ReturnType<typeof notification>[], nextCursor: string | null = null) {
  return () => jsonResponse({ items, nextCursor, asOf: AS_OF });
}

/** 一括既読の確認の件数（範囲を指定した未読の件数）。範囲の指定がなければ、ヘッダーの未読数。 */
function unreadCountOf(rangeCount: number, headerCount = 0) {
  return (request: { readonly query: URLSearchParams }) =>
    jsonResponse({ unreadCount: request.query.has('until') ? rangeCount : headerCount });
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('通知一覧（UC-05・UC-22。SC-05）', () => {
  it('通知を、日時・種別・観点・対象・ステータス・メッセージ・既読状態で表示する。対象は、設備の名称・取り込み元の名称で示す', async () => {
    renderApp('/notifications', {
      'GET /notifications': listOf([
        notification(),
        FAILURE,
        notification({
          notificationId: 'n-3' as never,
          kind: 'INGESTION_FAILURE',
          viewpointId: undefined,
          equipmentId: undefined,
          sourceId: 'custom-source',
          status: undefined,
        }),
        notification({
          notificationId: 'n-4' as never,
          kind: 'INGESTION_FAILURE',
          viewpointId: undefined,
          equipmentId: undefined,
          sourceId: undefined,
          status: undefined,
        }),
        notification({ notificationId: 'n-5' as never, equipmentId: 'ROBOT-99' as never }),
      ]),
    });

    const rows = await screen.findAllByTestId('notification-row');

    expect(rows).toHaveLength(5);
    expect(rows[0]?.textContent).toContain('異常検知');
    expect(rows[0]?.textContent).toContain('環境適応性');
    expect(rows[0]?.textContent).toContain('ハウス1');
    expect(rows[0]?.getAttribute('data-read-state')).toBe('UNREAD');
    expect(rows[1]?.textContent).toContain('データ取得失敗');
    expect(rows[1]?.textContent).toContain('ロボットデータ');
    expect(rows[1]?.getAttribute('data-read-state')).toBe('READ');
    // 未知の取り込み元は、識別子のまま。どちらもなければ「—」。設備が階層にない場合は、設備IDのまま
    expect(rows[2]?.textContent).toContain('custom-source');
    expect(rows[3]?.querySelectorAll('td')[3]?.textContent).toBe('—');
    expect(rows[4]?.textContent).toContain('ROBOT-99');
  });

  it('連携の期限切れの通知は、種別「連携の期限切れ」で表示し、種別の絞り込みにも選べる（#204）', async () => {
    renderApp('/notifications', {
      'GET /notifications': listOf([
        notification({
          notificationId: 'n-9' as never,
          kind: 'FEDERATION_EXPIRED',
          viewpointId: undefined,
          equipmentId: undefined,
          sourceId: undefined,
          status: undefined,
          message:
            '【連携の期限切れ】農業情報基盤に 30 日以上送れなかった項目を、破棄しました。連携のログを確認してください',
        }),
      ]),
    });

    const [row] = await screen.findAllByTestId('notification-row');

    expect(row?.textContent).toContain('連携の期限切れ');
    expect(row?.textContent).toContain('連携のログを確認してください');
    const options = [...screen.getByLabelText<HTMLSelectElement>('種別').options].map(
      (option) => option.textContent,
    );
    expect(options).toContain('連携の期限切れ');
  });

  it('各セルに、項目名（data-label）を持つ。狭い画面（900px 以下）では、表を通知ごとのカードにして、項目名を表示するため', async () => {
    renderApp('/notifications', { 'GET /notifications': listOf([notification()]) });

    const [row] = await screen.findAllByTestId('notification-row');

    const labels = [...(row?.querySelectorAll('td') ?? [])].map((cell) =>
      cell.getAttribute('data-label'),
    );
    expect(labels).toEqual(['日時', '種別', '観点', '対象', 'ステータス', 'メッセージ', '状態']);
  });

  it('通知がなければ、その旨を表示する。絞り込み中は、条件に合う通知がない旨を表示する', async () => {
    renderApp('/notifications', { 'GET /notifications': listOf([]) });
    expect(await screen.findByText('通知はありません')).toBeDefined();
  });

  it('絞り込み中で通知がなければ、「条件に合う通知はありません」', async () => {
    renderApp('/notifications?kind=INGESTION_FAILURE&readState=READ', {
      'GET /notifications': listOf([]),
    });
    expect(await screen.findByText('条件に合う通知はありません')).toBeDefined();
  });

  it('種別・既読状態の選択は、URL のクエリと、API のクエリに反映される。不正なクエリの値は、無視する', async () => {
    const { calls } = renderApp('/notifications?kind=UNKNOWN&readState=SOMETHING', {
      'GET /notifications': listOf([notification()]),
    });
    await screen.findAllByTestId('notification-row');
    expect(screen.getByLabelText<HTMLSelectElement>('種別').value).toBe('');
    expect(callsOf(calls, 'GET', '/notifications')[0]?.query.get('kind')).toBeNull();

    fireEvent.change(screen.getByLabelText('種別'), { target: { value: 'STATUS_CHANGE' } });
    fireEvent.change(screen.getByLabelText('既読状態'), { target: { value: 'UNREAD' } });

    await waitFor(() => {
      expect(window.location.search).toContain('kind=STATUS_CHANGE');
      expect(window.location.search).toContain('readState=UNREAD');
    });
    await waitFor(() => {
      const last = callsOf(calls, 'GET', '/notifications').at(-1);
      expect(last?.query.get('kind')).toBe('STATUS_CHANGE');
      expect(last?.query.get('readState')).toBe('UNREAD');
    });
    fireEvent.change(screen.getByLabelText('種別'), { target: { value: '' } });
    await waitFor(() => {
      expect(window.location.search).not.toContain('kind=');
    });
  });

  it('個別に既読にすると、既読にする API を呼び、一覧と、ヘッダーの未読の件数を読み直す', async () => {
    let read = false;
    const { calls } = renderApp('/notifications', {
      'GET /notifications': () =>
        jsonResponse({
          items: [notification({ readState: read ? 'READ' : 'UNREAD' })],
          nextCursor: null,
          asOf: AS_OF,
        }),
      'POST /notifications/n-1/read': () => {
        read = true;
        return noContent();
      },
    });
    const button = await screen.findByRole('button', { name: '既読にする' });
    const unreadCallsBefore = callsOf(calls, 'GET', '/notifications/unread-count').length;

    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '既読にする' })).toBeNull();
    });
    expect(callsOf(calls, 'POST', '/notifications/n-1/read')).toHaveLength(1);
    await waitFor(() => {
      expect(callsOf(calls, 'GET', '/notifications/unread-count').length).toBeGreaterThan(
        unreadCallsBefore,
      );
    });
  });

  it('既読にできなかった場合は、エラーを表示する', async () => {
    renderApp('/notifications', {
      'GET /notifications': listOf([notification()]),
      'POST /notifications/n-1/read': () => errorBody(404, 'NOT_FOUND', '通知が見つかりません'),
    });

    fireEvent.click(await screen.findByRole('button', { name: '既読にする' }));

    expect((await screen.findByRole('alert')).textContent).toBe('通知が見つかりません');
  });

  it('絞り込みの範囲を既読にする: 読み込んだ時点までの範囲の未読の件数を確認してから、条件と時点を指定して API を呼ぶ（D-39）', async () => {
    const { calls } = renderApp('/notifications?kind=STATUS_CHANGE', {
      'GET /notifications': listOf([notification()]),
      'GET /notifications/unread-count': unreadCountOf(2),
      'POST /notifications/read-all': () => jsonResponse({ markedCount: 2 }),
    });
    const button = await screen.findByRole('button', { name: '絞り込みの範囲を既読にする' });

    fireEvent.click(button);

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/未読の通知 2 件を既読にします/)).toBeDefined();
    const countCall = callsOf(calls, 'GET', '/notifications/unread-count').find((call) =>
      call.query.has('until'),
    );
    expect(countCall?.query.get('kind')).toBe('STATUS_CHANGE');
    expect(countCall?.query.get('until')).toBe(AS_OF);
    // 確認するまでは、既読にしない
    expect(callsOf(calls, 'POST', '/notifications/read-all')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: '既読にする' }));

    await waitFor(() => {
      expect(callsOf(calls, 'POST', '/notifications/read-all')).toHaveLength(1);
    });
    expect(callsOf(calls, 'POST', '/notifications/read-all')[0]?.body).toEqual({
      kind: 'STATUS_CHANGE',
      until: AS_OF,
    });
    expect((await screen.findByTestId('notifications-notice')).textContent).toContain(
      '2 件の通知を既読にしました',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('既読状態の絞り込みの範囲も、条件に含めて、既読にする', async () => {
    const { calls } = renderApp('/notifications?readState=UNREAD', {
      'GET /notifications': listOf([notification()]),
      'GET /notifications/unread-count': unreadCountOf(1),
      'POST /notifications/read-all': () => jsonResponse({ markedCount: 1 }),
    });

    fireEvent.click(await screen.findByRole('button', { name: '絞り込みの範囲を既読にする' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '既読にする' }));

    await waitFor(() => {
      expect(callsOf(calls, 'POST', '/notifications/read-all')[0]?.body).toEqual({
        readState: 'UNREAD',
        until: AS_OF,
      });
    });
  });

  it('すべての通知を既読にする: 読み込んだ時点までの未読の件数を確認してから、時点だけを指定して API を呼ぶ。絞り込みがないときは、絞り込みの範囲の操作は選べない', async () => {
    const { calls } = renderApp('/notifications', {
      'GET /notifications': listOf([notification()]),
      'GET /notifications/unread-count': unreadCountOf(5, 7),
      'POST /notifications/read-all': () => jsonResponse({ markedCount: 5 }),
    });
    await screen.findAllByTestId('notification-row');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: '絞り込みの範囲を既読にする' })
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'すべての通知を既読にする' }));

    const dialog = await screen.findByRole('alertdialog');
    // ヘッダーの未読数（7 件）ではなく、読み込んだ時点までの件数（5 件）を示す
    expect(within(dialog).getByText(/未読の通知 5 件を既読にします/)).toBeDefined();
    expect(
      within(dialog).getByText(/読み込んだ時点より後に届いた通知は、既読にしません/),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: '既読にする' }));

    await waitFor(() => {
      expect(callsOf(calls, 'POST', '/notifications/read-all')).toHaveLength(1);
    });
    expect(callsOf(calls, 'POST', '/notifications/read-all')[0]?.body).toEqual({ until: AS_OF });
  });

  it('確認で、やめると、既読にしない（API を呼ばない）', async () => {
    const { calls } = renderApp('/notifications', {
      'GET /notifications': listOf([notification()]),
      'GET /notifications/unread-count': unreadCountOf(3),
      'POST /notifications/read-all': () => jsonResponse({ markedCount: 3 }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'すべての通知を既読にする' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(callsOf(calls, 'POST', '/notifications/read-all')).toHaveLength(0);
    expect(screen.queryByTestId('notifications-notice')).toBeNull();
  });

  it('既読にする未読の通知がない（0 件）ときは、確認せず、その旨を示す（API を呼ばない）', async () => {
    const { calls } = renderApp('/notifications', {
      'GET /notifications': listOf([notification()]),
      'GET /notifications/unread-count': unreadCountOf(0, 4),
      'POST /notifications/read-all': () => jsonResponse({ markedCount: 0 }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'すべての通知を既読にする' }));

    expect((await screen.findByTestId('notifications-notice')).textContent).toContain(
      '既読にする未読の通知はありません',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(callsOf(calls, 'POST', '/notifications/read-all')).toHaveLength(0);
  });

  it('既読の通知だけの範囲（既読状態「既読」の絞り込み）は、件数を問い合わせず、既読にする対象がない旨を示す', async () => {
    const { calls } = renderApp('/notifications?readState=READ', {
      'GET /notifications': listOf([FAILURE]),
      'GET /notifications/unread-count': unreadCountOf(9),
      'POST /notifications/read-all': () => jsonResponse({ markedCount: 0 }),
    });
    await screen.findAllByTestId('notification-row');

    fireEvent.click(screen.getByRole('button', { name: '絞り込みの範囲を既読にする' }));

    expect((await screen.findByTestId('notifications-notice')).textContent).toContain(
      '既読にする未読の通知はありません',
    );
    expect(
      callsOf(calls, 'GET', '/notifications/unread-count').filter((call) =>
        call.query.has('until'),
      ),
    ).toHaveLength(0);
    expect(callsOf(calls, 'POST', '/notifications/read-all')).toHaveLength(0);
  });

  it('確認したあとに届いた通知を、既読にしない: 確認の件数を数えた時点（読み込んだ時点）を、そのまま実行に使う', async () => {
    let asOf = AS_OF;
    const { calls } = renderApp('/notifications', {
      'GET /notifications': () => jsonResponse({ items: [notification()], nextCursor: null, asOf }),
      'GET /notifications/unread-count': unreadCountOf(2),
      'POST /notifications/read-all': () => jsonResponse({ markedCount: 2 }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'すべての通知を既読にする' }));
    const dialog = await screen.findByRole('alertdialog');
    // ダイアログを開いている間に、画面が読み直されて、読み込んだ時点が進んでも、確認した範囲は変わらない
    asOf = '2026-10-09T04:00:00.000Z';
    fireEvent.click(within(dialog).getByRole('button', { name: '既読にする' }));

    await waitFor(() => {
      expect(callsOf(calls, 'POST', '/notifications/read-all')[0]?.body).toEqual({ until: AS_OF });
    });
  });

  it('件数の確認に失敗した場合は、エラーを表示し、確認を開かない', async () => {
    renderApp('/notifications', {
      'GET /notifications': listOf([notification()]),
      'GET /notifications/unread-count': (request) =>
        request.query.has('until')
          ? errorBody(500, 'INTERNAL_ERROR', 'サーバーでエラーが発生しました')
          : jsonResponse({ unreadCount: 0 }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'すべての通知を既読にする' }));

    expect((await screen.findByRole('alert')).textContent).toBe('サーバーでエラーが発生しました');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('一括の既読に失敗した場合は、エラーを表示する', async () => {
    renderApp('/notifications', {
      'GET /notifications': listOf([notification()]),
      'GET /notifications/unread-count': unreadCountOf(1),
      'POST /notifications/read-all': () =>
        errorBody(500, 'INTERNAL_ERROR', 'サーバーでエラーが発生しました'),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'すべての通知を既読にする' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '既読にする' }));

    expect((await screen.findByRole('alert')).textContent).toBe('サーバーでエラーが発生しました');
  });

  it('異常検知の通知から観点の詳細を開くと、対象の設備を選び、未読の通知を既読にする', async () => {
    const { calls } = renderApp('/notifications', {
      'GET /notifications': listOf([notification({ equipmentId: 'ROBOT-01' as never })]),
      'POST /notifications/n-1/read': () => noContent(),
    });

    fireEvent.click(await screen.findByRole('link', { name: '詳細を確認' }));

    await waitFor(() => {
      expect(callsOf(calls, 'POST', '/notifications/n-1/read')).toHaveLength(1);
    });
    expect(window.location.pathname).toBe('/viewpoints/environmentalAdaptability');
  });

  it('既読の通知から詳細を開いても、既読にする API は呼ばない', async () => {
    const { calls } = renderApp('/notifications', {
      'GET /notifications': listOf([
        notification({ notificationId: 'n-6' as never, readState: 'READ', equipmentId: undefined }),
      ]),
    });

    fireEvent.click(await screen.findByRole('link', { name: '詳細を確認' }));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/viewpoints/environmentalAdaptability');
    });
    expect(callsOf(calls, 'POST', '/notifications/n-6/read')).toHaveLength(0);
  });

  it('取り込み失敗の通知からは、取り込みの状況へ移る。既読にできなくても、移動は妨げない', async () => {
    renderApp('/notifications', {
      'GET /notifications': listOf([{ ...FAILURE, readState: 'UNREAD' }]),
      'POST /notifications/n-2/read': () => errorBody(500, 'INTERNAL_ERROR', 'エラー'),
    });

    fireEvent.click(await screen.findByRole('link', { name: '取り込みの状況を確認' }));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/settings/ingestion');
    });
  });

  it('ページ分割: 次のページ・前のページへ移動し、カーソルを使う', async () => {
    const { calls } = renderApp('/notifications', {
      'GET /notifications': (request) =>
        request.query.get('cursor') === 'c-2'
          ? jsonResponse({ items: [FAILURE], nextCursor: null, asOf: AS_OF })
          : jsonResponse({ items: [notification()], nextCursor: 'c-2', asOf: AS_OF }),
    });
    await screen.findAllByTestId('notification-row');

    fireEvent.click(screen.getByRole('button', { name: '次へ' }));

    await waitFor(() => {
      expect(screen.getByTestId('pager-page').textContent).toBe('2');
    });
    expect(callsOf(calls, 'GET', '/notifications').at(-1)?.query.get('cursor')).toBe('c-2');
    fireEvent.click(screen.getByRole('button', { name: '前へ' }));
    await waitFor(() => {
      expect(screen.getByTestId('pager-page').textContent).toBe('1');
    });
  });

  it('一覧の取得に失敗した場合は、エラーを表示し、再読み込みできる', async () => {
    let failing = true;
    renderApp('/notifications', {
      'GET /notifications': () =>
        failing
          ? errorBody(500, 'INTERNAL_ERROR', '一覧を取得できません')
          : jsonResponse({ items: [notification()], nextCursor: null, asOf: AS_OF }),
    });
    expect((await screen.findByRole('alert')).textContent).toContain('一覧を取得できません');

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));

    expect(await screen.findAllByTestId('notification-row')).toHaveLength(1);
  });

  it('読み込み中は、その旨を表示する', async () => {
    const routes: Routes = { 'GET /notifications': () => new Promise<Response>(() => undefined) };
    renderApp('/notifications', routes);

    expect(
      (await screen.findAllByRole('status')).some((node) => node.textContent === '読み込み中…'),
    ).toBe(true);
    expect(within(document.body).queryAllByTestId('notification-row')).toHaveLength(0);
  });
});
