/**
 * 評価の単位（決定。ADR-0017 の D-19。FR-5.3、dev_spec.md 4章）。
 * - ロボット／センサー: その設備の観測値のみで評価する（ロボットはロボットの観点、センサーは環境適応性）
 * - ハウス: ロボットの観点・環境適応性は、配下の設備の最も悪い結果（`domain/evaluation/worst-result.ts`）。
 *   運用面の観点（データ活用度合い・満足度）は、ハウスと配下のロボット・センサーの観測値で評価する（ここで求める範囲）
 */

import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { ExpectedStreams } from '../../domain/evaluation/measures.ts';

export interface EvaluationScope {
  readonly equipment: Equipment;
  readonly equipmentIds: readonly EquipmentId[];
  readonly expectedStreams: ExpectedStreams;
}

/** ハウスの配下の設備（削除されていないロボット・センサー。登録の順）。ハウス以外は、空。 */
export function memberEquipmentOf(
  equipment: Equipment,
  allEquipment: readonly Equipment[],
): Equipment[] {
  return equipment.equipmentType !== 'FACILITY'
    ? []
    : allEquipment.filter(
        (candidate) => !candidate.isDeleted && candidate.facilityId === equipment.equipmentId,
      );
}

export function resolveEvaluationScope(
  equipment: Equipment,
  allEquipment: readonly Equipment[],
): EvaluationScope {
  if (equipment.equipmentType === 'FACILITY') {
    const children = memberEquipmentOf(equipment, allEquipment);
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
