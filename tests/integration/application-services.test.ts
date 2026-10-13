/** 判断基準・設備・ステータスコードの参照と、初期データの投入のテスト（サービス + ローカルの Repository）。 */

import { describe, expect, it, vi } from 'vitest';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import { createCriteriaService } from '../../src/backend/application/evaluation/criteria-service.ts';
import { createEquipmentService } from '../../src/backend/application/equipment/equipment-service.ts';
import { createStatusCodeService } from '../../src/backend/application/equipment/status-code-service.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import {
  INITIAL_STATUS_CODES,
  seedInitialStatusCodes,
} from '../../src/backend/application/seed/initial-data.ts';
import { getDefaultCriteria } from '../../src/backend/domain/evaluation/default-criteria.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import { equipmentSet, FACILITY_ID, ROBOT_ID } from '../support/builders.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';

/** 参照のみのテストで使わない依存（変更履歴・評価・時計・ログ）。 */
const UNUSED_DEPS = {
  audit: { record: vi.fn(), list: vi.fn() },
  evaluation: { evaluateAll: vi.fn(), evaluateAffected: vi.fn() },
  clock: createControllableClock(),
  logger: NULL_LOGGER,
};

describe('判断基準・設備・ステータスコードの参照', () => {
  it('判断基準は、変更後の値があればそれを、なければ既定値を返す', async () => {
    const { repositories } = createLocalRepositories();
    const service = createCriteriaService({ criteria: repositories.criteria });
    const custom = { ...getDefaultCriteria('safety'), isDefault: false, version: 'v2' };
    await repositories.criteria.save(custom);

    expect(await service.getEffective('safety')).toEqual(custom);
    expect(await service.getEffective('harvestSpeed')).toEqual(getDefaultCriteria('harvestSpeed'));
    const all = await service.getAllEffective();
    expect(all.size).toBe(10);
    expect(all.get('safety')?.version).toBe('v2');
  });

  it('設備の階層は、ハウスごとに配下を並べ、論理削除した設備を除く', async () => {
    const { repositories } = createLocalRepositories();
    const [facility, robot, sensor] = equipmentSet();
    if (facility === undefined || robot === undefined || sensor === undefined) {
      throw new Error('テストの前提');
    }
    const second = {
      ...facility,
      equipmentId: toEquipmentId('HOUSE-T2'),
      name: '2番目',
      createdAt: '2026-10-02T00:00:00.000Z',
    };
    for (const item of [
      second,
      sensor,
      { ...robot, isDeleted: true },
      facility,
      { ...sensor, equipmentId: toEquipmentId('SENSOR-T0'), createdAt: sensor.createdAt },
    ]) {
      await repositories.equipment.save(item);
    }

    const tree = await createEquipmentService({
      ...UNUSED_DEPS,
      equipment: repositories.equipment,
    }).getTree();

    expect(tree.facilities.map((entry) => entry.facility.equipmentId)).toEqual([
      FACILITY_ID,
      'HOUSE-T2',
    ]);
    expect(tree.facilities[0]?.children.map((child) => child.equipmentId)).toEqual([
      'SENSOR-T0',
      'SENSOR-T1',
    ]);
    expect(tree.facilities[1]?.children).toEqual([]);
    expect(
      tree.facilities
        .flatMap((entry) => entry.children)
        .some((child) => child.equipmentId === ROBOT_ID),
    ).toBe(false);
  });

  it('ステータスコードは、コード値の順に返し、論理削除を除く', async () => {
    const { repositories } = createLocalRepositories();
    await repositories.statusCodes.save({
      code: 'B',
      name: 'b',
      category: 'NORMAL',
      isDeleted: false,
    });
    await repositories.statusCodes.save({
      code: 'A_X',
      name: 'ax',
      category: 'NORMAL',
      isDeleted: false,
    });
    await repositories.statusCodes.save({
      code: 'A',
      name: 'a',
      category: 'NORMAL',
      isDeleted: false,
    });
    await repositories.statusCodes.save({
      code: 'C',
      name: 'c',
      category: 'NORMAL',
      isDeleted: true,
    });

    const list = await createStatusCodeService({
      audit: UNUSED_DEPS.audit,
      evaluation: UNUSED_DEPS.evaluation,
      logger: UNUSED_DEPS.logger,
      statusCodes: repositories.statusCodes,
    }).list();

    expect(list.items.map((item) => item.code)).toEqual(['A', 'A_X', 'B']);
  });

  it('ステータスコードの初期の定義は、1件もなければ投入し、あれば何もしない', async () => {
    const { repositories } = createLocalRepositories();

    expect(await seedInitialStatusCodes(repositories.statusCodes)).toBe(
      INITIAL_STATUS_CODES.length,
    );
    expect(await seedInitialStatusCodes(repositories.statusCodes)).toBe(0);
    expect(INITIAL_STATUS_CODES.map((definition) => definition.code)).toEqual([
      'STANDBY',
      'RUNNING',
      'HARVESTING',
      'STOPPED',
      'LOW_BATTERY',
      'RUNNING_ERROR',
      'HARVEST_ERROR',
      'FALLEN',
    ]);
  });
});
