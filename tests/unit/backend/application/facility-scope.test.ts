/**
 * 閲覧範囲の判定（Issue #330。ADR-0013）の単体テスト。
 * 管理者（権限 `equipment:view-all`）は全設備。ほかは、ハウスごとの割り当て（`facilityAccess`）に、ユーザーが含まれる
 * ハウスと、その配下のロボット・センサー。存在しない・削除済みの設備は、範囲に含めない。割り当てがなければ、何も閲覧できない。
 */

import { describe, expect, it } from 'vitest';
import { toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
import {
  ALL_EQUIPMENT,
  canViewEquipment,
  createFacilityScopeService,
  filterEquipmentTree,
} from '../../../../src/backend/application/access/facility-scope.ts';
import { createLocalRepositories } from '../../../../src/backend/infrastructure/local/local-repositories.ts';
import {
  equipmentSet,
  FACILITY_2_ID,
  FACILITY_ID,
  ROBOT_2_ID,
  ROBOT_ID,
  SENSOR_ID,
  secondHouseSet,
} from '../../../support/builders.ts';

const first = <Item>(items: readonly Item[]): Item => {
  const item = items[0];
  if (item === undefined) {
    throw new Error('テストの前提: 要素がある');
  }
  return item;
};

const GENERAL = toUserId('general-1');
const OTHER = toUserId('general-2');
const GENERAL_USER = { userId: GENERAL, permissions: ['manual-entry:write'] as const };
const ADMIN_USER = { userId: toUserId('admin-1'), permissions: ['equipment:view-all'] as const };

async function setup(access: readonly [string, readonly string[]][] = []) {
  const { repositories } = createLocalRepositories();
  for (const equipment of [...equipmentSet(), ...secondHouseSet()]) {
    await repositories.equipment.save(equipment);
  }
  for (const [facilityId, userIds] of access) {
    await repositories.facilityAccess.save({
      facilityId: toEquipmentId(facilityId),
      userIds: userIds.map((userId) => toUserId(userId)),
    });
  }
  return { repositories, service: createFacilityScopeService({ repositories }) };
}

describe('閲覧範囲の判定（ハウスごとの割り当て）', () => {
  it('全設備を閲覧する権限（equipment:view-all）がある利用者（管理者）は、全設備（割り当てを見ない）', async () => {
    const { service } = await setup();

    const scope = await service.scopeOf(ADMIN_USER);

    expect(scope).toBe(ALL_EQUIPMENT);
    expect(canViewEquipment(scope, FACILITY_2_ID)).toBe(true);
    expect(canViewEquipment(scope, toEquipmentId('NOT-REGISTERED'))).toBe(true);
  });

  it('割り当てたハウスと、その配下のロボット・センサーだけを閲覧できる。ほかのハウスは、閲覧できない', async () => {
    const { service } = await setup([[FACILITY_ID, [GENERAL]]]);

    const scope = await service.scopeOf(GENERAL_USER);

    for (const id of [FACILITY_ID, ROBOT_ID, SENSOR_ID]) {
      expect(canViewEquipment(scope, id), id).toBe(true);
    }
    for (const id of [FACILITY_2_ID, ROBOT_2_ID, toEquipmentId('NOT-REGISTERED')]) {
      expect(canViewEquipment(scope, id), id).toBe(false);
    }
  });

  it('割り当てがない一般ユーザーは、何も閲覧できない（安全側）。ほかのユーザーの割り当ては、影響しない', async () => {
    const { service } = await setup([[FACILITY_ID, [OTHER]]]);

    const scope = await service.scopeOf(GENERAL_USER);

    expect(scope.kind).toBe('limited');
    for (const id of [FACILITY_ID, ROBOT_ID, FACILITY_2_ID]) {
      expect(canViewEquipment(scope, id), id).toBe(false);
    }
  });

  it('複数のハウスを割り当てると、その全部を閲覧できる', async () => {
    const { service } = await setup([
      [FACILITY_ID, [GENERAL]],
      [FACILITY_2_ID, [GENERAL, OTHER]],
    ]);

    const scope = await service.scopeOf(GENERAL_USER);

    expect(canViewEquipment(scope, ROBOT_ID)).toBe(true);
    expect(canViewEquipment(scope, ROBOT_2_ID)).toBe(true);
  });

  it('削除済みのハウス・存在しないハウスの割り当ては、無効（範囲に含めない）。削除済みの配下の設備も、含めない', async () => {
    const { repositories, service } = await setup([
      [FACILITY_ID, [GENERAL]],
      [FACILITY_2_ID, [GENERAL]],
      ['HOUSE-GONE', [GENERAL]],
    ]);
    const second = await repositories.equipment.get(FACILITY_2_ID);
    const robot = await repositories.equipment.get(ROBOT_ID);
    if (second === undefined || robot === undefined) {
      throw new Error('テストの前提: 設備がある');
    }
    await repositories.equipment.save({ ...second, isDeleted: true });
    await repositories.equipment.save({ ...robot, isDeleted: true });

    const scope = await service.scopeOf(GENERAL_USER);

    expect(canViewEquipment(scope, FACILITY_ID)).toBe(true);
    expect(canViewEquipment(scope, SENSOR_ID)).toBe(true);
    expect(canViewEquipment(scope, ROBOT_ID)).toBe(false);
    expect(canViewEquipment(scope, FACILITY_2_ID)).toBe(false);
    expect(canViewEquipment(scope, ROBOT_2_ID)).toBe(false);
    expect(canViewEquipment(scope, toEquipmentId('HOUSE-GONE'))).toBe(false);
  });

  it('割り当ての変更は、次の判定から反映される（キャッシュしない）', async () => {
    const { repositories, service } = await setup([[FACILITY_ID, [GENERAL]]]);
    expect(canViewEquipment(await service.scopeOf(GENERAL_USER), FACILITY_2_ID)).toBe(false);

    await repositories.facilityAccess.save({ facilityId: FACILITY_2_ID, userIds: [GENERAL] });
    await repositories.facilityAccess.save({ facilityId: FACILITY_ID, userIds: [] });

    const scope = await service.scopeOf(GENERAL_USER);
    expect(canViewEquipment(scope, FACILITY_2_ID)).toBe(true);
    expect(canViewEquipment(scope, FACILITY_ID)).toBe(false);
  });
});

describe('設備の階層の絞り込み', () => {
  it('管理者は、そのまま。一般は、閲覧できるハウス（と配下）だけ。割り当てがなければ、空', async () => {
    const { service } = await setup([[FACILITY_2_ID, [GENERAL]]]);
    const tree = {
      facilities: [
        { facility: first(equipmentSet()), children: equipmentSet().slice(1) },
        { facility: first(secondHouseSet()), children: secondHouseSet().slice(1) },
      ],
    };

    expect(filterEquipmentTree(ALL_EQUIPMENT, tree)).toBe(tree);
    const limited = filterEquipmentTree(await service.scopeOf(GENERAL_USER), tree);
    expect(limited.facilities.map((item) => item.facility.equipmentId)).toEqual([FACILITY_2_ID]);
    expect(limited.facilities[0]?.children.map((item) => item.equipmentId)).toEqual([
      ROBOT_2_ID,
      secondHouseSet()[2]?.equipmentId,
    ]);
    const none = filterEquipmentTree(
      await service.scopeOf({ ...GENERAL_USER, userId: OTHER }),
      tree,
    );
    expect(none.facilities).toEqual([]);
  });
});
