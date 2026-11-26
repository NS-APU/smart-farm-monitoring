/**
 * 以前の論理削除済みの設備を、削除の要求に移す移行コマンド（`pnpm migrate-deleted-equipment`。Issue #229。D-28）の結合テスト。
 * 以前は、設備を削除しても、設備の記録・データが残った（論理削除）。設備のデータを削除するため、削除済みで残っている設備を、
 * 削除のジョブ（JB-05）が、削除できるように、削除の要求にする。DynamoDB は DynamoDB Local（実際の AWS には、接続しない）。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import { runMigrateDeletedEquipmentCli } from '../../src/backend/runtime/migrate-deleted-equipment-cli.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { equipmentSet, FACILITY_ID, must, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import {
  createDynamoTestDatabase,
  dropDynamoTestTables,
  dynamoTestClientOptions,
} from '../support/dynamodb-test-database.ts';

afterAll(dropDynamoTestTables);

function environment(extra: Record<string, string> = {}) {
  const database = createDynamoTestDatabase();
  const options = dynamoTestClientOptions();
  const env: Record<string, string> = {
    PERSISTENCE: 'dynamodb',
    DYNAMODB_ENDPOINT: options.endpoint ?? '',
    DYNAMODB_OBSERVATIONS_TABLE: database.tables.observations,
    DYNAMODB_MAIN_TABLE: database.tables.main,
    ...extra,
  };
  return { env, ready: database.ready };
}

function output() {
  const lines: string[] = [];
  return {
    lines,
    info: (message: string) => lines.push(`info: ${message}`),
    error: (message: string) => lines.push(`error: ${message}`),
  };
}

/** 移行前の状態: 削除済みのハウス（配下 2 件）と、削除済みの単独のセンサー、登録中のハウスと配下を作る。 */
async function seed(env: Record<string, string>) {
  const container = createContainer(parseConfig(env));
  try {
    const [facilityOrNone, robotOrNone, sensorOrNone] = equipmentSet();
    const facility = must(facilityOrNone);
    const robot = must(robotOrNone);
    const sensor = must(sensorOrNone);
    const second = toEquipmentId('HOUSE-T2');
    const records = [
      { ...facility, isDeleted: true },
      { ...robot, isDeleted: true },
      { ...sensor, isDeleted: true },
      { ...facility, equipmentId: second, name: '稼働中のハウス' },
      {
        ...sensor,
        equipmentId: toEquipmentId('SENSOR-T9'),
        facilityId: second,
        isDeleted: true,
      },
      { ...robot, equipmentId: toEquipmentId('ROBOT-T9'), facilityId: second },
    ];
    for (const record of records) {
      await container.repositories.equipment.save(record);
    }
  } finally {
    container.close();
  }
}

async function deletionsOf(env: Record<string, string>) {
  const container = createContainer(parseConfig(env));
  try {
    return (await container.repositories.equipmentDeletions.list()).map((deletion) => ({
      id: deletion.equipmentId,
      targets: deletion.targets.map((target) => target.equipmentId).sort(),
      phase: deletion.phase,
    }));
  } finally {
    container.close();
  }
}

describe('以前の論理削除済みの設備の、削除の要求への移行', () => {
  it('削除済みで残っている設備を、削除の要求にする（ハウスは配下と 1 件、ハウスが登録中の削除済みの設備は、単独で 1 件）', async () => {
    const { env, ready } = environment();
    await ready;
    await seed(env);
    const out = output();

    const exitCode = await runMigrateDeletedEquipmentCli(env, out);

    expect(exitCode).toBe(0);
    expect(out.lines).toEqual(['info: 削除済みの設備 4 件を、削除の要求 2 件にしました']);
    expect(await deletionsOf(env)).toEqual([
      { id: FACILITY_ID, targets: [FACILITY_ID, ROBOT_ID, SENSOR_ID].sort(), phase: 'PURGING' },
      { id: 'SENSOR-T9', targets: ['SENSOR-T9'], phase: 'PURGING' },
    ]);
  });

  it('何度実行しても同じ（すでに要求になっている設備、削除済みでない設備は、対象にしない）', async () => {
    const { env, ready } = environment();
    await ready;
    await seed(env);
    await runMigrateDeletedEquipmentCli(env, output());
    const out = output();

    const exitCode = await runMigrateDeletedEquipmentCli(env, out);

    expect(exitCode).toBe(0);
    expect(out.lines).toEqual([
      'info: 削除の要求にする設備は、ありませんでした。何もしませんでした',
    ]);
    expect(await deletionsOf(env)).toHaveLength(2);
  });

  it('MIGRATE_DRY_RUN=true なら、件数を示すだけで、書き込まない', async () => {
    const { env, ready } = environment();
    await ready;
    await seed(env);
    const out = output();

    const exitCode = await runMigrateDeletedEquipmentCli({ ...env, MIGRATE_DRY_RUN: 'true' }, out);

    expect(exitCode).toBe(0);
    expect(out.lines).toEqual([
      'info: 削除済みの設備 4 件を、削除の要求 2 件にします（MIGRATE_DRY_RUN=true のため、書き込んでいません）',
    ]);
    expect(await deletionsOf(env)).toEqual([]);
  });

  it('メモリの保存先は、移す対象が残らないため、拒否する。AWS のエラーは、名前だけを出力する', async () => {
    const memory = output();
    expect(await runMigrateDeletedEquipmentCli({ PERSISTENCE: 'memory' }, memory)).toBe(1);
    expect(memory.lines[0]).toContain('PERSISTENCE=dynamodb または file');

    const { env } = environment();
    const failed = output();
    const exitCode = await runMigrateDeletedEquipmentCli(env, failed, {
      createContainer: () => {
        throw Object.assign(new Error('arn:aws:dynamodb:dummy'), { name: 'AccessDeniedException' });
      },
    });
    expect(exitCode).toBe(1);
    expect(failed.lines.join('\n')).toContain('AccessDeniedException');
    expect(failed.lines.join('\n')).not.toContain('arn:aws');
  });
});
