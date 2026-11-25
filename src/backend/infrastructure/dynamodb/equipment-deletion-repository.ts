/**
 * 設備の削除の要求（D-28。Issue #229）の Repository（DynamoDB 実装）。`Main` の `EQDEL` / `{設備 ID}`。削除の操作ごとに 1 件で、
 * 同時に進行するのは、少数（人が操作する）のため、パーティションの全件を読む。
 */

import { EquipmentDeletionSchema } from '../../application/ports/records.ts';
import type { EquipmentDeletionRepository } from '../../application/ports/repositories.ts';
import { mainAggregate } from './main-table.ts';
import type { Database } from './operations.ts';

const EQUIPMENT_DELETION = 'EQDEL';

export function createEquipmentDeletionRepository(db: Database): EquipmentDeletionRepository {
  const deletions = mainAggregate(db, EquipmentDeletionSchema);
  return {
    get: (equipmentId) => deletions.get(EQUIPMENT_DELETION, equipmentId),
    list: () => deletions.list(EQUIPMENT_DELETION),
    save: (deletion) => deletions.put(EQUIPMENT_DELETION, deletion.equipmentId, deletion),
    delete: (equipmentId) => deletions.remove(EQUIPMENT_DELETION, equipmentId),
  };
}
