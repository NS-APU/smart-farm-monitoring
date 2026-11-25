/** 設備の削除の要求（D-28。Issue #229）の Repository（ローカル実装）。 */

import {
  EquipmentDeletionSchema,
  type EquipmentDeletion,
} from '../../../application/ports/records.ts';
import type { EquipmentDeletionRepository } from '../../../application/ports/repositories.ts';
import type { LocalStore } from '../local-store.ts';
import { deleterOf, saverOf } from './collection-helpers.ts';

export function createEquipmentDeletionRepository(store: LocalStore): EquipmentDeletionRepository {
  const deletions = store.collection(
    'equipmentDeletions',
    EquipmentDeletionSchema,
    (item: EquipmentDeletion) => item.equipmentId,
  );
  return {
    get: (equipmentId) => Promise.resolve(deletions.get(equipmentId)),
    list: () =>
      Promise.resolve(
        deletions.values().sort((left, right) => left.equipmentId.localeCompare(right.equipmentId)),
      ),
    save: saverOf(deletions),
    delete: deleterOf(deletions),
  };
}
