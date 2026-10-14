/**
 * 評価の単位（暫定。FR-5.3、dev_spec.md 4章）。
 * - ハウス: ハウスと配下のロボット・センサーの観測値をまとめて評価する（全観点）
 * - ロボット／センサー: その設備の観測値のみで評価する（ロボットはロボットの観点、センサーは環境適応性）
 */

import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { ExpectedStreams } from '../../domain/evaluation/measures.ts';

export interface EvaluationScope {
  readonly equipment: Equipment;
  readonly equipmentIds: readonly EquipmentId[];
  readonly expectedStreams: ExpectedStreams;
}

export function resolveEvaluationScope(
  equipment: Equipment,
  allEquipment: readonly Equipment[],
): EvaluationScope {
  if (equipment.equipmentType === 'FACILITY') {
    const children = allEquipment.filter(
      (candidate) => !candidate.isDeleted && candidate.facilityId === equipment.equipmentId,
    );
    return {
      equipment,
      equipmentIds: [equipment.equipmentId, ...children.map((child) => child.equipmentId)],
      expectedStreams: {
        robot: children.some((child) => child.equipmentType === 'ROBOT'),
        sensor: children.some((child) => child.equipmentType === 'SENSOR'),
      },
    };
  }
  return {
    equipment,
    equipmentIds: [equipment.equipmentId],
    expectedStreams: {
      robot: equipment.equipmentType === 'ROBOT',
      sensor: equipment.equipmentType === 'SENSOR',
    },
  };
}
