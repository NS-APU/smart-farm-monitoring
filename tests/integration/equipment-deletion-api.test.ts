/**
 * 設備の削除（D-28。Issue #229。UC-12）の結合テスト: 削除すると、設備はすぐに外れ（削除中）、ジョブ（JB-05）が、
 * 設備のデータを削除する。削除が終わった設備の ID は、再登録できる。
 */

import { describe, expect, it } from 'vitest';
import { AuditLogListResponseSchema } from '@smart-farm/shared/schemas/audit';
import { EquipmentDeletionListResponseSchema } from '@smart-farm/shared/schemas/equipment';
import { JOB_LEASE_MS } from '../../src/backend/application/jobs/job-schedule.ts';
import { FACILITY_ID, must, observation, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import { errorOf, withEquipment, type TestContext } from '../support/test-context.ts';

const send = (context: TestContext, method: string, path: string, body?: unknown) =>
  context.request(path, { method, ...(body === undefined ? {} : { body }) });

/** 削除のジョブを、掃除の待ちを挟んで、完了するまで実行する。 */
async function finishDeletion(context: TestContext): Promise<void> {
  await context.container.jobRunner.run('JB-05');
  context.clock.advance(JOB_LEASE_MS);
  await context.container.jobRunner.run('JB-05');
}

const REREGISTER = {
  equipmentId: ROBOT_ID,
  equipmentType: 'ROBOT',
  name: '再登録したロボット',
  facilityId: FACILITY_ID,
};

describe('設備の削除（UC-12）', () => {
  it('削除すると、設備はすぐに一覧・評価から外れる。設備の記録は、削除済みで残り、削除中の一覧に出る', async () => {
    const context = await withEquipment();

    const response = await send(context, 'DELETE', `/equipment/${ROBOT_ID}`);

    expect(response.status).toBe(200);
    expect((await context.container.repositories.equipment.get(ROBOT_ID))?.isDeleted).toBe(true);
    const tree = (await (await send(context, 'GET', '/equipment')).json()) as {
      facilities: { children: { equipmentId: string }[] }[];
    };
    expect(tree.facilities[0]?.children.map((child) => child.equipmentId)).toEqual([SENSOR_ID]);
    const deletions = EquipmentDeletionListResponseSchema.parse(
      await (await send(context, 'GET', '/equipment/deletions')).json(),
    );
    expect(deletions.items).toEqual([
      expect.objectContaining({ equipmentId: ROBOT_ID, status: 'DELETING', childNames: [] }),
    ]);
  });

  it('ジョブが、設備の観測値・手動入力・評価結果を削除し、設備の記録を消す。変更履歴（設備）は残り、削除の記録（件数）が加わる', async () => {
    const context = await withEquipment();
    await context.container.repositories.observations.saveMany([
      observation({ equipmentId: ROBOT_ID, itemKey: 'operationStepCount', value: 12 }),
      observation({ equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 20 }),
    ]);
    await context.container.evaluationService.evaluateAll('DEV');
    await send(context, 'DELETE', `/equipment/${ROBOT_ID}`);

    await finishDeletion(context);

    const { repositories } = context.container;
    expect(await repositories.equipment.get(ROBOT_ID)).toBeUndefined();
    expect(
      (await repositories.observations.query({}, { limit: 10 })).items.map(
        (item) => item.equipmentId,
      ),
    ).toEqual([SENSOR_ID]);
    expect(await repositories.evaluations.listLatest(ROBOT_ID)).toEqual([]);
    expect(await repositories.equipmentDeletions.list()).toEqual([]);
    const history = AuditLogListResponseSchema.parse(
      await (
        await send(
          context,
          'GET',
          `/audit-logs?targetType=equipment&targetId=${ROBOT_ID}&operation=DELETE`,
        )
      ).json(),
    );
    // 削除の操作（実行者・日時）と、データの削除の完了（件数）
    expect(history.items).toHaveLength(2);
    expect(history.items.map((item) => item.before)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deleted: expect.objectContaining({ observations: 1 }) }),
      ]),
    );
  });

  it('ハウスを削除すると、配下のロボット・センサーも削除する（削除中の一覧には、配下の名前が出る）', async () => {
    const context = await withEquipment();

    await send(context, 'DELETE', `/equipment/${FACILITY_ID}`);

    const deletions = EquipmentDeletionListResponseSchema.parse(
      await (await send(context, 'GET', '/equipment/deletions')).json(),
    );
    expect(deletions.items[0]?.childNames).toHaveLength(2);
    await finishDeletion(context);
    expect(await context.container.repositories.equipment.list({ includeDeleted: true })).toEqual(
      [],
    );
    expect(await (await send(context, 'GET', '/equipment')).json()).toEqual({ facilities: [] });
  });

  it('削除中の設備と同じ設備 ID は、登録できない（409）。削除が終わると、同じ設備 ID を再登録できる', async () => {
    const context = await withEquipment();
    await send(context, 'DELETE', `/equipment/${ROBOT_ID}`);

    const during = await send(context, 'POST', '/equipment', REREGISTER);

    expect(during.status).toBe(409);
    expect((await errorOf(during)).message).toContain('削除しています');

    await finishDeletion(context);
    const after = await send(context, 'POST', '/equipment', REREGISTER);

    expect(after.status).toBe(201);
    expect((await context.container.repositories.equipment.get(ROBOT_ID))?.isDeleted).toBe(false);
  });

  it('削除の要求がなく、削除済みのまま残っている設備（以前の論理削除）の設備 ID は、これまでどおり、登録できない', async () => {
    const context = await withEquipment();
    const robot = await context.container.repositories.equipment.get(ROBOT_ID);
    await context.container.repositories.equipment.save({ ...must(robot), isDeleted: true });

    const response = await send(context, 'POST', '/equipment', REREGISTER);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain('すでに登録されています');
  });
});

describe('削除中の設備のデータ（削除ジョブが消すまで、画面に出さない）', () => {
  const entry = {
    equipmentId: ROBOT_ID,
    category: 'OPERABILITY',
    observedAt: '2026-10-09T02:00:00.000Z',
    items: { operationStepCount: 4, operationMinutes: 8, operationErrorCount: 0 },
  };

  it('計測データの一覧に、削除中の設備の観測値を出さない（設備を指定しない一覧でも）', async () => {
    const context = await withEquipment();
    await context.container.repositories.observations.saveMany([
      observation({ equipmentId: ROBOT_ID, itemKey: 'operationStepCount', value: 12 }),
      observation({ equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 20 }),
    ]);
    const idsOf = async () =>
      (
        (await (await send(context, 'GET', '/observations')).json()) as {
          items: { equipmentId: string }[];
        }
      ).items.map((item) => item.equipmentId);
    expect(await idsOf()).toEqual(expect.arrayContaining([ROBOT_ID, SENSOR_ID]));

    await send(context, 'DELETE', `/equipment/${ROBOT_ID}`);

    expect(await idsOf()).toEqual([SENSOR_ID]);
  });

  it('手動入力の一覧に、削除中の設備の入力を出さず、その入力の修正・削除は、見つからない（404）', async () => {
    const context = await withEquipment();
    const created = (await (await send(context, 'POST', '/manual-entries', entry)).json()) as {
      entry: { entryId: string };
    };
    const { entryId } = created.entry;
    const listed = async () =>
      (
        (await (await send(context, 'GET', '/manual-entries')).json()) as {
          items: unknown[];
        }
      ).items.length;
    expect(await listed()).toBe(1);

    await send(context, 'DELETE', `/equipment/${ROBOT_ID}`);

    expect(await listed()).toBe(0);
    expect((await send(context, 'DELETE', `/manual-entries/${entryId}`)).status).toBe(404);
    expect(
      (await send(context, 'PUT', `/manual-entries/${entryId}`, { ...entry, note: '修正' })).status,
    ).toBe(404);
  });

  it('設備を削除する前の手動入力・その変更履歴は、ジョブが、削除する（変更履歴の「手動入力」の履歴に、残らない）', async () => {
    const context = await withEquipment();
    await send(context, 'POST', '/manual-entries', entry);
    await send(context, 'DELETE', `/equipment/${ROBOT_ID}`);

    await finishDeletion(context);

    const audit = AuditLogListResponseSchema.parse(
      await (await send(context, 'GET', '/audit-logs?targetType=manual-entry')).json(),
    );
    expect(audit.items).toEqual([]);
    expect(
      await context.container.repositories.manualEntries.list({}, { limit: 10 }),
    ).toMatchObject({ items: [] });
  });
});
