/**
 * 設備管理のユースケース（UC-12。FR-2）。ハウス → ロボット／センサーの階層を保持する。
 * 登録・変更・削除（論理削除）は、変更履歴に記録し、評価に反映する（評価の単位が変わるため）。
 * ハウスを削除した場合は、配下のロボット・センサーも削除する（暫定。dev_spec.md 4章 No.24）。
 */

import { conflictError, validationError } from '@smart-farm/shared/errors';
import type { EquipmentId, UserId } from '@smart-farm/shared/schemas/common';
import type {
  Equipment,
  EquipmentCreateRequest,
  EquipmentTreeResponse,
  EquipmentUpdateRequest,
} from '@smart-farm/shared/schemas/equipment';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import type { AuditTargetType } from '@smart-farm/shared/schemas/audit';
import type { AuditService } from '../audit/audit-service.ts';
import { requireActiveEquipment } from './require-active-equipment.ts';
import type { EvaluationService } from '../evaluation/evaluation-service.ts';
import { reevaluateSafely } from '../evaluation/reevaluate-safely.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { Logger } from '../ports/logger-port.ts';
import type { EquipmentRepository } from '../ports/repositories.ts';

const EQUIPMENT_TARGET_TYPE = 'equipment' satisfies AuditTargetType;

export interface EquipmentService {
  /** ハウス → ロボット／センサーの階層（論理削除を除く）。 */
  getTree(): Promise<EquipmentTreeResponse>;
  create(input: EquipmentCreateRequest, actor: UserId): Promise<Equipment>;
  update(
    equipmentId: EquipmentId,
    input: EquipmentUpdateRequest,
    actor: UserId,
  ): Promise<Equipment>;
  /** 論理削除する（ハウスは、配下も）。存在しない（削除済みを含む）場合は NOT_FOUND。 */
  delete(equipmentId: EquipmentId, actor: UserId): Promise<void>;
}

export interface EquipmentServiceDeps {
  readonly equipment: EquipmentRepository;
  readonly audit: AuditService;
  readonly evaluation: EvaluationService;
  readonly clock: ClockPort;
  readonly logger: Logger;
}

function byCreation(left: Equipment, right: Equipment): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.equipmentId.localeCompare(right.equipmentId)
  );
}

export function createEquipmentService(deps: EquipmentServiceDeps): EquipmentService {
  const { equipment: repository, audit, evaluation, clock, logger } = deps;

  const findActive = (equipmentId: EquipmentId): Promise<Equipment> =>
    requireActiveEquipment(repository, equipmentId);

  /** 親のハウスが、登録済み（削除されていない）のハウスであることを確認する。 */
  async function assertFacility(facilityId: EquipmentId): Promise<void> {
    const facility = await repository.get(facilityId);
    if (facility?.equipmentType !== 'FACILITY' || facility.isDeleted) {
      throw validationError([{ name: 'facilityId', message: '親のハウスが見つかりません' }]);
    }
  }

  /** ファイルの中の設備の識別子（externalId）は、同じ種別の設備の中で一意（取り込みの対応づけのため）。 */
  async function assertExternalIdUnique(
    equipmentType: Equipment['equipmentType'],
    externalId: string | undefined,
    ownId: EquipmentId | undefined,
  ): Promise<void> {
    if (externalId === undefined) {
      return;
    }
    const duplicated = (await repository.list()).some(
      (other) =>
        other.equipmentType === equipmentType &&
        other.externalId === externalId &&
        other.equipmentId !== ownId,
    );
    if (duplicated) {
      throw conflictError('externalId', '同じデータ上の識別子がすでに登録されています');
    }
  }

  /** 評価の更新。失敗しても、設備の保存の結果には影響させない。 */
  const reevaluate = (): Promise<void> =>
    reevaluateSafely(evaluation, logger, 'EQUIPMENT_CHANGE', '設備の変更後の評価に失敗しました');

  return {
    async getTree() {
      const all = await repository.list();
      const facilities = all.filter((item) => item.equipmentType === 'FACILITY').sort(byCreation);
      return {
        facilities: facilities.map((facility) => ({
          facility,
          children: all.filter((item) => item.facilityId === facility.equipmentId).sort(byCreation),
        })),
      };
    },

    async create(input, actor) {
      // 削除済みの設備と同じ識別子も、重複として扱う（過去のデータの取り違えを防ぐ）
      if ((await repository.get(input.equipmentId)) !== undefined) {
        throw conflictError('equipmentId', '同じ設備IDがすでに登録されています');
      }
      if (input.facilityId !== undefined) {
        await assertFacility(input.facilityId);
      }
      await assertExternalIdUnique(input.equipmentType, input.externalId, undefined);
      const created: Equipment = {
        equipmentId: input.equipmentId,
        equipmentType: input.equipmentType,
        name: input.name,
        ...omitUndefined({
          facilityId: input.facilityId,
          externalId: input.externalId,
        }),
        isDeleted: false,
        createdAt: clock.now().toISOString(),
      };
      await repository.save(created);
      await audit.record({
        operation: 'CREATE',
        targetType: EQUIPMENT_TARGET_TYPE,
        targetId: created.equipmentId,
        actor,
        after: created,
      });
      await reevaluate();
      return created;
    },

    async update(equipmentId, input, actor) {
      const before = await findActive(equipmentId);
      if (before.equipmentType === 'FACILITY' && input.facilityId !== undefined) {
        throw validationError([{ name: 'facilityId', message: 'ハウスは親を持てません' }]);
      }
      const facilityId =
        before.equipmentType === 'FACILITY' ? undefined : (input.facilityId ?? before.facilityId);
      if (facilityId !== undefined) {
        await assertFacility(facilityId);
      }
      await assertExternalIdUnique(before.equipmentType, input.externalId, equipmentId);
      const updated: Equipment = {
        equipmentId: before.equipmentId,
        equipmentType: before.equipmentType,
        name: input.name,
        ...omitUndefined({
          facilityId,
          externalId: input.externalId,
        }),
        isDeleted: false,
        createdAt: before.createdAt,
      };
      await repository.save(updated);
      await audit.record({
        operation: 'UPDATE',
        targetType: EQUIPMENT_TARGET_TYPE,
        targetId: equipmentId,
        actor,
        before,
        after: updated,
      });
      await reevaluate();
      return updated;
    },

    async delete(equipmentId, actor) {
      const target = await findActive(equipmentId);
      const children =
        target.equipmentType === 'FACILITY'
          ? (await repository.list()).filter((item) => item.facilityId === equipmentId)
          : [];
      for (const equipment of [target, ...children]) {
        await repository.save({ ...equipment, isDeleted: true });
        await audit.record({
          operation: 'DELETE',
          targetType: EQUIPMENT_TARGET_TYPE,
          targetId: equipment.equipmentId,
          actor,
          before: equipment,
        });
      }
      await reevaluate();
    },
  };
}
