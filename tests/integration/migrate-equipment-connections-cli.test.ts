/**
 * 設備ごとの接続への移行コマンド（`pnpm migrate-equipment-connections`。Issue #367。ADR-0026）の結合テスト。
 * 取り込み元の共通の接続を、ファイルのパスを持つ設備（削除されていない、ロボット・センサー）のうち、設備ごとの接続を持たないものへコピーする。
 * データは、一時ディレクトリのファイル（PERSISTENCE=file。実際の AWS には、接続しない。DynamoDB Local を使わず、手元で実行できる）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import { runMigrateEquipmentConnectionsCli } from '../../src/backend/runtime/migrate-equipment-connections-cli.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { equipmentSet, FACILITY_ID, must, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';

const CREATED_AT = '2026-10-09T03:00:00.000Z';
const SHARED_ROBOT_HOST = 'dummy-robot-files.example.invalid';
const SHARED_SENSOR_HOST = 'dummy-sensor-files.example.invalid';
const OWN_HOST = 'dummy-own-files.example.invalid';
const ROBOT_2_ID = toEquipmentId('ROBOT-T9');
const SENSOR_2_ID = toEquipmentId('SENSOR-T9');
const DELETED_ID = toEquipmentId('ROBOT-GONE');
const NO_PATH_ID = toEquipmentId('ROBOT-NOPATH');

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function environment(): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'sfm-migrate-equipment-connections-'));
  directories.push(directory);
  return { PERSISTENCE: 'file', DATA_FILE: join(directory, 'store.json') };
}

function output() {
  const lines: string[] = [];
  return {
    lines,
    info: (message: string) => lines.push(`info: ${message}`),
    error: (message: string) => lines.push(`error: ${message}`),
  };
}

function connection(host: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'HTTP' as const,
    protocol: 'HTTPS' as const,
    host,
    authMethod: 'NONE' as const,
    apiKeyHeaderName: 'X-API-Key',
    ...overrides,
  };
}

interface SeedOptions {
  /** 取り込み元（ロボット・センサー）の共通の接続。省略は、未設定。 */
  readonly sharedRobot?: boolean;
  readonly sharedSensor?: boolean;
}

/**
 * 移行前の状態: ハウス 1・ロボット 2（パスあり）・センサー 2（パスあり）・パスのないロボット 1・削除済みのロボット 1（パスあり）。
 * ロボット 2（ROBOT_2_ID）は、すでに設備ごとの接続を持つ。
 */
async function seed(env: Record<string, string>, options: SeedOptions = {}) {
  const container = createContainer(parseConfig(env));
  try {
    const { repositories } = container;
    const base = equipmentSet();
    const robot = must(base.find((item) => item.equipmentId === ROBOT_ID));
    const sensor = must(base.find((item) => item.equipmentId === SENSOR_ID));
    for (const equipment of [
      ...base.filter((item) => item.equipmentId === FACILITY_ID),
      { ...robot, sourceFilePath: '/dummy/robot-1.json' },
      { ...sensor, sourceFilePath: '/dummy/sensor-1.json' },
      {
        ...robot,
        equipmentId: ROBOT_2_ID,
        externalId: 'ROBOT-9',
        sourceFilePath: '/dummy/robot-9.json',
      },
      {
        ...sensor,
        equipmentId: SENSOR_2_ID,
        externalId: 'SENSOR-9',
        sourceFilePath: '/dummy/sensor-9.json',
      },
      { ...robot, equipmentId: NO_PATH_ID, externalId: 'ROBOT-NOPATH' },
      {
        ...robot,
        equipmentId: DELETED_ID,
        externalId: 'ROBOT-GONE',
        sourceFilePath: '/dummy/robot-gone.json',
        isDeleted: true,
      },
    ] satisfies Equipment[]) {
      await repositories.equipment.save({ ...equipment, createdAt: CREATED_AT });
    }
    const sources = await container.ingestionSettings.listSources();
    await container.ingestionSettings.saveSources(
      sources.map((source) => {
        if (source.kind === 'ROBOT' && options.sharedRobot === true) {
          return { ...source, connection: connection(SHARED_ROBOT_HOST, { authMethod: 'BEARER' }) };
        }
        if (source.kind === 'SENSOR' && options.sharedSensor === true) {
          return { ...source, connection: connection(SHARED_SENSOR_HOST) };
        }
        return source;
      }),
    );
    await container.equipmentConnections.save(ROBOT_2_ID, connection(OWN_HOST));
  } finally {
    container.close();
  }
}

async function connectionsOf(env: Record<string, string>) {
  const container = createContainer(parseConfig(env));
  try {
    return Object.fromEntries(await container.equipmentConnections.list());
  } finally {
    container.close();
  }
}

describe('共通の接続の、設備ごとの接続へのコピー', () => {
  it('既定（--yes なし）は、何も変えず、対象の件数を示す（ドライラン）', async () => {
    const env = environment();
    await seed(env, { sharedRobot: true, sharedSensor: true });
    const out = output();

    const exitCode = await runMigrateEquipmentConnectionsCli([], env, out);

    expect(exitCode).toBe(0);
    expect(out.lines).toHaveLength(1);
    // 対象の設備 4 件（ロボット 2・センサー 2。パスのない設備・削除済みの設備は、含めない）のうち、コピー 3 件・設定済み 1 件
    expect(out.lines[0]).toContain('取り込みの対象の設備 4 件');
    expect(out.lines[0]).toContain('コピーする設備 3 件');
    expect(out.lines[0]).toContain('設備ごとの接続が設定済みの設備 1 件');
    expect(out.lines[0]).toContain('共通の接続が未設定のため、コピーしない設備 0 件');
    expect(out.lines[0]).toContain('何も変えていません');
    expect(Object.keys(await connectionsOf(env))).toEqual([ROBOT_2_ID]);
  });

  it('--yes で、ファイルのパスを持つ設備に、種別が同じ取り込み元の共通の接続をコピーする。設備ごとの接続が設定済みの設備は、変えない', async () => {
    const env = environment();
    await seed(env, { sharedRobot: true, sharedSensor: true });
    const out = output();

    const exitCode = await runMigrateEquipmentConnectionsCli(['--yes'], env, out);

    expect(exitCode).toBe(0);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain('コピーしました（3 件）');
    const saved = await connectionsOf(env);
    expect(Object.keys(saved).sort()).toEqual(
      [ROBOT_ID, ROBOT_2_ID, SENSOR_ID, SENSOR_2_ID].sort(),
    );
    expect(saved[ROBOT_ID]).toMatchObject({ host: SHARED_ROBOT_HOST, authMethod: 'BEARER' });
    expect(saved[SENSOR_ID]).toMatchObject({ host: SHARED_SENSOR_HOST });
    expect(saved[SENSOR_2_ID]).toMatchObject({ host: SHARED_SENSOR_HOST });
    expect(saved[ROBOT_2_ID]).toMatchObject({ host: OWN_HOST });
  });

  it('何度実行しても同じ（2 回目は、コピーする設備が 0 件。取り込み元の共通の接続は、残る）', async () => {
    const env = environment();
    await seed(env, { sharedRobot: true, sharedSensor: true });
    await runMigrateEquipmentConnectionsCli(['--yes'], env, output());
    const first = await connectionsOf(env);
    const out = output();

    const exitCode = await runMigrateEquipmentConnectionsCli(['--yes'], env, out);

    expect(exitCode).toBe(0);
    expect(out.lines[0]).toContain('コピーする設備 0 件');
    expect(await connectionsOf(env)).toEqual(first);
    const container = createContainer(parseConfig(env));
    try {
      const sources = await container.ingestionSettings.listSources();
      expect(sources.map((source) => source.connection?.host)).toEqual([
        SHARED_ROBOT_HOST,
        SHARED_SENSOR_HOST,
      ]);
    } finally {
      container.close();
    }
  });

  it('共通の接続が未設定の種別は、スキップする（その種別の設備には、コピーしない）', async () => {
    const env = environment();
    await seed(env, { sharedRobot: true });
    const out = output();

    await runMigrateEquipmentConnectionsCli(['--yes'], env, out);

    const saved = await connectionsOf(env);
    expect(Object.keys(saved).sort()).toEqual([ROBOT_ID, ROBOT_2_ID].sort());
    expect(out.lines[0]).toContain('共通の接続が未設定のため、コピーしない設備 2 件');
    expect(out.lines[0]).toContain('コピーしました（1 件）');
  });

  it('共通の接続が、どちらも未設定なら、何もコピーしない', async () => {
    const env = environment();
    await seed(env);
    const out = output();

    const exitCode = await runMigrateEquipmentConnectionsCli(['--yes'], env, out);

    expect(exitCode).toBe(0);
    expect(out.lines[0]).toContain('コピーしました（0 件）');
    expect(Object.keys(await connectionsOf(env))).toEqual([ROBOT_2_ID]);
  });

  it('ファイルのパスのない設備・削除済みの設備・ハウスは、スキップする（接続を作らない）', async () => {
    const env = environment();
    await seed(env, { sharedRobot: true, sharedSensor: true });

    await runMigrateEquipmentConnectionsCli(['--yes'], env, output());

    const saved = await connectionsOf(env);
    expect(saved[NO_PATH_ID]).toBeUndefined();
    expect(saved[DELETED_ID]).toBeUndefined();
    expect(saved[FACILITY_ID]).toBeUndefined();
  });

  it('認証情報は、コピーしない（秘密情報の保管先を、書き換えない）。出力に、その旨（設備ごとに、画面から入力し直す）を示す', async () => {
    const env = environment();
    await seed(env, { sharedRobot: true, sharedSensor: true });
    const writes: unknown[][] = [];
    const deps = {
      createContainer: (config: Parameters<typeof createContainer>[0]) => {
        const container = createContainer(config);
        vi.spyOn(container.secrets, 'set').mockImplementation((...args) => {
          writes.push(args);
          return Promise.resolve();
        });
        return container;
      },
    };
    const dryRun = output();
    const executed = output();

    await runMigrateEquipmentConnectionsCli([], env, dryRun, deps);
    await runMigrateEquipmentConnectionsCli(['--yes'], env, executed, deps);

    expect(writes).toEqual([]);
    for (const out of [dryRun, executed]) {
      expect(out.lines[0]).toContain('認証情報は、コピー');
      expect(out.lines[0]).toContain('入力し直');
    }
  });

  it('出力は、件数だけ（ホスト名・設備の ID・パスを出さない）', async () => {
    const env = environment();
    await seed(env, { sharedRobot: true, sharedSensor: true });
    const dryRun = output();
    const executed = output();

    await runMigrateEquipmentConnectionsCli([], env, dryRun);
    await runMigrateEquipmentConnectionsCli(['--yes'], env, executed);

    const text = [...dryRun.lines, ...executed.lines].join('\n');
    for (const value of [
      SHARED_ROBOT_HOST,
      SHARED_SENSOR_HOST,
      OWN_HOST,
      ROBOT_ID,
      SENSOR_ID,
      '/dummy/',
      'example.invalid',
    ]) {
      expect(text).not.toContain(value);
    }
  });
});

describe('設定のエラー', () => {
  it('PERSISTENCE が memory（既定）なら、設定エラー（終了コード 1。何もしない）', async () => {
    const out = output();

    const exitCode = await runMigrateEquipmentConnectionsCli(['--yes'], {}, out);

    expect(exitCode).toBe(1);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain('PERSISTENCE=dynamodb または file');
  });

  it('指定できない引数は、使い方を示して、終了コード 1（何も変えない）', async () => {
    const env = environment();
    await seed(env, { sharedRobot: true });
    const out = output();

    const exitCode = await runMigrateEquipmentConnectionsCli(['--force'], env, out);

    expect(exitCode).toBe(1);
    expect(out.lines[0]).toContain('使い方: pnpm migrate-equipment-connections');
    expect(Object.keys(await connectionsOf(env))).toEqual([ROBOT_2_ID]);
  });

  it('保管先の失敗は、メッセージ（接続先・ARN を含みうる）でなく、エラーの名前だけを出力する（終了コード 1）', async () => {
    const out = output();
    const failure = Object.assign(
      new Error('arn:aws:dynamodb:dummy-region:000000000000:table/dummy'),
      {
        name: 'AccessDeniedException',
      },
    );

    const exitCode = await runMigrateEquipmentConnectionsCli(['--yes'], environment(), out, {
      createContainer: () => {
        throw failure;
      },
    });

    expect(exitCode).toBe(1);
    expect(out.lines[0]).toContain('AccessDeniedException');
    expect(out.lines[0]).not.toContain('arn:aws');
    expect(out.lines[0]).not.toContain('000000000000');
  });
});
