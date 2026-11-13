/**
 * 連携ログのハウス別の内訳（Issue #332。ADR-0013。一般ユーザーに、閲覧できるハウスの分だけを見せるため）の結合テスト。
 * 項目を積むときに、送るデータの設備からハウスを決め、送った結果（成功・失敗・保留・期限切れ）を、ハウスごとの項目数で記録する。
 * 設備に結びつかない項目（以前の項目・設備のないデータ）は、ハウスの内訳に含めない（全設備を閲覧できる利用者だけが、全体のログで見る）。
 */

import { describe, expect, it } from 'vitest';
import { MS_PER_DAY } from '@smart-farm/shared/time';
import { createFederationService } from '../../src/backend/application/federation/federation-service.ts';
import { FederationUnavailableError } from '../../src/backend/application/ports/federation-port.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { DEFAULT_APP_SETTINGS } from '../../src/backend/application/settings.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import {
  equipmentSet,
  FACILITY_ID,
  FACILITY_2_ID,
  ROBOT_2_ID,
  ROBOT_ID,
  secondHouseSet,
} from '../support/builders.ts';
import { TEST_NOW } from '../support/test-context.ts';

async function setup() {
  const { repositories } = createLocalRepositories();
  for (const equipment of [...equipmentSet(), ...secondHouseSet()]) {
    await repositories.equipment.save(equipment);
  }
  const clock = createControllableClock(TEST_NOW);
  let down = false;
  const service = createFederationService({
    federation: repositories.federation,
    equipment: repositories.equipment,
    notifications: { notifyFederationExpired: () => Promise.resolve(null) },
    port: {
      send: () =>
        down ? Promise.reject(new FederationUnavailableError('停止中')) : Promise.resolve(),
    },
    clock,
    ids: createSequentialIdGenerator(),
    settings: DEFAULT_APP_SETTINGS.federation,
    logger: NULL_LOGGER,
  });
  return {
    repositories,
    clock,
    service,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

type Context = Awaited<ReturnType<typeof setup>>;

function observationPayload(...equipmentIds: string[]) {
  return {
    observations: equipmentIds.map((equipmentId) => ({ equipmentId, itemKey: 'harvestCount' })),
  };
}

async function unsentItems(context: Context) {
  return context.repositories.federation.listDue(new Date(TEST_NOW.getTime() + MS_PER_DAY), 100);
}

async function logs(context: Context) {
  return (await context.repositories.federation.listLogs({ limit: 20 })).items;
}

describe('連携のハウス別の内訳（#332）', () => {
  it('観測値の項目は、観測値の設備のハウスを、項目に持つ（複数のハウスにまたがれば、すべて）', async () => {
    const context = await setup();

    await context.service.enqueue({
      targetType: 'OBSERVATION',
      targetRef: 'robot#a.json',
      payload: observationPayload(ROBOT_ID, ROBOT_ID, ROBOT_2_ID),
    });

    const [item] = await unsentItems(context);
    expect([...(item?.facilityIds ?? [])].sort()).toEqual([FACILITY_ID, FACILITY_2_ID].sort());
  });

  it('評価の項目は、設備のハウスを持つ。ハウス自身の評価は、そのハウス', async () => {
    const context = await setup();

    await context.service.enqueue({
      targetType: 'EVALUATION',
      targetRef: `${FACILITY_ID}#harvestAccuracy`,
      payload: { equipmentId: FACILITY_ID, viewpointId: 'harvestAccuracy' },
    });
    await context.service.enqueue({
      targetType: 'EVALUATION',
      targetRef: `${ROBOT_2_ID}#harvestAccuracy`,
      payload: { equipmentId: ROBOT_2_ID, viewpointId: 'harvestAccuracy' },
    });

    const items = await unsentItems(context);
    expect(items.map((item) => item.facilityIds)).toEqual([[FACILITY_ID], [FACILITY_2_ID]]);
  });

  it('設備を特定できない項目・見つからない設備の項目は、ハウスを持たない', async () => {
    const context = await setup();

    await context.service.enqueue({
      targetType: 'OBSERVATION',
      targetRef: 'x',
      payload: { observations: [{ itemKey: 'x' }] },
    });
    await context.service.enqueue({
      targetType: 'OBSERVATION',
      targetRef: 'y',
      payload: observationPayload('NO-SUCH-EQUIPMENT'),
    });

    const items = await unsentItems(context);
    expect(items.map((item) => item.facilityIds ?? [])).toEqual([[], []]);
  });

  it('送信の結果のログに、ハウスごとの項目数を記録する（成功）', async () => {
    const context = await setup();
    await context.service.enqueue({
      targetType: 'OBSERVATION',
      targetRef: 'a',
      payload: observationPayload(ROBOT_ID),
    });
    await context.service.enqueue({
      targetType: 'OBSERVATION',
      targetRef: 'b',
      payload: observationPayload(ROBOT_ID, ROBOT_2_ID),
    });
    await context.service.enqueue({
      targetType: 'OBSERVATION',
      targetRef: 'c',
      payload: { observations: [{ itemKey: 'x' }] },
    });

    await context.service.runPending();

    const [log] = await logs(context);
    expect(log).toMatchObject({ result: 'SENT', itemCount: 3 });
    expect(log?.facilities).toEqual(
      expect.arrayContaining([
        { facilityId: FACILITY_ID, itemCount: 2 },
        { facilityId: FACILITY_2_ID, itemCount: 1 },
      ]),
    );
    expect(log?.facilities).toHaveLength(2);
  });

  it('保留・失敗のときも、ハウスごとの項目数を記録する', async () => {
    const context = await setup();
    context.setDown(true);
    await context.service.enqueue({
      targetType: 'OBSERVATION',
      targetRef: 'a',
      payload: observationPayload(ROBOT_2_ID),
    });

    await context.service.runPending();

    const [log] = await logs(context);
    expect(log).toMatchObject({ result: 'HELD' });
    expect(log?.facilities).toEqual([{ facilityId: FACILITY_2_ID, itemCount: 1 }]);
  });

  it('期限切れで破棄したときも、そのハウスの分を記録する。項目の facilityIds は、破棄しても残る', async () => {
    const context = await setup();
    await context.service.enqueue({
      targetType: 'OBSERVATION',
      targetRef: 'old',
      payload: observationPayload(ROBOT_ID),
    });
    context.clock.advance(30 * MS_PER_DAY + 1);

    await context.service.runPending();

    const [log] = await logs(context);
    expect(log).toMatchObject({ result: 'EXPIRED', itemCount: 1 });
    expect(log?.facilities).toEqual([{ facilityId: FACILITY_ID, itemCount: 1 }]);
  });

  it('ハウスを持たない項目だけの送信は、ハウスの内訳を持たない', async () => {
    const context = await setup();
    await context.service.enqueue({
      targetType: 'OBSERVATION',
      targetRef: 'x',
      payload: { observations: [{ itemKey: 'x' }] },
    });

    await context.service.runPending();

    const [log] = await logs(context);
    expect(log?.facilities ?? []).toEqual([]);
  });
});
