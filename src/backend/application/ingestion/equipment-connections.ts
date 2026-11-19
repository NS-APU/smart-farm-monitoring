/**
 * 設備ごとのファイルサーバーの接続（Issue #367。ADR-0026）。設備の項目には持たず、取り込みの設定の 1 つの保存先
 * （設備 ID → 接続）に持つ。設備（`GET /equipment`）は、ログインした利用者のだれもが読めるが、接続先は、取り込みの閲覧権限が必要なため。
 * 認証情報の値は持たない（NFR-5.4。設備ごとの参照名は、`file-server-credentials.ts` の `fileServerEquipmentSecretReference`）。
 */

import { z } from 'zod';
import {
  FileServerConnectionSchema,
  type FileServerConnection,
} from '@smart-farm/shared/schemas/ingestion';
import type { SettingsRepository } from '../ports/repositories.ts';

export const EQUIPMENT_CONNECTIONS_KEY = 'ingestion.equipment-connections';

const StoredSchema = z.record(z.string(), FileServerConnectionSchema);

export interface EquipmentConnections {
  /** 設備 ID → 接続（設備ごとの接続を持つ設備だけ）。 */
  list(): Promise<ReadonlyMap<string, FileServerConnection>>;
  /** 設備の接続を保存する（上書き）。 */
  save(equipmentId: string, connection: FileServerConnection): Promise<void>;
  /** 設備の接続を削除する。なければ、何もしない。 */
  remove(equipmentId: string): Promise<void>;
}

export function createEquipmentConnections(settings: SettingsRepository): EquipmentConnections {
  async function read(): Promise<Record<string, FileServerConnection>> {
    const stored = await settings.get(EQUIPMENT_CONNECTIONS_KEY);
    return stored === undefined ? {} : StoredSchema.parse(stored);
  }
  return {
    async list() {
      return new Map(Object.entries(await read()));
    },
    async save(equipmentId, connection) {
      await settings.set(EQUIPMENT_CONNECTIONS_KEY, {
        ...(await read()),
        [equipmentId]: connection,
      });
    },
    async remove(equipmentId) {
      const current = await read();
      if (!(equipmentId in current)) {
        return;
      }
      await settings.set(
        EQUIPMENT_CONNECTIONS_KEY,
        Object.fromEntries(Object.entries(current).filter(([id]) => id !== equipmentId)),
      );
    },
  };
}
