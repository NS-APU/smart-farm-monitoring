/** 設備・ステータスコード・判断基準・設定の Repository（ローカル実装）。 */

import { z } from 'zod';
import { ViewpointCriteriaSchema } from '@smart-farm/shared/schemas/criteria';
import { EquipmentSchema } from '@smart-farm/shared/schemas/equipment';
import { StatusCodeDefinitionSchema } from '@smart-farm/shared/schemas/status-code';
import { UnregisteredStatusCodeRecordSchema } from '../../../application/ports/records.ts';
import type {
  CriteriaRepository,
  EquipmentRepository,
  SettingsRepository,
  StatusCodeRepository,
  UnregisteredStatusCodeRepository,
} from '../../../application/ports/repositories.ts';
import type { LocalStore } from '../local-store.ts';
import { deleterOf, saverOf, visibleOnly } from './collection-helpers.ts';

const SettingEntrySchema = z.object({ key: z.string(), value: z.unknown() });

export function createEquipmentRepository(store: LocalStore): EquipmentRepository {
  const equipment = store.collection('equipment', EquipmentSchema, (item) => item.equipmentId);
  return {
    list: (listOptions) => Promise.resolve(visibleOnly(equipment.values(), listOptions)),
    get: (equipmentId) => Promise.resolve(equipment.get(equipmentId)),
    save: saverOf(equipment),
  };
}

export function createStatusCodeRepository(store: LocalStore): StatusCodeRepository {
  const statusCodes = store.collection(
    'statusCodes',
    StatusCodeDefinitionSchema,
    (item) => item.code,
  );
  return {
    list: (listOptions) => Promise.resolve(visibleOnly(statusCodes.values(), listOptions)),
    get: (code) => Promise.resolve(statusCodes.get(code)),
    save: saverOf(statusCodes),
  };
}

export function createUnregisteredStatusCodeRepository(
  store: LocalStore,
): UnregisteredStatusCodeRepository {
  const records = store.collection(
    'unregisteredStatusCodes',
    UnregisteredStatusCodeRecordSchema,
    (item) => item.code,
  );
  return {
    list: () => Promise.resolve(records.values()),
    record(code, count, seenAt) {
      // 同期の処理のため、同時の加算でも、取りこぼさない
      records.put({
        code,
        count: (records.get(code)?.count ?? 0) + count,
        lastSeenAt: seenAt.toISOString(),
      });
      return Promise.resolve();
    },
  };
}

export function createCriteriaRepository(store: LocalStore): CriteriaRepository {
  const criteria = store.collection(
    'criteria',
    ViewpointCriteriaSchema,
    (item) => item.viewpointId,
  );
  return {
    get: (viewpointId) => Promise.resolve(criteria.get(viewpointId)),
    save: saverOf(criteria),
    delete: deleterOf(criteria),
  };
}

export function createSettingsRepository(store: LocalStore): SettingsRepository {
  const settings = store.collection('settings', SettingEntrySchema, (item) => item.key);
  return {
    get: (key) => Promise.resolve(settings.get(key)?.value),
    set(key, value) {
      settings.put({ key, value });
      return Promise.resolve();
    },
  };
}
