/**
 * 閲覧の割り当て（ハウスごと）の管理（Issue #330。ADR-0013。FR-9.8）。管理者が、ハウスごとに、閲覧できる一般ユーザーを決める。
 * - 表（行がハウス、列が一般ユーザー）: 削除済みのハウス・存在しないユーザー・全設備を閲覧できる権限をもつユーザー（管理者）は、出さない
 * - 変更: そのハウスの閲覧できるユーザーを、置き換える（重複はまとめる）。存在しないユーザー・管理者は、入力の誤り（400）
 * - 変更履歴（操作履歴）に、変更前後のユーザーを残す。割り当ての変更は、次のリクエストから反映される（閲覧範囲の判定は、毎回、読む）
 */

import { AppError, validationError } from '@smart-farm/shared/errors';
import type { EquipmentId, UserId } from '@smart-farm/shared/schemas/common';
import type {
  FacilityAccessEntry,
  FacilityAccessResponse,
} from '@smart-farm/shared/schemas/facility-access';
import type { AuditTargetType } from '@smart-farm/shared/schemas/audit';
import type { AuditService } from '../audit/audit-service.ts';
import type { AccessPolicy } from '../auth/access-policy.ts';
import { EQUIPMENT_NOT_FOUND_MESSAGE } from '../equipment/require-active-equipment.ts';
import type { Repositories } from '../ports/repositories.ts';

const TARGET_TYPE = 'facility-access' satisfies AuditTargetType;

export interface FacilityAccessService {
  table(): Promise<FacilityAccessResponse>;
  setUsers(
    facilityId: EquipmentId,
    userIds: readonly UserId[],
    actor: UserId,
  ): Promise<FacilityAccessEntry>;
}

export function createFacilityAccessService(deps: {
  readonly repositories: Pick<Repositories, 'equipment' | 'facilityAccess' | 'users'>;
  readonly policy: AccessPolicy;
  readonly audit: AuditService;
}): FacilityAccessService {
  const { equipment, facilityAccess, users } = deps.repositories;
  const { policy, audit } = deps;

  /** 割り当ての対象になる利用者（全設備を閲覧できる権限をもたない利用者）。 */
  async function assignableUsers() {
    return (await users.list()).filter((user) => !policy.can(user.role, 'equipment:view-all'));
  }

  async function activeFacilities() {
    return (await equipment.list())
      .filter((item) => item.equipmentType === 'FACILITY')
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.equipmentId.localeCompare(right.equipmentId),
      );
  }

  const entryOf = (
    facilityId: EquipmentId,
    name: string,
    userIds: readonly UserId[],
  ): FacilityAccessEntry => ({ facilityId, name, userIds: [...userIds] });

  return {
    async table() {
      const targets = await assignableUsers();
      const targetIds = new Set(targets.map((user) => user.userId));
      const records = new Map(
        (await facilityAccess.list()).map((record) => [record.facilityId, record]),
      );
      return {
        facilities: (await activeFacilities()).map((facility) =>
          entryOf(
            facility.equipmentId,
            facility.name,
            (records.get(facility.equipmentId)?.userIds ?? [])
              .filter((userId) => targetIds.has(userId))
              .sort((left, right) => left.localeCompare(right)),
          ),
        ),
        users: targets.map((user) => ({ userId: user.userId, userName: user.userName })),
      };
    },

    async setUsers(facilityId, userIds, actor) {
      const facility = (await activeFacilities()).find((item) => item.equipmentId === facilityId);
      if (facility === undefined) {
        throw new AppError('NOT_FOUND', EQUIPMENT_NOT_FOUND_MESSAGE);
      }
      const targetIds = new Set((await assignableUsers()).map((user) => user.userId));
      if (userIds.some((userId) => !targetIds.has(userId))) {
        throw validationError([
          {
            name: 'userIds',
            message:
              '存在しないユーザー、または、すべてのハウスを閲覧できるユーザー（管理者）は、割り当てられません',
          },
        ]);
      }
      const next = [...new Set(userIds)].sort((left, right) => left.localeCompare(right));
      const before = (await facilityAccess.get(facilityId))?.userIds ?? [];
      await facilityAccess.save({ facilityId, userIds: next });
      await audit.record({
        operation: 'UPDATE',
        targetType: TARGET_TYPE,
        targetId: facilityId,
        actor,
        before: { facilityId, userIds: before },
        after: { facilityId, userIds: next },
      });
      return entryOf(facility.equipmentId, facility.name, next);
    },
  };
}
