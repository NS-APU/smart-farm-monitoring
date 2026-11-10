/**
 * 閲覧範囲の判定（Issue #330。ADR-0013）。利用者が閲覧できる設備（ハウスと、配下のロボット・センサー）を決める。
 * - 全設備を閲覧する権限（`equipment:view-all`。既定では、管理者）がある利用者は、全設備（割り当てを見ない）
 * - ほかの利用者は、割り当て（ハウスごとの `facilityAccess`）に含まれるハウスと、その配下の設備だけ。割り当てがなければ、何も閲覧できない（安全側）
 * - 存在しない・削除済みのハウス（と配下）の割り当ては、無効。割り当ての変更は、次の判定から反映される（キャッシュしない）
 * 範囲外の設備は、存在しないものとして扱う（呼び出し側が NOT_FOUND にする。設備の有無を、漏らさない）。
 */

import type { Permission } from '@smart-farm/shared/constants/permissions';
import type { EquipmentId, UserId } from '@smart-farm/shared/schemas/common';
import type { EquipmentTreeResponse } from '@smart-farm/shared/schemas/equipment';
import type { Repositories } from '../ports/repositories.ts';

export type EquipmentScope =
  | { readonly kind: 'all' }
  | {
      readonly kind: 'limited';
      /** 閲覧できるハウスの識別子。 */
      readonly facilityIds: ReadonlySet<EquipmentId>;
      /** 閲覧できる設備の識別子（ハウスと、配下のロボット・センサー）。 */
      readonly equipmentIds: ReadonlySet<EquipmentId>;
    };

/** 全設備（管理者など）。 */
export const ALL_EQUIPMENT: EquipmentScope = { kind: 'all' };

export interface FacilityScopeUser {
  readonly userId: UserId;
  readonly permissions: readonly Permission[];
}

export interface FacilityScopeService {
  scopeOf(user: FacilityScopeUser): Promise<EquipmentScope>;
}

export function createFacilityScopeService(deps: {
  readonly repositories: Pick<Repositories, 'equipment' | 'facilityAccess'>;
}): FacilityScopeService {
  const { equipment, facilityAccess } = deps.repositories;
  return {
    async scopeOf(user) {
      if (user.permissions.includes('equipment:view-all')) {
        return ALL_EQUIPMENT;
      }
      const assigned = new Set(
        (await facilityAccess.list())
          .filter((record) => record.userIds.includes(user.userId))
          .map((record) => record.facilityId),
      );
      const all = await equipment.list();
      const facilityIds = new Set<EquipmentId>();
      const equipmentIds = new Set<EquipmentId>();
      for (const facility of all) {
        if (facility.equipmentType === 'FACILITY' && assigned.has(facility.equipmentId)) {
          facilityIds.add(facility.equipmentId);
          equipmentIds.add(facility.equipmentId);
        }
      }
      for (const item of all) {
        if (item.facilityId !== undefined && facilityIds.has(item.facilityId)) {
          equipmentIds.add(item.equipmentId);
        }
      }
      return { kind: 'limited', facilityIds, equipmentIds };
    },
  };
}

/** 設備を閲覧できるか。 */
export function canViewEquipment(scope: EquipmentScope, equipmentId: EquipmentId): boolean {
  return scope.kind === 'all' || scope.equipmentIds.has(equipmentId);
}

/** 設備の階層を、閲覧できるものに絞る（全設備のときは、そのまま返す）。 */
export function filterEquipmentTree(
  scope: EquipmentScope,
  tree: EquipmentTreeResponse,
): EquipmentTreeResponse {
  if (scope.kind === 'all') {
    return tree;
  }
  return {
    facilities: tree.facilities
      .filter((item) => scope.facilityIds.has(item.facility.equipmentId))
      .map((item) => ({
        facility: item.facility,
        children: item.children.filter((child) => scope.equipmentIds.has(child.equipmentId)),
      })),
  };
}
