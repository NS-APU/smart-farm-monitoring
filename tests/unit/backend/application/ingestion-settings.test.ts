/**
 * 取り込み設定の読み出し（Issue #174）の単体テスト。
 * 環境センサーの FormatProfile を CSV から JSON に置き換えたため、保存済みの設定の旧い識別子（environment-sensor-csv）を、
 * 読み出すときに、新しい識別子（environment-sensor-json）へ読み替える（保存の移行は、要らない）。
 */

import { describe, expect, it } from 'vitest';
import {
  INGESTION_SETTINGS_KEY,
  createIngestionSettings,
} from '../../../../src/backend/application/ingestion/ingestion-settings.ts';
import { createLocalRepositories } from '../../../../src/backend/infrastructure/local/local-repositories.ts';

function storedSource(sourceId: string, profileId: string) {
  return {
    sourceId,
    kind: sourceId === 'robot' ? 'ROBOT' : 'SENSOR',
    profileId,
    connectionRef: 'FILE_SERVER_MOCK',
    intervalMinutes: 15,
    isEnabled: true,
  };
}

describe('取り込み設定の既定', () => {
  it('保存がなければ、ロボットは robot-json、環境センサーは environment-sensor-json を使う', async () => {
    const { repositories } = createLocalRepositories();

    const sources = await createIngestionSettings(repositories.settings, 15).listSources();

    expect(sources.map((source) => [source.sourceId, source.profileId])).toEqual([
      ['robot', 'robot-json'],
      ['environment-sensor', 'environment-sensor-json'],
    ]);
  });
});

describe('保存済みの設定の、旧い FormatProfile の識別子の読み替え', () => {
  it('environment-sensor-csv は、environment-sensor-json として読む。ほかの項目は、変えない', async () => {
    const { repositories } = createLocalRepositories();
    await repositories.settings.set(INGESTION_SETTINGS_KEY, [
      storedSource('robot', 'robot-json'),
      storedSource('environment-sensor', 'environment-sensor-csv'),
    ]);

    const sources = await createIngestionSettings(repositories.settings, 15).listSources();

    expect(sources.map((source) => source.profileId)).toEqual([
      'robot-json',
      'environment-sensor-json',
    ]);
    expect(sources[1]).toMatchObject({
      sourceId: 'environment-sensor',
      connectionRef: 'FILE_SERVER_MOCK',
      intervalMinutes: 15,
      isEnabled: true,
    });
  });

  it('読み替えた設定を保存し直しても、新しい識別子になる（旧い識別子は、残らない）', async () => {
    const { repositories } = createLocalRepositories();
    await repositories.settings.set(INGESTION_SETTINGS_KEY, [
      storedSource('environment-sensor', 'environment-sensor-csv'),
    ]);
    const settings = createIngestionSettings(repositories.settings, 15);

    await settings.saveSources(await settings.listSources());

    expect(JSON.stringify(await repositories.settings.get(INGESTION_SETTINGS_KEY))).not.toContain(
      'environment-sensor-csv',
    );
  });

  it('未知の識別子は、そのまま（読み替えない）', async () => {
    const { repositories } = createLocalRepositories();
    await repositories.settings.set(INGESTION_SETTINGS_KEY, [storedSource('robot', 'custom-json')]);

    const sources = await createIngestionSettings(repositories.settings, 15).listSources();

    expect(sources[0]?.profileId).toBe('custom-json');
  });
});
