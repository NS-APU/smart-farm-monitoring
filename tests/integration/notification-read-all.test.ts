/**
 * 一括既読（Issue #240。ADR-0019 の D-39）の結合テスト（API）。
 * 一括既読は、画面に読み込んだ時点（`until`）までに届いた通知だけを対象にし、件数つきの確認ができる。
 * その後に届いた通知は、未読のまま残る。
 */

import { describe, expect, it } from 'vitest';
import { NotificationListResponseSchema } from '@smart-farm/shared/schemas/notification';
import {
  addUserAndLogin,
  createTestContext,
  errorOf,
  TEST_NOW,
  type TestContext,
} from '../support/test-context.ts';

const MINUTE_MS = 60_000;
const at = (minutes: number): string =>
  new Date(TEST_NOW.getTime() + minutes * MINUTE_MS).toISOString();

function send(context: TestContext, method: string, path: string, body?: unknown, token?: string) {
  return context.request(path, {
    method,
    ...(body === undefined ? {} : { body }),
    ...(token === undefined ? {} : { token }),
  });
}

/**
 * 通知を 4 件作る: 0 分後（取り込み失敗・robot）・10 分後（取り込み失敗・environment-sensor）・
 * 20 分後（連携の期限切れ）・30 分後（取り込み失敗・robot-2）。
 */
async function withNotifications(): Promise<TestContext> {
  const context = await createTestContext();
  const service = context.container.notificationService;
  await service.notifyIngestionFailure({ sourceId: 'robot', sourceName: 'ロボット', reason: 'x' });
  context.clock.advance(10 * MINUTE_MS);
  await service.notifyIngestionFailure({
    sourceId: 'environment-sensor',
    sourceName: '環境センサー',
    reason: 'x',
  });
  context.clock.advance(10 * MINUTE_MS);
  await service.notifyFederationExpired({ expiryDays: 30 });
  context.clock.advance(10 * MINUTE_MS);
  await service.notifyIngestionFailure({
    sourceId: 'robot-2',
    sourceName: 'ロボット 2',
    reason: 'x',
  });
  return context;
}

const unreadTotal = async (context: TestContext, token?: string) =>
  (
    (await (
      await send(context, 'GET', '/notifications/unread-count', undefined, token)
    ).json()) as {
      unreadCount: number;
    }
  ).unreadCount;

describe('通知一覧の応答: 読み込んだ時点（asOf）', () => {
  it('通知一覧は、サーバーが読み込んだ時点（asOf）を返す。画面は、この時点までを一括既読の対象にする', async () => {
    const context = await withNotifications();

    const list = NotificationListResponseSchema.parse(
      await (await send(context, 'GET', '/notifications')).json(),
    );

    expect(list.asOf).toBe(at(30));
  });
});

describe('POST /notifications/read-all: 読み込んだ時点（until）までの未読だけを既読にし、件数を返す', () => {
  it('until 以前（ちょうどを含む）の未読だけを既読にして、件数（markedCount）を返す。あとに届いた通知は、未読のまま', async () => {
    const context = await withNotifications();

    const response = await send(context, 'POST', '/notifications/read-all', { until: at(20) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ markedCount: 3 });
    expect(await unreadTotal(context)).toBe(1);
    const unread = NotificationListResponseSchema.parse(
      await (await send(context, 'GET', '/notifications?readState=UNREAD')).json(),
    );
    expect(unread.items.map((item) => item.createdAt)).toEqual([at(30)]);
  });

  it('種別で絞り込める。絞り込みの範囲外は、未読のまま。同じ範囲をもう一度実行しても、0 件', async () => {
    const context = await withNotifications();

    const first = await send(context, 'POST', '/notifications/read-all', {
      kind: 'INGESTION_FAILURE',
      until: at(30),
    });
    const again = await send(context, 'POST', '/notifications/read-all', {
      kind: 'INGESTION_FAILURE',
      until: at(30),
    });

    expect(await first.json()).toEqual({ markedCount: 3 });
    expect(await again.json()).toEqual({ markedCount: 0 });
    expect(await unreadTotal(context)).toBe(1);
  });

  it('既読の通知だけの範囲（readState=READ）は、0 件。未読の指定（UNREAD）は、未指定と同じ', async () => {
    const context = await withNotifications();

    const read = await send(context, 'POST', '/notifications/read-all', {
      readState: 'READ',
      until: at(30),
    });
    const unread = await send(context, 'POST', '/notifications/read-all', {
      readState: 'UNREAD',
      until: at(30),
    });

    expect(await read.json()).toEqual({ markedCount: 0 });
    expect(await unread.json()).toEqual({ markedCount: 4 });
  });

  it('既読は、利用者ごと。ほかの利用者の未読は、変わらない', async () => {
    const context = await withNotifications();
    const other = await addUserAndLogin(context, { userId: 'worker-b', role: 'admin' });

    await send(context, 'POST', '/notifications/read-all', { until: at(30) });

    expect(await unreadTotal(context)).toBe(0);
    expect(await unreadTotal(context, other)).toBe(4);
  });

  it.each([
    ['until がない（空の本文）', {}],
    ['until がない（種別だけ）', { kind: 'INGESTION_FAILURE' }],
    ['until が日時でない', { until: 'きのう' }],
    ['種別が不正', { kind: 'OTHER', until: '2026-10-09T01:00:00.000Z' }],
  ])('不正な入力（%s）は、400。既読にしない', async (_name, body) => {
    const context = await withNotifications();

    const response = await send(context, 'POST', '/notifications/read-all', body);

    expect(response.status).toBe(400);
    expect(await unreadTotal(context)).toBe(4);
  });

  it('本文がなければ、400（until が必須。画面を開いたあとに届いた通知まで、既読にしてしまうのを避ける）', async () => {
    const context = await withNotifications();

    const response = await send(context, 'POST', '/notifications/read-all');

    expect(response.status).toBe(400);
    expect(await unreadTotal(context)).toBe(4);
  });

  it('until がない入力は、項目名（until）を示して 400', async () => {
    const context = await withNotifications();

    const response = await send(context, 'POST', '/notifications/read-all', {});

    expect((await errorOf(response)).fields?.map((field) => field.name)).toContain('until');
  });
});

describe('GET /notifications/unread-count: 範囲の未読件数（確認ダイアログの件数）', () => {
  it('指定がなければ、すべての未読の件数（ヘッダーの未読数）', async () => {
    const context = await withNotifications();

    expect(await unreadTotal(context)).toBe(4);
  });

  it('until・種別を指定すると、その範囲の未読の件数。一括既読が既読にする件数と一致する', async () => {
    const context = await withNotifications();
    const count = async (query: string) =>
      (
        (await (await send(context, 'GET', `/notifications/unread-count${query}`)).json()) as {
          unreadCount: number;
        }
      ).unreadCount;

    expect(await count(`?until=${encodeURIComponent(at(10))}`)).toBe(2);
    expect(await count(`?until=${encodeURIComponent(at(30))}&kind=FEDERATION_EXPIRED`)).toBe(1);
    expect(await count('?kind=INGESTION_FAILURE')).toBe(3);
    const marked = await send(context, 'POST', '/notifications/read-all', { until: at(10) });
    expect(await marked.json()).toEqual({ markedCount: 2 });
    expect(await count(`?until=${encodeURIComponent(at(10))}`)).toBe(0);
  });

  it.each(['?kind=OTHER', '?until=きのう'])('不正なクエリ（%s）は、400', async (query) => {
    const context = await withNotifications();

    expect((await send(context, 'GET', `/notifications/unread-count${query}`)).status).toBe(400);
  });
});
