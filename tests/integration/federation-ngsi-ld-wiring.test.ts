/**
 * 農業情報基盤の NGSI-LD のアダプタの組み立て（FEDERATION_MODE=ngsi-ld。ADR-0024。Issue #177 の PR 1）の結合テスト。
 * 接続先が未設定のあいだは、連携を保留にする（モックのように、受け取ったことにしない）。設定すると、設備ごとのエンティティを送る。
 * 送信は、偽の transport で確かめる（実際の接続先に依存しない）。
 */

import { describe, expect, it } from 'vitest';
import { createFederationConnectionStore } from '../../src/backend/application/federation/federation-connection-store.ts';
import type {
  NgsiLdRequest,
  NgsiLdTransport,
} from '../../src/backend/infrastructure/http/ngsi-ld-http-transport.ts';
import { toUserId } from '../../src/shared/schemas/common.ts';
import { FACILITY_ID, ROBOT_ID } from '../support/builders.ts';
import { TEST_USER, withEquipment } from '../support/test-context.ts';

async function setup() {
  const requests: NgsiLdRequest[] = [];
  const transport: NgsiLdTransport = (request) => {
    requests.push(request);
    return Promise.resolve({ status: 204, body: '' });
  };
  const context = await withEquipment({
    env: { FEDERATION_MODE: 'ngsi-ld' },
    federationTransport: transport,
  });
  const store = createFederationConnectionStore({
    settings: context.container.repositories.settings,
    secrets: context.container.secrets,
  });
  // 手動入力（故障の記録）で、連携キューに、観測値の項目を積む
  await context.container.manualEntryService.create(
    {
      equipmentId: ROBOT_ID,
      category: 'FAILURE',
      observedAt: '2026-10-09T02:00:00.000Z',
      items: { failureCount: 2 },
    },
    toUserId(TEST_USER.userId),
  );
  return { context, store, requests };
}

describe('FEDERATION_MODE=ngsi-ld の組み立て', () => {
  it('接続先が未設定のあいだは、送信せず、保留にする（モックのように、受け取ったことにしない）', async () => {
    const { context, requests } = await setup();

    await context.container.jobRunner.run('JB-03');

    expect(requests).toHaveLength(0);
    const logs = await context.container.repositories.federation.listLogs({ limit: 10 });
    expect(logs.items[0]).toMatchObject({ result: 'HELD' });
  });

  it('接続先と設定（有効）を保存すると、設備ごとのエンティティを、設定のテナント・context で送る', async () => {
    const { context, store, requests } = await setup();
    await store.saveEndpoint('https://platform.example.test/api/orion/ngsi-ld/v1');
    await store.saveSettings({
      tenant: 'smart_farm_monitoring',
      contextUrl: 'https://example.test/context.jsonld',
      enabled: true,
    });
    // 保留の項目は、次の試行の時刻まで、送らない。時計を進める
    context.clock.advance(24 * 60 * 60_000);

    await context.container.jobRunner.run('JB-03');

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.path).toBe('/api/orion/ngsi-ld/v1/entityOperations/upsert?options=update');
      expect(request.headers['NGSILD-Tenant']).toBe('smart_farm_monitoring');
    }
    const entities = requests.flatMap(
      (request) => JSON.parse(request.body ?? '[]') as Record<string, unknown>[],
    );
    expect(entities).toContainEqual(
      expect.objectContaining({
        id: `urn:ngsi-ld:EquipmentObserved:${ROBOT_ID}`,
        type: 'EquipmentObserved',
        refEquipment: { type: 'Relationship', object: `urn:ngsi-ld:HarvestRobot:${ROBOT_ID}` },
        failureCount: expect.objectContaining({ value: 2 }) as unknown,
      }),
    );
  });

  it('手動入力の入力者・備考・ユーザーの情報は、送らない', async () => {
    const { context, store, requests } = await setup();
    await context.container.manualEntryService.create(
      {
        equipmentId: FACILITY_ID,
        category: 'FAILURE',
        observedAt: '2026-10-09T02:05:00.000Z',
        items: { failureCount: 1 },
        note: '備考の内容（個人の所感）',
      },
      toUserId(TEST_USER.userId),
    );
    await store.saveEndpoint('https://platform.example.test/v1');
    await store.saveSettings({
      tenant: 'smart_farm_monitoring',
      contextUrl: 'https://example.test/context.jsonld',
      enabled: true,
    });
    context.clock.advance(24 * 60 * 60_000);

    await context.container.jobRunner.run('JB-03');

    const bodies = requests.map((request) => request.body).join('');
    expect(bodies).toContain('failureCount');
    expect(bodies).not.toContain('備考の内容');
    expect(bodies).not.toContain(TEST_USER.userId);
  });

  it('FEDERATION_MODE を指定しなければ、モック（受け取りを記録する）', async () => {
    const context = await withEquipment();
    await context.container.evaluationService.evaluateAll('DEV');

    await context.container.jobRunner.run('JB-03');

    const logs = await context.container.repositories.federation.listLogs({ limit: 10 });
    expect(logs.items[0]).toMatchObject({ result: 'SENT' });
  });
});
