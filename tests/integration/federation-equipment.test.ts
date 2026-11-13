/**
 * 設備の連携（D-35: 設備の名前・ID。ADR-0024。Issue #177 の PR 2）の結合テスト。
 * 設備を登録・修正（名称・ハウスの変更）したとき、連携キューに積む。削除では、積まない（基盤のデータは、削除しない。D-28）。
 * 連携を設定した初回に、既存の設備を、まとめて積む（enqueueAllEquipment）。
 * 送信は、偽の transport で確かめる（実際の接続先に依存しない）。
 */

import { describe, expect, it } from 'vitest';
import { createFederationConnectionStore } from '../../src/backend/application/federation/federation-connection-store.ts';
import type {
  NgsiLdRequest,
  NgsiLdTransport,
} from '../../src/backend/infrastructure/http/ngsi-ld-http-transport.ts';
import { toEquipmentId, toUserId } from '../../src/shared/schemas/common.ts';
import { FACILITY_ID, ROBOT_ID } from '../support/builders.ts';
import { TEST_USER, createTestContext } from '../support/test-context.ts';

const ACTOR = toUserId(TEST_USER.userId);
const DAY_MS = 24 * 60 * 60_000;

async function setup() {
  const requests: NgsiLdRequest[] = [];
  const transport: NgsiLdTransport = (request) => {
    requests.push(request);
    return Promise.resolve({ status: 204, body: '' });
  };
  const context = await createTestContext({
    env: { FEDERATION_MODE: 'ngsi-ld' },
    federationTransport: transport,
  });
  const store = createFederationConnectionStore({
    settings: context.container.repositories.settings,
    secrets: context.container.secrets,
  });
  await store.saveEndpoint('https://platform.example.test/api/orion/ngsi-ld/v1');
  await store.saveSettings({
    tenant: 'smart_farm_monitoring',
    contextUrl: 'https://example.test/context.jsonld',
    enabled: true,
  });
  const { equipmentService, federationService } = context.container;

  /** 連携ジョブを実行し、送った設備のエンティティ（型・識別子・名前・親）を返す。 */
  async function sendAndCollect() {
    requests.length = 0;
    context.clock.advance(DAY_MS);
    await context.container.jobRunner.run('JB-03');
    return requests
      .flatMap((request) => JSON.parse(request.body ?? '[]') as Record<string, unknown>[])
      .filter((entity) =>
        ['Greenhouse', 'HarvestRobot', 'EnvironmentSensor'].includes(String(entity.type)),
      );
  }
  return { context, equipmentService, federationService, sendAndCollect };
}

describe('設備の連携', () => {
  it('ハウス・ロボットを登録すると、名前・親のハウスを、設備のエンティティとして送る', async () => {
    const { equipmentService, sendAndCollect } = await setup();
    await equipmentService.create(
      { equipmentId: FACILITY_ID, equipmentType: 'FACILITY', name: 'テストハウス' },
      ACTOR,
    );
    await equipmentService.create(
      {
        equipmentId: ROBOT_ID,
        equipmentType: 'ROBOT',
        name: 'テストロボット',
        facilityId: FACILITY_ID,
        externalId: 'ROBOT-EXTERNAL-SECRET',
      },
      ACTOR,
    );

    const entities = await sendAndCollect();

    expect(entities).toContainEqual({
      id: `urn:ngsi-ld:Greenhouse:${FACILITY_ID}`,
      type: 'Greenhouse',
      name: { type: 'Property', value: 'テストハウス' },
    });
    expect(entities).toContainEqual({
      id: `urn:ngsi-ld:HarvestRobot:${ROBOT_ID}`,
      type: 'HarvestRobot',
      name: { type: 'Property', value: 'テストロボット' },
      refGreenhouse: { type: 'Relationship', object: `urn:ngsi-ld:Greenhouse:${FACILITY_ID}` },
    });
    expect(JSON.stringify(entities)).not.toContain('ROBOT-EXTERNAL-SECRET');
  });

  it('名称を修正すると、新しい名前を送る。名称・ハウスが変わらない修正（取得間隔だけなど）は、送らない', async () => {
    const { equipmentService, sendAndCollect } = await setup();
    await equipmentService.create(
      { equipmentId: FACILITY_ID, equipmentType: 'FACILITY', name: 'テストハウス' },
      ACTOR,
    );
    await equipmentService.create(
      {
        equipmentId: ROBOT_ID,
        equipmentType: 'ROBOT',
        name: 'テストロボット',
        facilityId: FACILITY_ID,
      },
      ACTOR,
    );
    await sendAndCollect();

    await equipmentService.update(ROBOT_ID, { name: 'テストロボット', intervalMinutes: 5 }, ACTOR);
    const unchanged = await sendAndCollect();
    await equipmentService.update(ROBOT_ID, { name: '改名したロボット' }, ACTOR);
    const renamed = await sendAndCollect();

    expect(unchanged).toEqual([]);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({
      id: `urn:ngsi-ld:HarvestRobot:${ROBOT_ID}`,
      name: { value: '改名したロボット' },
    });
  });

  it('設備を削除しても、何も送らない（基盤のデータは、削除しない。D-28）', async () => {
    const { equipmentService, sendAndCollect } = await setup();
    await equipmentService.create(
      { equipmentId: FACILITY_ID, equipmentType: 'FACILITY', name: 'テストハウス' },
      ACTOR,
    );
    await sendAndCollect();

    await equipmentService.delete(FACILITY_ID, ACTOR);

    expect(await sendAndCollect()).toEqual([]);
  });

  it('連携を設定した初回に、既存の設備（削除済みを除く）を、まとめて積む', async () => {
    const { context, federationService, sendAndCollect } = await setup();
    // 連携を設定する前に登録された設備（連携キューには、積まれていない）
    const createdAt = '2026-10-01T00:00:00.000Z';
    const { equipment } = context.container.repositories;
    await equipment.save({
      equipmentId: FACILITY_ID,
      equipmentType: 'FACILITY',
      name: '既存のハウス',
      isDeleted: false,
      createdAt,
    });
    await equipment.save({
      equipmentId: ROBOT_ID,
      equipmentType: 'ROBOT',
      name: '既存のロボット',
      facilityId: FACILITY_ID,
      isDeleted: false,
      createdAt,
    });
    await equipment.save({
      equipmentId: toEquipmentId('ROBOT-OLD'),
      equipmentType: 'ROBOT',
      name: '削除済み',
      facilityId: FACILITY_ID,
      isDeleted: true,
      createdAt,
    });

    const enqueued = await federationService.enqueueAllEquipment();
    const entities = await sendAndCollect();

    expect(enqueued).toBe(2);
    expect(entities.map((entity) => entity.id).sort()).toEqual([
      `urn:ngsi-ld:Greenhouse:${FACILITY_ID}`,
      `urn:ngsi-ld:HarvestRobot:${ROBOT_ID}`,
    ]);
  });
});
