/** 設備・ステータスコード・判断基準・設定の Repository（DynamoDB 実装）。少量のため、パーティションの全件を読む。 */

import { ViewpointCriteriaSchema } from '@smart-farm/shared/schemas/criteria';
import { EquipmentSchema } from '@smart-farm/shared/schemas/equipment';
import { StatusCodeDefinitionSchema } from '@smart-farm/shared/schemas/status-code';
import type {
  CriteriaRepository,
  EquipmentRepository,
  SettingsRepository,
  StatusCodeRepository,
} from '../../application/ports/repositories.ts';
import { mainAggregate } from './main-table.ts';
import { getItem, putItem, type Database } from './operations.ts';

const EQUIPMENT = 'EQUIPMENT';
const STATUS_CODE = 'STATUSCODE';
const CRITERIA = 'CRITERIA';
const SETTING = 'SETTING';

/** 論理削除したものは、指定がなければ除く。 */
function visible<Value extends { readonly isDeleted: boolean }>(
  items: readonly Value[],
  options: { readonly includeDeleted?: boolean } | undefined,
): Value[] {
  return options?.includeDeleted === true ? [...items] : items.filter((item) => !item.isDeleted);
}

export function createEquipmentRepository(db: Database): EquipmentRepository {
  const equipment = mainAggregate(db, EquipmentSchema);
  return {
    async list(options) {
      return visible(await equipment.list(EQUIPMENT), options);
    },
    get: (equipmentId) => equipment.get(EQUIPMENT, equipmentId),
    save: (item) => equipment.put(EQUIPMENT, item.equipmentId, item),
  };
}

export function createStatusCodeRepository(db: Database): StatusCodeRepository {
  const statusCodes = mainAggregate(db, StatusCodeDefinitionSchema);
  return {
    async list(options) {
      return visible(await statusCodes.list(STATUS_CODE), options);
    },
    get: (code) => statusCodes.get(STATUS_CODE, code),
    save: (definition) => statusCodes.put(STATUS_CODE, definition.code, definition),
  };
}

export function createCriteriaRepository(db: Database): CriteriaRepository {
  const criteria = mainAggregate(db, ViewpointCriteriaSchema);
  return {
    get: (viewpointId) => criteria.get(CRITERIA, viewpointId),
    save: (item) => criteria.put(CRITERIA, item.viewpointId, item),
    delete: (viewpointId) => criteria.remove(CRITERIA, viewpointId),
  };
}

export function createSettingsRepository(db: Database): SettingsRepository {
  return {
    async get(key) {
      return (await getItem(db, db.tables.main, { pk: SETTING, sk: key }))?.value;
    },
    async set(key, value) {
      await putItem(db, db.tables.main, { pk: SETTING, sk: key, value });
    },
  };
}
