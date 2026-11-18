/**
 * デモの取り込みを、デモ用の HTTP 配信に向ける処理（Issue #344。ADR-0025）のテスト。接続先の URL の解析と、
 * 取り込み元の接続・デモの設備のファイルのパスの設定。データはメモリ（実際の AWS には、接続しない）。
 */

import { describe, expect, it } from 'vitest';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import { EquipmentSchema, type Equipment } from '@smart-farm/shared/schemas/equipment';
import { DEMO_FEED_FILE_PATHS } from '../../src/backend/application/demo/demo-feed-schedule.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import {
  buildDemoEquipment,
  DEMO_ROBOT_ID,
  DEMO_SENSOR_ID,
} from '../../src/backend/infrastructure/local/synthetic-data.ts';
import { ConfigError, parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { applyDemoFeed, parseDemoFeedUrl } from '../../src/backend/runtime/demo-feed-connection.ts';

const NOW = new Date('2026-10-20T04:22:30.000Z');
const URL_MESSAGE = '接続先の URL が正しくありません';

/** ファイルのパスを持たない設備（開発サイトの、以前に投入したデモの設備）にする。 */
function withoutSourceFilePath(equipment: Equipment): Equipment {
  return EquipmentSchema.parse(
    Object.fromEntries(Object.entries(equipment).filter(([key]) => key !== 'sourceFilePath')),
  );
}

describe('接続先の URL の解析（parseDemoFeedUrl）', () => {
  it('https の URL を、HTTP の接続設定（HTTPS・認証なし）にする。ポートは、指定があれば持つ。ホストは小文字にそろう', () => {
    expect(parseDemoFeedUrl('https://Demo-Feed.example.com/')).toEqual({
      type: 'HTTP',
      protocol: 'HTTPS',
      host: 'demo-feed.example.com',
      authMethod: 'NONE',
      apiKeyHeaderName: 'X-API-Key',
    });
    expect(parseDemoFeedUrl(' https://demo-feed.example.com:8443 ')).toMatchObject({
      protocol: 'HTTPS',
      host: 'demo-feed.example.com',
      port: 8443,
    });
  });

  it('http の URL も、HTTP（平文）の接続設定にする（手元の確認用。ポートの指定あり）', () => {
    expect(parseDemoFeedUrl('http://127.0.0.1:18080/')).toMatchObject({
      protocol: 'HTTP',
      host: '127.0.0.1',
      port: 18080,
    });
  });

  it.each([
    ['', '空'],
    ['demo-feed.example.com', 'スキームがない'],
    ['ftp://demo-feed.example.com/', 'http・https 以外'],
    ['https://demo-feed.example.com/robot/latest.json', 'パスがある'],
    ['https://demo-feed.example.com/?key=value', 'クエリがある'],
    ['https://demo-feed.example.com/#top', 'フラグメントがある'],
    ['https://user:secret@demo-feed.example.com/', '認証情報がある'],
    ['https://user@demo-feed.example.com/', 'ユーザー名がある'],
    ['https://demo feed.example.com/', 'ホストに空白がある'],
  ])('正しくない URL（%s。%s）は、設定エラーにする', (text) => {
    expect(() => parseDemoFeedUrl(text)).toThrow(ConfigError);
    expect(() => parseDemoFeedUrl(text)).toThrow(URL_MESSAGE);
  });

  it('エラーのメッセージに、指定された URL（ホスト・認証情報）を含めない', () => {
    let message = '';
    try {
      parseDemoFeedUrl('https://user:dummy-secret@demo-feed.example.com/x');
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain(URL_MESSAGE);
    expect(message).not.toContain('dummy-secret');
    expect(message).not.toContain('demo-feed.example.com');
  });
});

describe('取り込みを、デモ用の HTTP 配信に向ける（applyDemoFeed）', () => {
  async function setup(options: { readonly withEquipment?: boolean } = {}) {
    const clock = createControllableClock(NOW);
    clock.freeze(NOW);
    const container = createContainer(parseConfig({ APP_MODE: 'test', PERSISTENCE: 'memory' }), {
      clock,
      ids: createSequentialIdGenerator('test'),
      logger: NULL_LOGGER,
    });
    await container.initialize();
    if (options.withEquipment !== false) {
      // 開発サイトの既存のデモの設備のように、ファイルのパスを持たない状態にする
      for (const equipment of buildDemoEquipment(NOW)) {
        await container.repositories.equipment.save(withoutSourceFilePath(equipment));
      }
    }
    return container;
  }

  const connection = parseDemoFeedUrl('https://demo-feed.example.com/');

  it('取り込み元（ロボット・環境センサー）の接続を HTTP にし、デモの設備にファイルのパスを設定する。そのほかの設定は、変えない', async () => {
    const container = await setup();
    const before = await container.ingestionSettings.listSources();

    const applied = await applyDemoFeed(container, connection);

    expect(applied).toEqual({ sources: 2, equipment: 2 });
    const after = await container.ingestionSettings.listSources();
    expect(after).toHaveLength(before.length);
    for (const source of after) {
      expect(source.connection).toEqual(connection);
      const original = before.find((item) => item.sourceId === source.sourceId);
      expect({ ...source, connection: undefined }).toEqual({ ...original, connection: undefined });
    }
    expect((await container.repositories.equipment.get(DEMO_ROBOT_ID))?.sourceFilePath).toBe(
      DEMO_FEED_FILE_PATHS.robot,
    );
    expect((await container.repositories.equipment.get(DEMO_SENSOR_ID))?.sourceFilePath).toBe(
      DEMO_FEED_FILE_PATHS['environment-sensor'],
    );
  });

  it('何度実行しても、同じ結果になる（ファイルのパスを設定済みの設備は、数えない。接続先の変更は、反映する）', async () => {
    const container = await setup();
    await applyDemoFeed(container, connection);

    const again = await applyDemoFeed(
      container,
      parseDemoFeedUrl('https://other-feed.example.com/'),
    );

    expect(again).toEqual({ sources: 2, equipment: 0 });
    const sources = await container.ingestionSettings.listSources();
    expect(sources.map((source) => source.connection)).toEqual([
      expect.objectContaining({ type: 'HTTP', host: 'other-feed.example.com' }),
      expect.objectContaining({ type: 'HTTP', host: 'other-feed.example.com' }),
    ]);
  });

  it('設備にすでにあるファイルのパスは、上書きしない', async () => {
    const container = await setup();
    const robot = await container.repositories.equipment.get(DEMO_ROBOT_ID);
    if (robot === undefined) {
      throw new Error('デモのロボットがありません');
    }
    await container.repositories.equipment.save({ ...robot, sourceFilePath: '/custom/robot.json' });

    const applied = await applyDemoFeed(container, connection);

    expect(applied.equipment).toBe(1);
    expect((await container.repositories.equipment.get(DEMO_ROBOT_ID))?.sourceFilePath).toBe(
      '/custom/robot.json',
    );
  });

  it('デモの設備がなければ、先に seed を実行するよう、エラーにして、何も変えない', async () => {
    const container = await setup({ withEquipment: false });
    // ロボットだけある（センサーがない）状態でも、何も変えない
    const [, robot] = buildDemoEquipment(NOW);
    if (robot === undefined) {
      throw new Error('デモのロボットがありません');
    }
    await container.repositories.equipment.save({
      ...robot,
      equipmentId: toEquipmentId('ROBOT-01'),
    });
    const before = await container.ingestionSettings.listSources();

    await expect(applyDemoFeed(container, connection)).rejects.toThrow('pnpm demo-data seed');

    expect(await container.ingestionSettings.listSources()).toEqual(before);
    expect((await container.repositories.equipment.get(DEMO_ROBOT_ID))?.sourceFilePath).toBe(
      DEMO_FEED_FILE_PATHS.robot,
    );
  });
});
