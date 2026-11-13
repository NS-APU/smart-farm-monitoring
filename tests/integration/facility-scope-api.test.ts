/**
 * 閲覧系の API の、閲覧範囲（割り当てたハウス）による絞り込みの結合テスト（Issue #330。ADR-0013。FR-9.8）。
 * 一般ユーザー（ロール general）は、割り当てられたハウス（配下のロボット・センサーを含む）だけを閲覧できる。範囲外の設備は、存在しないもの
 * （404）として扱い、設備の有無を漏らさない。割り当てがない一般ユーザーは、何も閲覧できない。管理者は、全設備。
 * 対象: 設備の階層・ダッシュボード・観点の詳細・推移・観測値・手動入力（一覧・登録・修正・削除）。
 */

import { describe, expect, it } from 'vitest';
import { ManualEntryListResponseSchema } from '@smart-farm/shared/schemas/manual-entry';
import { ObservationListResponseSchema } from '@smart-farm/shared/schemas/observation';
import { toUserId } from '@smart-farm/shared/schemas/common';
import {
  FACILITY_2_ID,
  FACILITY_ID,
  observation,
  ROBOT_2_ID,
  ROBOT_ID,
  SENSOR_2_ID,
  SENSOR_ID,
  secondHouseSet,
} from '../support/builders.ts';
import {
  addUserAndLogin,
  errorOf,
  markPasswordChanged,
  TEST_NOW,
  withEquipment,
  type TestContext,
} from '../support/test-context.ts';

const VIEWPOINT = 'environmentalAdaptability';
const OBSERVED_AT = '2026-10-09T02:00:00.000Z';

const entryBody = (equipmentId: string) => ({
  equipmentId,
  category: 'OPERABILITY',
  observedAt: OBSERVED_AT,
  items: { operationStepCount: 4, operationMinutes: 8, operationErrorCount: 0 },
});

/** 2 つのハウス（それぞれ、ロボット・センサー）と、観測値・手動入力。一般ユーザー: assigned（HOUSE-T1 を割り当て）・nobody（割り当てなし）。 */
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
  const at = new Date(TEST_NOW.getTime() - 60_000).toISOString();
  await context.container.repositories.observations.saveMany([
    observation({
      equipmentId: SENSOR_ID,
      itemKey: 'temperatureCelsius',
      value: 20,
      observedAt: at,
    }),
    observation({
      equipmentId: SENSOR_2_ID,
      itemKey: 'temperatureCelsius',
      value: 21,
      observedAt: at,
    }),
  ]);
  await context.container.evaluationService.evaluateAll('DEV');
  const own = (await (
    await context.request('/manual-entries', { method: 'POST', body: entryBody(ROBOT_ID) })
  ).json()) as {
    entry: { entryId: string };
  };
  const other = (await (
    await context.request('/manual-entries', { method: 'POST', body: entryBody(ROBOT_2_ID) })
  ).json()) as {
    entry: { entryId: string };
  };
  return {
    context,
    assigned,
    nobody,
    ownEntryId: own.entry.entryId,
    otherEntryId: other.entry.entryId,
  };
}

const get = (context: TestContext, path: string, token?: string) =>
  context.request(path, token === undefined ? {} : { token });

async function expectNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect((await errorOf(response)).code).toBe('NOT_FOUND');
}

describe('設備の階層・ダッシュボード・観点', () => {
  it('設備の階層: 割り当てたハウス（と配下）だけ。割り当てがなければ、空。管理者は全部', async () => {
    const { context, assigned, nobody } = await setup();
    const ids = async (token?: string) =>
      (
        (await (await get(context, '/equipment', token)).json()) as {
          facilities: { facility: { equipmentId: string }; children: { equipmentId: string }[] }[];
        }
      ).facilities.map((item) => [
        item.facility.equipmentId,
        ...item.children.map((c) => c.equipmentId),
      ]);

    expect(await ids(assigned)).toEqual([[FACILITY_ID, ROBOT_ID, SENSOR_ID]]);
    expect(await ids(nobody)).toEqual([]);
    expect(await ids()).toEqual([
      [FACILITY_ID, ROBOT_ID, SENSOR_ID],
      [FACILITY_2_ID, ROBOT_2_ID, SENSOR_2_ID],
    ]);
  });

  it('ダッシュボード: 範囲外のハウス・ロボット・センサーは、404（存在しないもの）。範囲内は、200', async () => {
    const { context, assigned } = await setup();

    for (const id of [FACILITY_2_ID, ROBOT_2_ID, SENSOR_2_ID, 'HOUSE-NONE']) {
      await expectNotFound(await get(context, `/dashboard?equipmentId=${id}`, assigned));
    }
    for (const id of [FACILITY_ID, ROBOT_ID, SENSOR_ID]) {
      expect((await get(context, `/dashboard?equipmentId=${id}`, assigned)).status, id).toBe(200);
    }
  });

  it('設備を省略すると、閲覧できる最初のハウス。割り当てがなければ、404', async () => {
    const { context, assigned, nobody } = await setup();
    // 最初のハウスが範囲外のユーザー（2 つ目のハウスだけを割り当てる）でも、閲覧できるハウスになる
    await context.container.repositories.facilityAccess.save({
      facilityId: FACILITY_ID,
      userIds: [],
    });
    await context.container.repositories.facilityAccess.save({
      facilityId: FACILITY_2_ID,
      userIds: [toUserId('assigned')],
    });

    const body = (await (await get(context, '/dashboard', assigned)).json()) as {
      equipmentId: string;
    };

    expect(body.equipmentId).toBe(FACILITY_2_ID);
    await expectNotFound(await get(context, '/dashboard', nobody));
  });

  it('観点の詳細・推移: 範囲外の設備は 404、範囲内は 200', async () => {
    const { context, assigned } = await setup();

    for (const path of [
      `/viewpoints/${VIEWPOINT}?equipmentId=${FACILITY_2_ID}`,
      `/viewpoints/${VIEWPOINT}/series?equipmentId=${SENSOR_2_ID}`,
    ]) {
      await expectNotFound(await get(context, path, assigned));
    }
    for (const path of [
      `/viewpoints/${VIEWPOINT}?equipmentId=${FACILITY_ID}`,
      `/viewpoints/${VIEWPOINT}/series?equipmentId=${SENSOR_ID}`,
    ]) {
      expect((await get(context, path, assigned)).status, path).toBe(200);
    }
  });
});

describe('観測値の一覧（GET /observations）', () => {
  const OWN_HOUSE = new Set<string>([FACILITY_ID, ROBOT_ID, SENSOR_ID]);
  const OTHER_HOUSE = new Set<string>([FACILITY_2_ID, ROBOT_2_ID, SENSOR_2_ID]);
  const PERIOD = 'from=2026-10-01T00:00:00.000Z&to=2026-10-10T00:00:00.000Z';
  const equipmentIdsOf = async (response: Response) => {
    expect(response.status).toBe(200);
    return new Set(
      ObservationListResponseSchema.parse(await response.json()).items.map(
        (item) => item.equipmentId,
      ),
    );
  };

  it('設備を指定しないと、範囲内の設備の観測値だけ（手動入力の観測値を含む）。割り当てがなければ、空。管理者は全部', async () => {
    const { context, assigned, nobody } = await setup();

    const own = await equipmentIdsOf(await get(context, '/observations', assigned));
    const admin = await equipmentIdsOf(await get(context, '/observations'));

    expect(own).toEqual(new Set([SENSOR_ID, ROBOT_ID]));
    expect([...own].some((id) => OTHER_HOUSE.has(id))).toBe(false);
    expect((await equipmentIdsOf(await get(context, '/observations', nobody))).size).toBe(0);
    expect(admin).toEqual(new Set([SENSOR_ID, ROBOT_ID, SENSOR_2_ID, ROBOT_2_ID]));
  });

  it('範囲外の設備を指定すると、404。範囲内（ハウスを指定すると、配下を含む）は、200', async () => {
    const { context, assigned } = await setup();

    await expectNotFound(
      await get(context, `/observations?equipmentId=${FACILITY_2_ID}`, assigned),
    );
    await expectNotFound(await get(context, `/observations?equipmentId=${SENSOR_2_ID}`, assigned));
    const ids = await equipmentIdsOf(
      await get(context, `/observations?equipmentId=${FACILITY_ID}`, assigned),
    );
    expect([...ids].every((id) => OWN_HOUSE.has(id))).toBe(true);
    expect(ids.has(SENSOR_ID)).toBe(true);
  });

  it('キーワードで検索しても、範囲外の設備の観測値は出ない（設備名の部分一致でも）', async () => {
    const { context, assigned } = await setup();

    const both = await equipmentIdsOf(
      await get(
        context,
        `/observations?q=${encodeURIComponent('テストセンサー')}&${PERIOD}`,
        assigned,
      ),
    );
    const otherOnly = await equipmentIdsOf(
      await get(
        context,
        `/observations?q=${encodeURIComponent('テストセンサー2')}&${PERIOD}`,
        assigned,
      ),
    );

    expect(both).toEqual(new Set([SENSOR_ID]));
    expect(otherOnly.size).toBe(0);
  });
});

describe('手動入力（一覧・登録・修正・削除）', () => {
  const entriesOf = async (response: Response) =>
    ManualEntryListResponseSchema.parse(await response.json()).items.map(
      (item) => item.equipmentId,
    );

  it('一覧: 範囲内の設備の入力だけ。範囲外の設備を指定すると 404。割り当てがなければ空。管理者は全部', async () => {
    const { context, assigned, nobody } = await setup();

    expect(await entriesOf(await get(context, '/manual-entries', assigned))).toEqual([ROBOT_ID]);
    await expectNotFound(await get(context, `/manual-entries?equipmentId=${ROBOT_2_ID}`, assigned));
    expect(await entriesOf(await get(context, '/manual-entries', nobody))).toEqual([]);
    expect((await entriesOf(await get(context, '/manual-entries'))).sort()).toEqual([
      ROBOT_ID,
      ROBOT_2_ID,
    ]);
  });

  it('登録: 範囲内の設備には 201、範囲外の設備は 404（登録しない）。割り当てがなければ 404', async () => {
    const { context, assigned, nobody } = await setup();
    const post = (equipmentId: string, token: string) =>
      context.request('/manual-entries', {
        method: 'POST',
        body: { ...entryBody(equipmentId), observedAt: '2026-10-09T01:00:00.000Z' },
        token,
      });

    expect((await post(ROBOT_ID, assigned)).status).toBe(201);
    await expectNotFound(await post(ROBOT_2_ID, assigned));
    await expectNotFound(await post(ROBOT_ID, nobody));
    expect(await entriesOf(await get(context, '/manual-entries'))).toHaveLength(3);
  });

  it('修正・削除: 範囲内の入力は、他人の入力にもできる。範囲外の入力は 404（変更しない）。範囲外の設備へ付け替えることもできない', async () => {
    const { context, assigned, ownEntryId, otherEntryId } = await setup();
    const call = (method: 'PUT' | 'DELETE', entryId: string, body?: unknown) =>
      context.request(`/manual-entries/${entryId}`, {
        method,
        token: assigned,
        ...(body === undefined ? {} : { body }),
      });

    // ownEntryId は、管理者が登録した範囲内の入力（他人の入力）
    expect((await call('PUT', ownEntryId, entryBody(ROBOT_ID))).status).toBe(200);
    await expectNotFound(await call('PUT', otherEntryId, entryBody(ROBOT_2_ID)));
    await expectNotFound(await call('PUT', ownEntryId, entryBody(ROBOT_2_ID)));
    await expectNotFound(await call('DELETE', otherEntryId));
    expect((await call('DELETE', ownEntryId)).status).toBe(204);

    expect(await entriesOf(await get(context, '/manual-entries'))).toEqual([ROBOT_2_ID]);
  });
});
