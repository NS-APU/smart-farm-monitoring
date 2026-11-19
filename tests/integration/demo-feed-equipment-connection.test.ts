/**
 * デモの取り込みを、デモ用の HTTP 配信に向ける処理（Issue #344。ADR-0025）が、デモの設備ごとの接続（Issue #367。ADR-0026）も保存することのテスト。
 * 取り込み元の共通の接続は、移行期間のため、残す。データはメモリ（実際の AWS には、接続しない）。
 */

import { describe, expect, it } from 'vitest';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import {
  buildDemoEquipment,
  DEMO_ROBOT_ID,
  DEMO_SENSOR_ID,
} from '../../src/backend/infrastructure/local/synthetic-data.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { applyDemoFeed, parseDemoFeedUrl } from '../../src/backend/runtime/demo-feed-connection.ts';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';

const NOW = new Date('2026-10-20T04:22:30.000Z');

async function setup() {
  const clock = createControllableClock(NOW);
  clock.freeze(NOW);
  const container = createContainer(parseConfig({ APP_MODE: 'test', PERSISTENCE: 'memory' }), {
    clock,
    ids: createSequentialIdGenerator('test'),
    logger: NULL_LOGGER,
  });
  await container.initialize();
  for (const equipment of buildDemoEquipment(NOW)) {
    await container.repositories.equipment.save(equipment);
  }
  return container;
}

describe('デモの設備ごとの接続（applyDemoFeed）', () => {
  const connection = parseDemoFeedUrl('https://dummy-demo-feed.example.invalid/');

  it('デモの設備（ロボット・環境センサー）の設備ごとの接続に、同じ接続（HTTP・認証なし）を保存する。取り込み元の共通の接続も、残す', async () => {
    const container = await setup();

    await applyDemoFeed(container, connection);

    const saved = await container.equipmentConnections.list();
    expect([...saved.keys()].sort()).toEqual([DEMO_ROBOT_ID, DEMO_SENSOR_ID].sort());
    expect(saved.get(DEMO_ROBOT_ID)).toEqual(connection);
    expect(saved.get(DEMO_SENSOR_ID)).toEqual(connection);
    const sources = await container.ingestionSettings.listSources();
    for (const source of sources) {
      expect(source.connection).toEqual(connection);
    }
  });

  it('何度実行しても、同じ（接続先の変更は、反映する）。デモの設備以外の設備ごとの接続は、変えない', async () => {
    const container = await setup();
    const other = toEquipmentId('ROBOT-OTHER');
    const otherConnection = { ...connection, host: 'dummy-other.example.invalid' };
    await container.equipmentConnections.save(other, otherConnection);

    await applyDemoFeed(container, connection);
    const first = await container.equipmentConnections.list();
    await applyDemoFeed(container, connection);
    const second = await container.equipmentConnections.list();
    await applyDemoFeed(container, { ...connection, port: 8443 });
    const changed = await container.equipmentConnections.list();

    expect(second).toEqual(first);
    expect(changed.get(DEMO_ROBOT_ID)).toMatchObject({ port: 8443 });
    expect(changed.get(DEMO_SENSOR_ID)).toMatchObject({ port: 8443 });
    expect(changed.get(other)).toEqual(otherConnection);
  });

  it('デモの設備がなければ、何も保存しない（先に seed を実行するエラー）', async () => {
    const empty = createContainer(parseConfig({ APP_MODE: 'test', PERSISTENCE: 'memory' }), {
      logger: NULL_LOGGER,
    });
    await empty.initialize();

    await expect(applyDemoFeed(empty, connection)).rejects.toThrow('先に pnpm demo-data seed');

    expect((await empty.equipmentConnections.list()).size).toBe(0);
  });
});
