/**
 * 取り込みログのハウス別の内訳（Issue #332。ADR-0013。一般ユーザーに、閲覧できるハウスの分だけを見せるため）の結合テスト。
 * 取り込みの結果を、ハウスごとに記録する。ハウスに結びつけられない結果（接続の失敗・設備に結びつかないファイルの失敗）は、記録しない
 * （全設備を閲覧できる利用者だけが、全体のログで見る）。
 */

import { describe, expect, it, vi } from 'vitest';
import { createIngestionService } from '../../src/backend/application/ingestion/ingestion-service.ts';
import { createIngestionSettings } from '../../src/backend/application/ingestion/ingestion-settings.ts';
import {
  FileSourceUnavailableError,
  type FileSourcePort,
} from '../../src/backend/application/ports/file-source-port.ts';
import {
  FormatError,
  type FormatProfile,
} from '../../src/backend/application/ports/format-profile.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { DEFAULT_APP_SETTINGS } from '../../src/backend/application/settings.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import { equipmentSet, FACILITY_ID, FACILITY_2_ID, secondHouseSet } from '../support/builders.ts';
import { STUB_MODIFIED_AT } from '../support/test-constants.ts';
import { TEST_NOW } from '../support/test-context.ts';

const ROBOT_FILE = '/robots/robot-1.json';
const ROBOT_2_FILE = '/robots/robot-2.json';

/** 2 つのハウスのロボットを読み取る、取り込み元のスタブ。ファイルの内容は、'BROKEN' のとき形式違い。 */
function build(options: { files: Record<string, string>; listFails?: boolean }) {
  const { repositories } = createLocalRepositories();
  const fileSource: FileSourcePort = {
    testConnection: () => Promise.resolve(),
    listFiles: () =>
      options.listFails === true
        ? Promise.reject(new FileSourceUnavailableError('接続できません'))
        : Promise.resolve(
            Object.keys(options.files).map((name) => ({
              fileId: name,
              name,
              modifiedAt: STUB_MODIFIED_AT,
              sizeBytes: 1,
            })),
          ),
    readFile: (_sourceId, fileId) => Promise.resolve(options.files[fileId] ?? ''),
  };
  const profile: FormatProfile = {
    profileId: 'robot-json',
    version: 'test',
    status: 'PROVISIONAL',
    versionLabel: 'robot-json@test(PROVISIONAL)',
    parse: (content) => {
      if (content === 'BROKEN') {
        throw new FormatError('形式が違います');
      }
      return {
        records: content
          .split(',')
          .filter((externalId) => externalId !== '')
          .map((externalId) => ({
            externalId,
            observedAt: '2026-10-09T01:00:00Z',
            fields: { harvestCount: 2 },
          })),
        rejectedCount: 0,
      };
    },
  };
  const service = createIngestionService({
    repositories,
    ingestionSettings: createIngestionSettings(repositories.settings),
    fileSource,
    profiles: { get: () => profile },
    evaluation: {
      evaluateAll: vi.fn().mockResolvedValue({}),
      evaluateAffected: vi.fn().mockResolvedValue({}),
    },
    notifications: {
      notifyStatusChange: vi.fn(),
      notifyIngestionFailure: vi.fn().mockResolvedValue(null),
      notifyFederationExpired: vi.fn(),
      list: vi.fn(),
      unreadCount: vi.fn(),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      addMemo: vi.fn(),
      listMemos: vi.fn(),
      deliverPending: vi.fn(),
    },
    federation: { enqueue: vi.fn().mockResolvedValue(undefined), runPending: vi.fn() },
    clock: createControllableClock(TEST_NOW),
    ids: createSequentialIdGenerator(),
    settings: { ...DEFAULT_APP_SETTINGS.ingestion, retryBaseDelayMs: 0 },
    logger: NULL_LOGGER,
  });
  return { service, repositories };
}

async function seedEquipment(repositories: ReturnType<typeof build>['repositories']) {
  for (const equipment of [...equipmentSet(), ...secondHouseSet()]) {
    await repositories.equipment.save(
      equipment.equipmentId === 'ROBOT-T1'
        ? { ...equipment, sourceFilePath: ROBOT_FILE }
        : equipment.equipmentId === 'ROBOT-T2'
          ? { ...equipment, sourceFilePath: ROBOT_2_FILE }
          : equipment,
    );
  }
}

async function robotLogs(repositories: ReturnType<typeof build>['repositories']) {
  return (await repositories.ingestion.listLogs({ sourceId: 'robot' }, { limit: 20 })).items;
}

/** ロボットの取り込みの、ハウスごとの内訳（設備ごとのログ〔Issue #201〕の内訳を、ハウスごとに合わせる）。 */
async function facilitiesOfRobotLogs(repositories: ReturnType<typeof build>['repositories']) {
  const page = await repositories.ingestion.listLogs({ sourceId: 'robot' }, { limit: 20 });
  const byFacility = new Map<string, { facilityId: string; result: string; recordCount: number }>();
  for (const entry of page.items.flatMap((log) => log.facilities ?? [])) {
    const current = byFacility.get(entry.facilityId);
    byFacility.set(entry.facilityId, {
      facilityId: entry.facilityId,
      result: current?.result === 'FAILURE' || entry.result === 'FAILURE' ? 'FAILURE' : 'SUCCESS',
      recordCount: (current?.recordCount ?? 0) + entry.recordCount,
    });
  }
  return [...byFacility.values()];
}

describe('取り込みログのハウス別の内訳（#332）', () => {
  it('1 つのファイルに 2 つのハウスの設備のデータがあれば、ハウスごとに、取り込んだ件数を記録する', async () => {
    const { service, repositories } = build({
      files: { [ROBOT_FILE]: 'ROBOT-SAMPLE-01,ROBOT-SAMPLE-01,ROBOT-SAMPLE-02' },
    });
    await seedEquipment(repositories);

    await service.runSource('robot');

    const facilities = await facilitiesOfRobotLogs(repositories);
    expect(facilities).toEqual(
      expect.arrayContaining([
        { facilityId: FACILITY_ID, result: 'SUCCESS', recordCount: 2 },
        { facilityId: FACILITY_2_ID, result: 'SUCCESS', recordCount: 1 },
      ]),
    );
    expect(facilities).toHaveLength(2);
  });

  it('形式違いのファイルは、そのファイルのパスをもつ設備のハウスの失敗として記録し、他のハウスの成功は、そのまま記録する', async () => {
    const { service, repositories } = build({
      files: { [ROBOT_FILE]: 'BROKEN', [ROBOT_2_FILE]: 'ROBOT-SAMPLE-02' },
    });
    await seedEquipment(repositories);

    const summary = await service.runSource('robot');

    expect(summary.result).toBe('PARTIAL');
    const facilities = await facilitiesOfRobotLogs(repositories);
    expect(facilities).toEqual(
      expect.arrayContaining([
        { facilityId: FACILITY_ID, result: 'FAILURE', recordCount: 0 },
        { facilityId: FACILITY_2_ID, result: 'SUCCESS', recordCount: 1 },
      ]),
    );
    expect(facilities).toHaveLength(2);
  });

  it('同じハウスに、成功したファイルと失敗したファイルがあれば、結果は失敗、件数は成功した分', async () => {
    const { service, repositories } = build({
      files: { [ROBOT_FILE]: 'BROKEN', '/robots/extra.json': 'ROBOT-SAMPLE-01' },
    });
    await seedEquipment(repositories);

    await service.runSource('robot');

    expect(await facilitiesOfRobotLogs(repositories)).toEqual([
      { facilityId: FACILITY_ID, result: 'FAILURE', recordCount: 1 },
    ]);
  });

  it('設備に結びつかないファイルの失敗は、ハウスの内訳に含めない（全設備を閲覧できる利用者だけが、全体のログで見る）', async () => {
    const { service, repositories } = build({ files: { '/robots/unknown.json': 'BROKEN' } });
    await seedEquipment(repositories);

    await service.runSource('robot');

    // 設備に結びつかないため、取り込み元単位のログ（設備の指定なし。Issue #201）
    const logs = await robotLogs(repositories);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ result: 'FAILURE', filesProcessed: 1 });
    expect(logs[0]?.equipmentId).toBeUndefined();
    expect(logs[0]?.facilities ?? []).toEqual([]);
  });

  it('ファイルサーバーに接続できない失敗は、ハウスの内訳に含めない', async () => {
    const { service, repositories } = build({ files: {}, listFails: true });
    await seedEquipment(repositories);

    await service.runSource('robot');

    const logs = await robotLogs(repositories);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ result: 'FAILURE', errorMessage: expect.any(String) });
    expect(logs[0]?.facilities ?? []).toEqual([]);
  });

  it('新しいファイルがない取り込み（0 件）は、ログに残さない（ハウスの内訳もない。Issue #201）', async () => {
    const { service, repositories } = build({ files: {} });
    await seedEquipment(repositories);

    await service.runSource('robot');

    expect(await robotLogs(repositories)).toEqual([]);
  });

  it('ハウス別の一覧には、ログの内訳が、そのハウスの分だけ載る', async () => {
    const { service, repositories } = build({
      files: { [ROBOT_FILE]: 'ROBOT-SAMPLE-01', [ROBOT_2_FILE]: 'BROKEN' },
    });
    await seedEquipment(repositories);

    await service.runSource('robot');

    const first = await repositories.ingestion.listFacilityLogs([FACILITY_ID], { limit: 10 });
    const second = await repositories.ingestion.listFacilityLogs([FACILITY_2_ID], { limit: 10 });
    expect(first.items).toMatchObject([
      { facilityId: FACILITY_ID, sourceId: 'robot', result: 'SUCCESS', recordCount: 1 },
    ]);
    expect(second.items).toMatchObject([
      { facilityId: FACILITY_2_ID, sourceId: 'robot', result: 'FAILURE', recordCount: 0 },
    ]);
  });
});
