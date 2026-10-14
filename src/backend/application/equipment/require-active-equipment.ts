/** 設備の取得。未登録または削除済みの設備は、NOT_FOUND とする（削除済みの設備を、操作・参照の対象にしない）。 */

import { AppError } from '@smart-farm/shared/errors';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { EquipmentRepository } from '../ports/repositories.ts';

export const EQUIPMENT_NOT_FOUND_MESSAGE = '設備が見つかりません';

export async function requireActiveEquipment(
  repository: Pick<EquipmentRepository, 'get'>,
  equipmentId: EquipmentId,
): Promise<Equipment> {
  const found = await repository.get(equipmentId);
  if (found === undefined || found.isDeleted) {
    throw new AppError('NOT_FOUND', EQUIPMENT_NOT_FOUND_MESSAGE);
  }
  return found;
}
