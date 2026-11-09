/**
 * 通知のメモ（Issue #239。ADR-0019 の D-42）の結合テスト（API）。
 * 利用者が、通知にメモ（自由記述）を追記できる。共有（全員が読める）・追記のみ（編集・削除はない）。入力者と日時を持つ。
 * 書ける人は、手動入力ができる人と同じ権限（manual-entry:write）。農業情報基盤には送らない。
 */

import { describe, expect, it } from 'vitest';
import { NotificationMemoSchema } from '@smart-farm/shared/schemas/notification';
import {
  addUserAndLogin,
  createTestContext,
  errorOf,
  TEST_NOW,
  TEST_USER,
  THREE_ROLES_JSON,
  type TestContext,
} from '../support/test-context.ts';

function send(context: TestContext, method: string, path: string, body?: unknown, token?: string) {
  return context.request(path, {
    method,
    ...(body === undefined ? {} : { body }),
    ...(token === undefined ? {} : { token }),
  });
}

const ROLES_ENV = { ROLE_DEFINITIONS_JSON: THREE_ROLES_JSON, INITIAL_USER_ROLE: 'admin' };

/** 通知を 1 件作って（取り込み失敗の通知）、その識別子を返す。 */
async function createNotification(context: TestContext, sourceId = 'robot'): Promise<string> {
  const created = await context.container.notificationService.notifyIngestionFailure({
    sourceId,
    sourceName: 'ロボットデータ',
    reason: '接続できません',
  });
  if (created === null) {
    throw new Error('テストの前提');
  }
  return created.notificationId;
}

async function memosOf(context: TestContext, notificationId: string, token?: string) {
  const response = await send(
    context,
    'GET',
    `/notifications/${notificationId}/memos`,
    undefined,
    token,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: unknown[] }).items;
}

describe('追記・一覧', () => {
  it('通知にメモを追記できる。入力者（ログイン中の利用者）と日時が残る。一覧は、入力の古い順', async () => {
    const context = await createTestContext();
    const id = await createNotification(context);

    const first = await send(context, 'POST', `/notifications/${id}/memos`, {
      body: 'センサーの汚れを清掃して復旧した',
    });
    context.clock.advance(5 * 60_000);
    const second = await send(context, 'POST', `/notifications/${id}/memos`, {
      body: '復旧を確認した',
    });

    expect([first.status, second.status]).toEqual([201, 201]);
    const memo = NotificationMemoSchema.parse(await first.json());
    expect(memo).toMatchObject({
      notificationId: id,
      enteredBy: TEST_USER.userId,
      body: 'センサーの汚れを清掃して復旧した',
      createdAt: TEST_NOW.toISOString(),
    });
    const items = await memosOf(context, id);
    expect(items).toHaveLength(2);
    expect(items.map((item) => (item as { body: string }).body)).toEqual([
      'センサーの汚れを清掃して復旧した',
      '復旧を確認した',
    ]);
  });

  it('本文は、前後の空白を除いて保存する。改行を含められる。2000 文字まで', async () => {
    const context = await createTestContext();
    const id = await createNotification(context);

    const trimmed = await send(context, 'POST', `/notifications/${id}/memos`, {
      body: '  清掃した\n（2 行目）  ',
    });
    const longest = await send(context, 'POST', `/notifications/${id}/memos`, {
      body: 'あ'.repeat(2000),
    });

    expect(trimmed.status).toBe(201);
    expect(NotificationMemoSchema.parse(await trimmed.json()).body).toBe('清掃した\n（2 行目）');
    expect(longest.status).toBe(201);
  });

  it.each([
    ['空', ''],
    ['空白だけ', '  \n  '],
    ['2001 文字（上限の超過）', 'あ'.repeat(2001)],
  ])('不正な本文（%s）は、400。保存しない', async (_name, body) => {
    const context = await createTestContext();
    const id = await createNotification(context);

    const response = await send(context, 'POST', `/notifications/${id}/memos`, { body });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields?.map((field) => field.name)).toContain('body');
    expect(await memosOf(context, id)).toEqual([]);
  });

  it('本文がない・本文の型が違う入力も、400', async () => {
    const context = await createTestContext();
    const id = await createNotification(context);

    expect((await send(context, 'POST', `/notifications/${id}/memos`, {})).status).toBe(400);
    expect((await send(context, 'POST', `/notifications/${id}/memos`, { body: 123 })).status).toBe(
      400,
    );
  });

  it('通知がなければ、追記も一覧も、404', async () => {
    const context = await createTestContext();

    const post = await send(context, 'POST', '/notifications/none/memos', { body: 'メモ' });
    const list = await send(context, 'GET', '/notifications/none/memos');

    expect([post.status, list.status]).toEqual([404, 404]);
  });

  it('メモは、通知ごと。ほかの通知のメモは、混ざらない', async () => {
    const context = await createTestContext();
    const first = await createNotification(context, 'robot');
    context.clock.advance(61 * 60_000);
    const second = await createNotification(context, 'environment-sensor');

    await send(context, 'POST', `/notifications/${first}/memos`, { body: '1 件目のメモ' });
    await send(context, 'POST', `/notifications/${second}/memos`, { body: '2 件目のメモ' });

    expect((await memosOf(context, first)).map((item) => (item as { body: string }).body)).toEqual([
      '1 件目のメモ',
    ]);
    expect((await memosOf(context, second)).map((item) => (item as { body: string }).body)).toEqual(
      ['2 件目のメモ'],
    );
  });
});

describe('共有・追記のみ', () => {
  it('メモは、全員が読める。別の利用者も、追記でき、入力者が分かる', async () => {
    const context = await createTestContext({ env: ROLES_ENV });
    const id = await createNotification(context);
    const evaluator = await addUserAndLogin(context, { userId: 'worker-b', role: 'evaluator' });
    const viewer = await addUserAndLogin(context, { userId: 'viewer-c', role: 'viewer' });

    await send(context, 'POST', `/notifications/${id}/memos`, { body: '管理者のメモ' });
    await send(context, 'POST', `/notifications/${id}/memos`, { body: '評価者のメモ' }, evaluator);

    const seenByViewer = (await memosOf(context, id, viewer)) as { enteredBy: string }[];
    expect(seenByViewer.map((item) => item.enteredBy)).toEqual([TEST_USER.userId, 'worker-b']);
  });

  it('編集・削除の API はない（追記のみ）', async () => {
    const context = await createTestContext();
    const id = await createNotification(context);
    const created = NotificationMemoSchema.parse(
      await (await send(context, 'POST', `/notifications/${id}/memos`, { body: 'メモ' })).json(),
    );

    const update = await send(context, 'PUT', `/notifications/${id}/memos/${created.memoId}`, {
      body: '修正',
    });
    const remove = await send(context, 'DELETE', `/notifications/${id}/memos/${created.memoId}`);

    expect([update.status, remove.status]).toEqual([404, 404]);
    expect(await memosOf(context, id)).toHaveLength(1);
  });
});

describe('権限（手動入力と同じ）', () => {
  it('手動入力ができる権限（manual-entry:write）がなければ、追記は 403。読むのは、ログインしていれば、できる', async () => {
    const context = await createTestContext({ env: ROLES_ENV });
    const id = await createNotification(context);
    const viewer = await addUserAndLogin(context, { userId: 'viewer-c', role: 'viewer' });

    const post = await send(
      context,
      'POST',
      `/notifications/${id}/memos`,
      { body: 'メモ' },
      viewer,
    );
    const list = await send(context, 'GET', `/notifications/${id}/memos`, undefined, viewer);

    expect(post.status).toBe(403);
    expect(list.status).toBe(200);
    expect(await memosOf(context, id)).toEqual([]);
  });

  it('ログインしていなければ、追記も一覧も、401', async () => {
    const context = await createTestContext();
    const id = await createNotification(context);

    const post = await context.app.request(`/api/v1/notifications/${id}/memos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'メモ' }),
    });
    const list = await context.app.request(`/api/v1/notifications/${id}/memos`);

    expect([post.status, list.status]).toEqual([401, 401]);
  });
});

describe('通知一覧のメモの件数', () => {
  it('通知一覧の各項目に、メモの件数（memoCount）を返す。メモがなければ 0', async () => {
    const context = await createTestContext();
    const first = await createNotification(context, 'robot');
    context.clock.advance(61 * 60_000);
    const second = await createNotification(context, 'environment-sensor');
    await send(context, 'POST', `/notifications/${first}/memos`, { body: 'メモ 1' });
    await send(context, 'POST', `/notifications/${first}/memos`, { body: 'メモ 2' });

    const list = (await (await send(context, 'GET', '/notifications')).json()) as {
      items: { notificationId: string; memoCount: number }[];
    };

    expect(list.items.find((item) => item.notificationId === first)?.memoCount).toBe(2);
    expect(list.items.find((item) => item.notificationId === second)?.memoCount).toBe(0);
  });
});

describe('農業情報基盤には送らない', () => {
  it('メモを追記しても、連携キューに積まない', async () => {
    const context = await createTestContext();
    const id = await createNotification(context);
    const waiting = () =>
      context.container.repositories.federation.listDue(new Date('2099-01-01T00:00:00Z'), 1000);
    const before = (await waiting()).length;

    await send(context, 'POST', `/notifications/${id}/memos`, { body: 'メモ' });

    expect((await waiting()).length).toBe(before);
  });
});
