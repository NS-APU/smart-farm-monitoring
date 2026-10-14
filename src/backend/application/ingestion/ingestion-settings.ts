/**
 * 取り込み設定（取り込み元ごとの接続先の参照名・取得間隔）。認証情報の値は持たない（NFR-5.4）。
 * 設定の変更（UC-15）は IngestionAdminService が行い、ここに保存する。保存がなければ、既定の取り込み元を返す。
 */

import { z } from 'zod';
import { IngestionSourceSchema, type IngestionSource } from '@smart-farm/shared/schemas/ingestion';
import type { SettingsRepository } from '../ports/repositories.ts';

export const INGESTION_SETTINGS_KEY = 'ingestion.sources';

/** 取り込み元の識別子（ロボットデータ・環境センサーデータ。FR-1.1, FR-1.2）。 */
const ROBOT_SOURCE_ID = 'robot';
const ENVIRONMENT_SENSOR_SOURCE_ID = 'environment-sensor';

/** 取り込み元の表示名（通知・画面で使う）。未知の取り込み元は、識別子をそのまま使う。 */
export function sourceDisplayName(sourceId: string): string {
  switch (sourceId) {
    case ROBOT_SOURCE_ID:
      return 'ロボットデータ';
    case ENVIRONMENT_SENSOR_SOURCE_ID:
      return '環境センサーデータ';
    default:
      return sourceId;
  }
}

/** 既定の取り込み元。接続先は、ローカルではファイルサーバーのモック（Q-002 が確定するまで）。 */
function defaultIngestionSources(
  intervalMinutes: IngestionSource['intervalMinutes'],
): IngestionSource[] {
  return [
    {
      sourceId: ROBOT_SOURCE_ID,
      kind: 'ROBOT',
      profileId: 'robot-json',
      connectionRef: 'FILE_SERVER_MOCK',
      intervalMinutes,
      isEnabled: true,
    },
    {
      sourceId: ENVIRONMENT_SENSOR_SOURCE_ID,
      kind: 'SENSOR',
      profileId: 'environment-sensor-csv',
      connectionRef: 'FILE_SERVER_MOCK',
      intervalMinutes,
      isEnabled: true,
    },
  ];
}

export interface IngestionSettings {
  listSources(): Promise<IngestionSource[]>;
  saveSources(sources: readonly IngestionSource[]): Promise<void>;
}

export function createIngestionSettings(
  settings: SettingsRepository,
  defaultIntervalMinutes: IngestionSource['intervalMinutes'],
): IngestionSettings {
  return {
    async listSources() {
      const stored = await settings.get(INGESTION_SETTINGS_KEY);
      if (stored === undefined) {
        return defaultIngestionSources(defaultIntervalMinutes);
      }
      return z.array(IngestionSourceSchema).parse(stored);
    },
    saveSources: (sources) => settings.set(INGESTION_SETTINGS_KEY, sources),
  };
}
