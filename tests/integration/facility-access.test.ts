/**
 * 閲覧の割り当て（ハウスごと）の API の結合テスト（Issue #330。ADR-0013。FR-9.8）。
 * `GET /facility-access`（表: 行がハウス、列が一般ユーザー）・`PUT /facility-access/{facilityId}`（そのハウスを閲覧できるユーザーの置き換え）。
 * 権限は `user:manage`（管理者のみ）。管理者（全設備を閲覧する権限をもつロール）は、割り当ての対象にならない。
 */

import { describe, expect, it } from 'vitest';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import { toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
import {
  FacilityAccessEntrySchema,
  FacilityAccessResponseSchema,
} from '@smart-farm/shared/schemas/facility-access';
import { FACILITY_2_ID, FACILITY_ID, ROBOT_ID, secondHouseSet } from '../support/builders.ts';
import {
  addUserAndLogin,
  errorOf,
  markPasswordChanged,
  TEST_USER,
  withEquipment,
  type TestContext,
} from '../support/test-context.ts';

async function setup() {
  const context = await withEquipment();
  for (const equipment of secondHouseSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  const tokens = {
    one: await addUserAndLogin(context, { userId: 'general-1', role: 'general' }),
    two: await addUserAndLogin(context, { userId: 'general-2', role: 'general' }),
  };
  await markPasswordChanged(context, 'general-1');
  await markPasswordChanged(context, 'general-2');
  return { context, tokens };
}

function put(context: TestContext, facilityId: string, body: unknown, token?: string) {
  return context.request(`/facility-access/${facilityId}`, {
    method: 'PUT',
    body,
    ...(token === undefined ? {} : { token }),
  });
}

async function table(context: TestContext) {
  return FacilityAccessResponseSchema.parse(
    await (await context.request('/facility-access')).json(),
  );
}

describe('閲覧の割り当ての表（GET /facility-access）', () => {
  it('行は、ハウス（作成の順）と、閲覧できるユーザー。列は、一般ユーザー（管理者は、対象外のため、含めない）', async () => {
    const { context } = await setup();

    const body = await table(context);

    expect(body.facilities).toEqual([
      { facilityId: FACILITY_ID, name: 'テストハウス', userIds: [] },
      { facilityId: FACILITY_2_ID, name: 'テストハウス2', userIds: [] },
    ]);
    expect(body.users.map((user) => user.userId)).toEqual(['general-1', 'general-2']);
    expect(body.users[0]).toEqual({ userId: 'general-1', userName: 'general-1' });
    expect(JSON.stringify(body)).not.toContain(TEST_USER.userId);
  });

  it('割り当てたユーザーを返す。削除済みのハウスは、行に出さない。存在しない・管理者に変わったユーザーは、返さない', async () => {
    const { context } = await setup();
    const repositories = context.container.repositories;
    await repositories.facilityAccess.save({
      facilityId: FACILITY_ID,
      userIds: [
        toUserId('general-2'),
        toUserId('general-1'),
        toUserId('gone-user'),
        toUserId(TEST_USER.userId),
      ],
    });
    const second = await repositories.equipment.get(FACILITY_2_ID);
    if (second === undefined) {
      throw new Error('テストの前提: ハウスがある');
    }
    await repositories.equipment.save({ ...second, isDeleted: true });

    const body = await table(context);

    expect(body.facilities).toEqual([
      { facilityId: FACILITY_ID, name: 'テストハウス', userIds: ['general-1', 'general-2'] },
    ]);
  });

  it('管理者以外（ユーザー管理の権限がない利用者）は、見られない（403）', async () => {
    const { context, tokens } = await setup();

    const response = await context.request('/facility-access', { token: tokens.one });

    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('FORBIDDEN');
  });
});

describe('閲覧の割り当ての変更（PUT /facility-access/{facilityId}）', () => {
  it('そのハウスを閲覧できるユーザーを、置き換える（重複は、まとめる）。応答は、変更後の行。すぐに反映される', async () => {
    const { context, tokens } = await setup();

    const response = await put(context, FACILITY_ID, {
      userIds: ['general-1', 'general-1', 'general-2'],
    });

    expect(response.status).toBe(200);
    expect(FacilityAccessEntrySchema.parse(await response.json())).toEqual({
      facilityId: FACILITY_ID,
      name: 'テストハウス',
      userIds: ['general-1', 'general-2'],
    });
    // すぐに反映される: 割り当てた一般ユーザーは、そのハウスのロボットを含む設備の階層を閲覧できる
    const tree = (await (await context.request('/equipment', { token: tokens.one })).json()) as {
      facilities: { facility: { equipmentId: string } }[];
    };
    expect(tree.facilities.map((item) => item.facility.equipmentId)).toEqual([FACILITY_ID]);

    await put(context, FACILITY_ID, { userIds: ['general-2'] });

    const afterRevoke = (await (
      await context.request('/equipment', { token: tokens.one })
    ).json()) as {
      facilities: unknown[];
    };
    expect(afterRevoke.facilities).toEqual([]);
    expect((await table(context)).facilities[0]?.userIds).toEqual(['general-2']);
  });

  it('空にすると、そのハウスを閲覧できる一般ユーザーが、いなくなる', async () => {
    const { context } = await setup();
    await put(context, FACILITY_ID, { userIds: ['general-1'] });

    const response = await put(context, FACILITY_ID, { userIds: [] });

    expect(response.status).toBe(200);
    expect((await table(context)).facilities[0]?.userIds).toEqual([]);
  });

  it.each([
    ['存在しないハウス', 'HOUSE-NONE', { userIds: [] }],
    ['ロボット（ハウスではない）', ROBOT_ID, { userIds: [] }],
  ])('%s は、404（変更しない）', async (_name, facilityId, body) => {
    const { context } = await setup();

    const response = await put(context, facilityId, body);

    expect(response.status).toBe(404);
    expect(await context.container.repositories.facilityAccess.list()).toEqual([]);
  });

  it('削除済みのハウスは、404', async () => {
    const { context } = await setup();
    const second = await context.container.repositories.equipment.get(FACILITY_2_ID);
    if (second === undefined) {
      throw new Error('テストの前提: ハウスがある');
    }
    await context.container.repositories.equipment.save({ ...second, isDeleted: true });

    expect((await put(context, FACILITY_2_ID, { userIds: [] })).status).toBe(404);
  });

  it.each([
    ['存在しないユーザー', { userIds: ['nobody'] }],
    ['管理者（全ハウスを閲覧できるため、割り当ては不要）', { userIds: [TEST_USER.userId] }],
    ['ユーザーの指定がない', {}],
    ['ユーザーが配列でない', { userIds: 'general-1' }],
  ])('入力が不正（%s）なら、400 で拒否し、変更しない', async (_name, body) => {
    const { context } = await setup();
    await put(context, FACILITY_ID, { userIds: ['general-1'] });

    const response = await put(context, FACILITY_ID, body);

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('VALIDATION_ERROR');
    expect((await table(context)).facilities[0]?.userIds).toEqual(['general-1']);
  });

  it('管理者以外は、変更できない（403）', async () => {
    const { context, tokens } = await setup();

    const response = await put(context, FACILITY_ID, { userIds: ['general-1'] }, tokens.one);

    expect(response.status).toBe(403);
    expect(await context.container.repositories.facilityAccess.list()).toEqual([]);
  });

  it('変更履歴に、変更前後のユーザーを、操作者つきで残す', async () => {
    const { context } = await setup();
    await put(context, FACILITY_ID, { userIds: ['general-1'] });
    await put(context, FACILITY_ID, { userIds: ['general-1', 'general-2'] });

    const audit = AuditLogListResponseSchema.parse(
      await (await context.request('/audit-logs?targetType=facility-access')).json(),
    );

    expect(audit.items).toHaveLength(2);
    const latest = audit.items[0];
    expect(latest).toMatchObject({
      operation: 'UPDATE',
      targetType: 'facility-access',
      targetId: FACILITY_ID,
      actor: TEST_USER.userId,
      before: { facilityId: FACILITY_ID, userIds: ['general-1'] },
      after: { facilityId: FACILITY_ID, userIds: ['general-1', 'general-2'] },
    });
  });
});

describe('ユーザーの削除と、割り当て', () => {
  it('ユーザーを削除すると、そのユーザーの割り当てを、すべてのハウスから外す（ほかのユーザーは、そのまま）', async () => {
    const { context } = await setup();
    await put(context, FACILITY_ID, { userIds: ['general-1', 'general-2'] });
    await put(context, FACILITY_2_ID, { userIds: ['general-1'] });

    const response = await context.request('/users/general-1', { method: 'DELETE' });

    expect(response.status).toBe(204);
    const records = await context.container.repositories.facilityAccess.list();
    expect(records).toEqual([
      { facilityId: toEquipmentId(FACILITY_ID), userIds: ['general-2'] },
      { facilityId: toEquipmentId(FACILITY_2_ID), userIds: [] },
    ]);
  });
});
