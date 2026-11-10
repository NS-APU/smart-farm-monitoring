/**
 * 通知の閲覧範囲（ハウス）による絞り込みの結合テスト（Issue #331。ADR-0013・ADR-0019 の D-41。FR-9.8）。
 * 通知は、その設備（ハウス）を閲覧できる利用者にだけ、配信（Web Push）・表示（一覧・未読の件数・既読・一括既読・メモ）する。
 * 一般ユーザーは、割り当てたハウスの通知だけ。管理者（全設備を閲覧する権限）は、すべて。ハウスに属さない通知
 * （取り込みの失敗・取得停止・連携の期限切れ）は、管理者のみ。範囲外の通知は、存在しないもの（404）として扱う。
 */

import { describe, expect, it } from 'vitest';
import { NotificationListResponseSchema } from '@smart-farm/shared/schemas/notification';
import { toUserId } from '@smart-farm/shared/schemas/common';
import {
  FACILITY_2_ID,
  FACILITY_ID,
  ROBOT_2_ID,
  ROBOT_ID,
  secondHouseSet,
  SENSOR_2_ID,
} from '../support/builders.ts';
import {
  addUserAndLogin,
  errorOf,
  markPasswordChanged,
  withEquipment,
  type TestContext,
} from '../support/test-context.ts';
import type {
  WebPushRequest,
  WebPushSender,
} from '../../src/backend/infrastructure/web-push/web-push-notifier.ts';

const VAPID_ENV = {
  WEB_PUSH_DELIVERY: 'vapid',
  WEB_PUSH_PUBLIC_KEY: 'dummy-vapid-public-key',
  WEB_PUSH_SUBJECT: 'https://monitoring.example.test/',
};
const KEYS = { p256dh: 'dummy_p256dh-key', auth: 'dummy_auth-secret' };

async function setup(options: { sender?: WebPushSender } = {}) {
  const context = await withEquipment({
    ...(options.sender === undefined ? {} : { env: VAPID_ENV, webPushSender: options.sender }),
  });
  for (const equipment of secondHouseSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  if (options.sender !== undefined) {
    await context.container.secrets.set('web-push/vapid-private-key', 'dummy-vapid-private-key');
  }
  const tokens = {
    house1: await addUserAndLogin(context, { userId: 'general-1', role: 'general' }),
    house2: await addUserAndLogin(context, { userId: 'general-2', role: 'general' }),
    nobody: await addUserAndLogin(context, { userId: 'general-3', role: 'general' }),
  };
  for (const userId of ['general-1', 'general-2', 'general-3']) {
    await markPasswordChanged(context, userId);
  }
  await context.container.repositories.facilityAccess.save({
    facilityId: FACILITY_ID,
    userIds: [toUserId('general-1')],
  });
  await context.container.repositories.facilityAccess.save({
    facilityId: FACILITY_2_ID,
    userIds: [toUserId('general-2')],
  });
  return { context, tokens };
}

/** 状態変化の通知を作る（設備を指定）。通知の識別子を返す。 */
async function notifyStatus(context: TestContext, equipmentId: string, viewpointId = 'safety') {
  const equipment = await context.container.repositories.equipment.get(equipmentId as never);
  if (equipment === undefined) {
    throw new Error('テストの前提: 設備がある');
  }
  const created = await context.container.notificationService.notifyStatusChange({
    equipment,
    viewpointId: viewpointId as never,
    status: 'ERROR',
    diagnosticMessage: `診断 ${equipmentId}`,
  });
  return created.notificationId;
}

async function seedNotifications(context: TestContext) {
  context.clock.advance(60_000);
  const house1 = await notifyStatus(context, FACILITY_ID);
  context.clock.advance(60_000);
  const robot1 = await notifyStatus(context, ROBOT_ID);
  context.clock.advance(60_000);
  const sensor2 = await notifyStatus(context, SENSOR_2_ID);
  context.clock.advance(60_000);
  const robot2 = await notifyStatus(context, ROBOT_2_ID);
  context.clock.advance(60_000);
  const failure = await context.container.notificationService.notifyIngestionFailure({
    sourceId: 'robot',
    sourceName: 'ロボットデータ',
    reason: '接続できません',
  });
  context.clock.advance(60_000);
  const expired = await context.container.notificationService.notifyFederationExpired({
    expiryDays: 7,
  });
  return {
    house1,
    robot1,
    sensor2,
    robot2,
    failure: failure?.notificationId,
    expired: expired?.notificationId,
  };
}

const idsOf = async (response: Response) => {
  expect(response.status).toBe(200);
  return NotificationListResponseSchema.parse(await response.json()).items.map(
    (item) => item.notificationId,
  );
};
const list = (context: TestContext, token?: string, query = '') =>
  context.request(`/notifications${query}`, token === undefined ? {} : { token });
const unread = async (context: TestContext, token?: string, query = '') =>
  (
    (await (
      await context.request(
        `/notifications/unread-count${query}`,
        token === undefined ? {} : { token },
      )
    ).json()) as { unreadCount: number }
  ).unreadCount;

describe('通知の作成: 閲覧範囲のハウスを、作成時に固定する', () => {
  it('ハウス自身の通知はそのハウス、ロボット・センサーの通知は所属ハウス。ハウスに属さない通知は、なし', async () => {
    const { context } = await setup();
    const ids = await seedNotifications(context);
    const facilityOf = async (id: string | undefined) =>
      (await context.container.repositories.notifications.get(id as never))?.facilityId;

    expect(await facilityOf(ids.house1)).toBe(FACILITY_ID);
    expect(await facilityOf(ids.robot1)).toBe(FACILITY_ID);
    expect(await facilityOf(ids.sensor2)).toBe(FACILITY_2_ID);
    expect(await facilityOf(ids.robot2)).toBe(FACILITY_2_ID);
    expect(await facilityOf(ids.failure)).toBeUndefined();
    expect(await facilityOf(ids.expired)).toBeUndefined();
  });

  it('作成後に、設備が移動・削除されても、通知のハウスは、変わらない', async () => {
    const { context, tokens } = await setup();
    const robot1 = await notifyStatus(context, ROBOT_ID);
    const robot = await context.container.repositories.equipment.get(ROBOT_ID);
    if (robot === undefined) {
      throw new Error('テストの前提: ロボットがある');
    }
    await context.container.repositories.equipment.save({ ...robot, facilityId: FACILITY_2_ID });

    expect(await idsOf(await list(context, tokens.house1))).toEqual([robot1]);
    expect(await idsOf(await list(context, tokens.house2))).toEqual([]);
  });
});

describe('一覧・未読の件数・既読・一括既読', () => {
  it('一覧: 管理者はすべて。一般は、割り当てたハウスの通知だけ。割り当てがなければ空。ハウスに属さない通知は、管理者のみ', async () => {
    const { context, tokens } = await setup();
    const ids = await seedNotifications(context);

    expect((await idsOf(await list(context))).sort()).toEqual(
      [ids.house1, ids.robot1, ids.sensor2, ids.robot2, ids.failure, ids.expired].sort(),
    );
    expect(await idsOf(await list(context, tokens.house1))).toEqual([ids.robot1, ids.house1]);
    expect(await idsOf(await list(context, tokens.house2))).toEqual([ids.robot2, ids.sensor2]);
    expect(await idsOf(await list(context, tokens.nobody))).toEqual([]);
  });

  it('一覧: 種別・既読の絞り込みと、ページ分割（1 件ずつ）でも、範囲外の通知が出ない・漏れない', async () => {
    const { context, tokens } = await setup();
    const ids = await seedNotifications(context);

    expect(await idsOf(await list(context, tokens.house2, '?kind=INGESTION_FAILURE'))).toEqual([]);
    const first = NotificationListResponseSchema.parse(
      await (await list(context, tokens.house1, '?limit=1')).json(),
    );
    const second = NotificationListResponseSchema.parse(
      await (
        await list(context, tokens.house1, `?limit=1&cursor=${first.nextCursor ?? ''}`)
      ).json(),
    );

    expect(first.items.map((item) => item.notificationId)).toEqual([ids.robot1]);
    expect(second.items.map((item) => item.notificationId)).toEqual([ids.house1]);
    expect(second.nextCursor).toBeNull();
  });

  it('未読の件数（ヘッダーの印）: 範囲内だけ。管理者は全部。既読にすると、その利用者の範囲の分が減る。ほかの利用者は、変わらない', async () => {
    const { context, tokens } = await setup();
    const ids = await seedNotifications(context);

    expect([
      await unread(context),
      await unread(context, tokens.house1),
      await unread(context, tokens.house2),
      await unread(context, tokens.nobody),
    ]).toEqual([6, 2, 2, 0]);

    const read = await context.request(`/notifications/${ids.robot1}/read`, {
      method: 'POST',
      token: tokens.house1,
    });

    expect(read.status).toBe(204);
    expect([
      await unread(context, tokens.house1),
      await unread(context, tokens.house2),
      await unread(context),
    ]).toEqual([1, 2, 6]);
  });

  it('割り当てを変えると、未読の件数と一覧に、すぐに反映される', async () => {
    const { context, tokens } = await setup();
    await seedNotifications(context);

    await context.container.repositories.facilityAccess.save({
      facilityId: FACILITY_2_ID,
      userIds: [toUserId('general-1'), toUserId('general-2')],
    });

    expect(await unread(context, tokens.house1)).toBe(4);
    expect((await idsOf(await list(context, tokens.house1))).length).toBe(4);
  });

  it('範囲の未読の件数と一括既読: 範囲内の通知だけが対象で、確認の件数と、既読にする件数が一致する。ほかのハウス・管理者は、変わらない', async () => {
    const { context, tokens } = await setup();
    await seedNotifications(context);
    const until = new Date(context.clock.now().getTime() + 60_000).toISOString();

    const counted = await unread(context, tokens.house1, `?until=${until}`);
    const response = await context.request('/notifications/read-all', {
      method: 'POST',
      token: tokens.house1,
      body: { until },
    });

    expect(counted).toBe(2);
    expect(await response.json()).toEqual({ markedCount: 2 });
    expect(await unread(context, tokens.house1)).toBe(0);
    expect(await unread(context, tokens.house2)).toBe(2);
    expect(await unread(context)).toBe(6);
  });
});

describe('個別の既読・メモ: 範囲外の通知は、存在しないもの（404）', () => {
  it('既読: 範囲外・ハウスなしの通知は 404（既読にならない）。範囲内は 204', async () => {
    const { context, tokens } = await setup();
    const ids = await seedNotifications(context);
    const read = (id: string | undefined, token: string) =>
      context.request(`/notifications/${id}/read`, { method: 'POST', token });

    const outOfScope = await read(ids.robot2, tokens.house1);
    expect(outOfScope.status).toBe(404);
    expect((await errorOf(outOfScope)).code).toBe('NOT_FOUND');
    expect((await read(ids.failure, tokens.house1)).status).toBe(404);
    expect((await read(ids.house1, tokens.nobody)).status).toBe(404);
    expect((await read(ids.house1, tokens.house1)).status).toBe(204);
    expect(await unread(context, tokens.house2)).toBe(2);
  });

  it('メモの読み書き: 範囲外・ハウスなしの通知は 404。範囲内は、読み書きできる（他の一般ユーザーの入力も、範囲内なら読める）', async () => {
    const { context, tokens } = await setup();
    const ids = await seedNotifications(context);
    const post = (id: string | undefined, token: string) =>
      context.request(`/notifications/${id}/memos`, {
        method: 'POST',
        token,
        body: { body: '確認した' },
      });
    const get = (id: string | undefined, token?: string) =>
      context.request(`/notifications/${id}/memos`, token === undefined ? {} : { token });

    expect((await post(ids.robot2, tokens.house1)).status).toBe(404);
    expect((await get(ids.robot2, tokens.house1)).status).toBe(404);
    expect((await post(ids.failure, tokens.house1)).status).toBe(404);
    expect((await post(ids.robot1, tokens.house1)).status).toBe(201);
    expect((await get(ids.robot1, tokens.house1)).status).toBe(200);
    // 管理者は、全部（範囲外の一般ユーザーの目に触れないメモも、読める）
    expect((await get(ids.robot1)).status).toBe(200);
    expect((await get(ids.failure)).status).toBe(200);
  });
});

describe('Web Push の宛先: 通知のハウスを閲覧できる利用者の購読だけ', () => {
  function recordingSender() {
    const requests: WebPushRequest[] = [];
    const send: WebPushSender = (request) => {
      requests.push(request);
      return Promise.resolve({ statusCode: 201 });
    };
    return { requests, send };
  }

  async function subscribeAll(context: TestContext, tokens: Record<string, string | undefined>) {
    for (const [name, token] of Object.entries(tokens)) {
      const response = await context.request('/push-subscription', {
        method: 'PUT',
        body: { endpoint: `https://push.example.test/send/${name}`, keys: KEYS },
        ...(token === undefined ? {} : { token }),
      });
      expect(response.status).toBe(204);
    }
  }
  const endpointsOf = (requests: readonly WebPushRequest[]) =>
    requests.map((request) => request.endpoint.split('/').at(-1)).sort();

  it('ハウスの通知: そのハウスを閲覧できる一般ユーザーと、管理者の購読へ。ほかのハウスの一般ユーザー・割り当てのない利用者へは、送らない', async () => {
    const { send, requests } = recordingSender();
    const { context, tokens } = await setup({ sender: send });
    await subscribeAll(context, {
      admin: undefined,
      house1: tokens.house1,
      house2: tokens.house2,
      nobody: tokens.nobody,
    });
    await notifyStatus(context, ROBOT_ID);

    const summary = await context.container.notificationService.deliverPending();

    expect(endpointsOf(requests)).toEqual(['admin', 'house1']);
    expect(summary).toMatchObject({ delivered: 2, failed: 0 });
  });

  it('ハウスに属さない通知（取り込みの失敗など）: 全設備を閲覧できる利用者（管理者）の購読だけ', async () => {
    const { send, requests } = recordingSender();
    const { context, tokens } = await setup({ sender: send });
    await subscribeAll(context, { admin: undefined, house1: tokens.house1, house2: tokens.house2 });
    await context.container.notificationService.notifyIngestionFailure({
      sourceId: 'robot',
      sourceName: 'ロボットデータ',
      reason: '接続できません',
    });

    await context.container.notificationService.deliverPending();

    expect(endpointsOf(requests)).toEqual(['admin']);
  });

  it('宛先のない通知（購読する資格のある利用者がいない）は、配信の対象が空で、終了する（失敗にしない）', async () => {
    const { send, requests } = recordingSender();
    const { context, tokens } = await setup({ sender: send });
    await subscribeAll(context, { house2: tokens.house2 });
    const id = await notifyStatus(context, ROBOT_ID);

    const summary = await context.container.notificationService.deliverPending();

    expect(requests).toHaveLength(0);
    expect(summary).toMatchObject({ delivered: 0, failed: 0 });
    const stored = await context.container.repositories.notifications.get(id);
    expect(stored?.webPushDeliveries).toEqual([]);
  });

  it('配信の宛先は、最初の配信の時点で決まる（あとで割り当てを変えても、すでに配信した通知の宛先は、変わらない）', async () => {
    const { send, requests } = recordingSender();
    const { context, tokens } = await setup({ sender: send });
    await subscribeAll(context, { house1: tokens.house1, house2: tokens.house2 });
    await notifyStatus(context, ROBOT_ID);
    await context.container.notificationService.deliverPending();

    await context.container.repositories.facilityAccess.save({
      facilityId: FACILITY_ID,
      userIds: [toUserId('general-1'), toUserId('general-2')],
    });
    await context.container.notificationService.deliverPending();

    expect(endpointsOf(requests)).toEqual(['house1']);
  });
});
