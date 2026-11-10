/**
 * 取り込み・連携のハウス別のログ API（Issue #332。ADR-0013。FR-9.8）の結合テスト。
 * 一般ユーザーは、割り当てたハウスの分だけを見る。接続先・認証情報・失敗の理由・全体の件数・キューの件数は、返さない。
 * 全体のログ・設定（管理者向け）は、これまでどおり、取り込みの参照権限（管理者のみ）が必要。
 */

import { describe, expect, it } from 'vitest';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { FACILITY_2_ID, FACILITY_ID, secondHouseSet } from '../support/builders.ts';
import {
  addUserAndLogin,
  errorOf,
  markPasswordChanged,
  withEquipment,
  type TestContext,
} from '../support/test-context.ts';

const at = (minute: number) => `2026-10-09T01:${String(minute).padStart(2, '0')}:00.000Z`;

async function setup() {
  const context = await withEquipment();
  for (const equipment of secondHouseSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  const assigned = await addUserAndLogin(context, { userId: 'assigned', role: 'general' });
  const nobody = await addUserAndLogin(context, { userId: 'nobody', role: 'general' });
  await markPasswordChanged(context, 'assigned');
  await markPasswordChanged(context, 'nobody');
  await context.container.repositories.facilityAccess.save({
    facilityId: FACILITY_ID,
    userIds: [toUserId('assigned')],
  });
  const { ingestion, federation } = context.container.repositories;
  const base = {
    sourceId: 'robot',
    finishedAt: at(1),
    filesProcessed: 2,
    rejectedCount: 1,
    attempts: 3,
    errorMessage: '2件のファイルを取り込めませんでした（内部の理由）',
  };
  await ingestion.addLog({
    ...base,
    logId: 'i-1',
    startedAt: at(1),
    result: 'PARTIAL',
    recordCount: 5,
    facilities: [
      { facilityId: FACILITY_ID, result: 'SUCCESS', recordCount: 2 },
      { facilityId: FACILITY_2_ID, result: 'FAILURE', recordCount: 0 },
    ],
  });
  // ハウスの内訳がないログ（接続の失敗）
  await ingestion.addLog({
    ...base,
    logId: 'i-2',
    startedAt: at(2),
    result: 'FAILURE',
    recordCount: 0,
  });
  await federation.addLog({
    logId: 'f-1',
    occurredAt: at(1),
    result: 'FAILED',
    itemCount: 5,
    message: '農業情報基盤への連携に失敗しました',
    facilities: [
      { facilityId: FACILITY_ID, itemCount: 3 },
      { facilityId: FACILITY_2_ID, itemCount: 2 },
    ],
  });
  await federation.addLog({ logId: 'f-2', occurredAt: at(2), result: 'SENT', itemCount: 1 });
  return { context, assigned, nobody };
}

const get = (context: TestContext, path: string, token?: string) =>
  context.request(path, token === undefined ? {} : { token });

interface Entry {
  logId: string;
  facilityId: string;
}

async function entries(response: Response): Promise<Entry[]> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: Entry[] }).items;
}

describe('GET /ingestion/facility-logs（ハウス別の取り込みの記録）', () => {
  it('一般ユーザーには、割り当てたハウスの分だけを返す。範囲外のハウス・ハウスの内訳がないログは、含めない', async () => {
    const { context, assigned } = await setup();

    const items = await entries(await get(context, '/ingestion/facility-logs', assigned));

    expect(items).toEqual([
      {
        logId: 'i-1',
        facilityId: FACILITY_ID,
        sourceId: 'robot',
        occurredAt: at(1),
        result: 'SUCCESS',
        recordCount: 2,
      },
    ]);
  });

  it('接続先・失敗の理由・全体の件数・再試行の回数などは、返さない', async () => {
    const { context, assigned } = await setup();

    const body = await (await get(context, '/ingestion/facility-logs', assigned)).text();

    for (const hidden of [
      'errorMessage',
      '内部の理由',
      'attempts',
      'filesProcessed',
      'rejectedCount',
    ]) {
      expect(body).not.toContain(hidden);
    }
    expect(body).not.toContain(FACILITY_2_ID);
  });

  it('割り当てがない一般ユーザーには、何も返さない', async () => {
    const { context, nobody } = await setup();

    expect(await entries(await get(context, '/ingestion/facility-logs', nobody))).toEqual([]);
  });

  it('管理者には、すべてのハウスの分を、新しい順に返す', async () => {
    const { context } = await setup();

    const items = await entries(await get(context, '/ingestion/facility-logs'));

    expect(items.map((item) => item.facilityId).sort()).toEqual(
      [FACILITY_ID, FACILITY_2_ID].sort(),
    );
  });

  it('割り当ての変更は、すぐに反映される', async () => {
    const { context, assigned } = await setup();
    await context.container.repositories.facilityAccess.save({
      facilityId: FACILITY_2_ID,
      userIds: [toUserId('assigned')],
    });

    const items = await entries(await get(context, '/ingestion/facility-logs', assigned));

    expect(items.map((item) => item.facilityId).sort()).toEqual(
      [FACILITY_ID, FACILITY_2_ID].sort(),
    );
  });

  it('limit と cursor で、続きを取れる', async () => {
    const { context } = await setup();

    const first = (await (await get(context, '/ingestion/facility-logs?limit=1')).json()) as {
      items: Entry[];
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await get(
        context,
        `/ingestion/facility-logs?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      )
    ).json()) as { items: Entry[]; nextCursor: string | null };

    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.facilityId).not.toBe(first.items[0]?.facilityId);
  });

  it('ログインしていなければ、拒否する', async () => {
    const { context } = await setup();

    const response = await context.request('/ingestion/facility-logs', { token: '' });

    expect(response.status).toBe(401);
  });
});

describe('GET /federation/facility-logs（ハウス別の連携の記録）', () => {
  it('一般ユーザーには、割り当てたハウスの分だけを返す。失敗の理由・キューの件数は、返さない', async () => {
    const { context, assigned } = await setup();

    const response = await get(context, '/federation/facility-logs', assigned);
    const text = await response.clone().text();
    const body = (await response.json()) as { items: unknown[]; queue?: unknown };

    expect(body.items).toEqual([
      { logId: 'f-1', facilityId: FACILITY_ID, occurredAt: at(1), result: 'FAILED', itemCount: 3 },
    ]);
    expect(body.queue).toBeUndefined();
    expect(text).not.toContain('農業情報基盤');
    expect(text).not.toContain(FACILITY_2_ID);
  });

  it('割り当てがなければ空。管理者には、すべてのハウスの分', async () => {
    const { context, nobody } = await setup();

    expect(await entries(await get(context, '/federation/facility-logs', nobody))).toEqual([]);
    expect(
      (await entries(await get(context, '/federation/facility-logs'))).map(
        (item) => item.facilityId,
      ),
    ).toHaveLength(2);
  });
});

describe('全体のログ・設定（管理者向け）は、一般ユーザーには、これまでどおり使えない', () => {
  it.each(['/ingestion/logs', '/federation/logs', '/ingestion/settings'])(
    '%s は、取り込みの参照権限がなければ 403',
    async (path) => {
      const { context, assigned } = await setup();

      const response = await get(context, path, assigned);

      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe('FORBIDDEN');
    },
  );
});
