/**
 * 設備ごとの取得間隔での取り込み（Issue #197。ADR-0016 の D-11）の結合テスト。
 * 取り込みのジョブ（JB-01。1 分ごとに起動）が、設備ごとに、「最終の開始から、その設備の取得間隔が過ぎたか」を判定し、
 * 間隔が来た設備のファイルだけを取り込む（HTTP は、設備ごとのファイル）。未設定の間隔は、種別ごとの既定（ロボット 1 分・センサー 5 分）。
 * モック・S3（1 つのファイルに複数の設備が入る）は、その取り込み元の設備のどれかの間隔が来たら、ファイル全体を取り込む。
 */

import { describe, expect, it, vi } from 'vitest';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { IngestionSource } from '@smart-farm/shared/schemas/ingestion';
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
import { equipmentSet, ROBOT_2_ID, ROBOT_ID, secondHouseSet } from '../support/builders.ts';
import { STUB_MODIFIED_AT } from '../support/test-constants.ts';
import { TEST_NOW } from '../support/test-context.ts';

const MS = 1000;
const MINUTE = 60 * MS;

const ROBOT_1_FILE = '/robots/robot-1.json';
const ROBOT_2_FILE = '/robots/robot-2.json';
const SENSOR_1_FILE = '/sensors/sensor-1.json';

const HTTP_CONNECTION: IngestionSource['connection'] = {
  type: 'HTTP',
  protocol: 'HTTPS',
  host: 'files.example.invalid',
  authMethod: 'NONE',
  apiKeyHeaderName: 'X-API-Key',
};

interface ListCall {
  readonly sourceId: string;
  readonly paths: readonly string[] | undefined;
}

/**
 * 取り込みサービス。ファイルソースは、一覧の問い合わせ（取り込み元・ファイルパスの指定）を記録するスタブ。
 * 設備: ロボット 1（間隔の指定なし = 既定 1 分）・ロボット 2（5 分）・センサー 1（指定なし = 既定 5 分）。
 */
async function build(options: {
  connection: IngestionSource['connection'];
  intervals?: boolean;
  /** ファイルの置き換え（パス → 内容の設備の識別子。`+` で区切ると、1 つのファイルに複数の設備）。省略は、既定の 3 ファイル。 */
  files?: Record<string, string>;
  /** 記録の項目の値（既定は、収穫数 2）。不正な値を試すとき。 */
  fields?: Record<string, number | string>;
  /** 形式が仕様と異なる（解釈できない）ファイルのパス。 */
  brokenFiles?: readonly string[];
}) {
  const { repositories } = createLocalRepositories();
  const clock = createControllableClock(TEST_NOW);
  const listCalls: ListCall[] = [];
  /** true の間は、ファイルの一覧の取得が、接続できずに失敗する。 */
  const control = { listFails: false };
  const files: Record<string, string> = options.files ?? {
    [ROBOT_1_FILE]: 'ROBOT-SAMPLE-01',
    [ROBOT_2_FILE]: 'ROBOT-SAMPLE-02',
    [SENSOR_1_FILE]: 'SENSOR-SAMPLE-01',
  };
  const fileSource: FileSourcePort = {
    testConnection: () => Promise.resolve(),
    listFiles: (sourceId, listOptions) => {
      listCalls.push({ sourceId, paths: listOptions?.paths });
      if (control.listFails) {
        return Promise.reject(new FileSourceUnavailableError('接続できません'));
      }
      const names = listOptions?.paths ?? Object.keys(files);
      return Promise.resolve(
        names
          .filter((name) => name in files)
          .map((name) => ({ fileId: name, name, modifiedAt: STUB_MODIFIED_AT, sizeBytes: 1 })),
      );
    },
    // 内容は、時刻ごとに変える（同じ内容は、取り込み済みとして、読み飛ばすため）
    readFile: (_sourceId, fileId) =>
      Promise.resolve(
        `${files[fileId] ?? ''}@${options.brokenFiles?.includes(fileId) === true ? `broken:${fileId}:` : ''}${String(clock.now().getTime())}`,
      ),
  };
  const profile: FormatProfile = {
    profileId: 'robot-json',
    version: 'test',
    status: 'PROVISIONAL',
    versionLabel: 'robot-json@test(PROVISIONAL)',
    parse: (content) => {
      const [names = '', marker = ''] = content.split('@');
      if (options.brokenFiles?.some((broken) => marker.startsWith(`broken:${broken}`))) {
        throw new FormatError('形式が仕様と異なります');
      }
      return {
        records: names.split('+').map((externalId) => ({
          externalId,
          observedAt: '2026-10-09T01:00:00Z',
          fields: options.fields ?? { harvestCount: 2 },
        })),
        rejectedCount: 0,
      };
    },
  };
  const ingestionSettings = createIngestionSettings(repositories.settings);
  await ingestionSettings.saveSources(
    (await ingestionSettings.listSources()).map((source) => ({
      ...source,
      connection: options.connection,
    })),
  );
  const equipment: Equipment[] = [...equipmentSet(), ...secondHouseSet()].map((item) => {
    const extra: Partial<Equipment> =
      item.equipmentId === ROBOT_ID
        ? { sourceFilePath: ROBOT_1_FILE }
        : item.equipmentId === ROBOT_2_ID
          ? { sourceFilePath: ROBOT_2_FILE, intervalMinutes: 5 }
          : item.equipmentId === 'SENSOR-T1'
            ? { sourceFilePath: SENSOR_1_FILE }
            : {};
    return { ...item, ...extra };
  });
  for (const item of equipment) {
    await repositories.equipment.save(item);
  }
  const service = createIngestionService({
    repositories,
    ingestionSettings,
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
    federation: {
      enqueue: vi.fn().mockResolvedValue(undefined),
      runPending: vi.fn(),
      enqueueAllEquipment: vi.fn(),
    },
    clock,
    ids: createSequentialIdGenerator(),
    settings: {
      ...DEFAULT_APP_SETTINGS.ingestion,
      retryBaseDelayMs: 0,
      stopNotificationEnabled: false,
    },
    logger: NULL_LOGGER,
  });
  /** 時刻を進めて、ジョブを実行し、その実行で問い合わせたファイルの一覧（取り込み元ごと）を返す。 */
  async function runAfter(milliseconds: number) {
    clock.advance(milliseconds);
    const before = listCalls.length;
    const summaries = await service.runDueSources();
    return {
      sources: summaries.map((summary) => summary.sourceId).sort(),
      calls: listCalls.slice(before),
    };
  }
  return { service, repositories, clock, listCalls, runAfter, control };
}

const pathsOf = (calls: readonly ListCall[], sourceId: string): string[] | undefined =>
  calls
    .find((call) => call.sourceId === sourceId)
    ?.paths?.slice()
    .sort();

describe('接続方式 HTTP（設備ごとのファイル）', () => {
  it('初回は、取り込みの記録がない設備を、すべて取り込む。以後は、設備ごとの間隔が来た設備のファイルだけを取り込む', async () => {
    const { runAfter } = await build({ connection: HTTP_CONNECTION });

    const first = await runAfter(0);
    const after1 = await runAfter(MINUTE);
    const after2 = await runAfter(MINUTE);
    const after5 = await runAfter(3 * MINUTE);

    // 初回: ロボット 2 台・センサー 1 台のファイルを、すべて
    expect(first.sources).toEqual(['environment-sensor', 'robot']);
    expect(pathsOf(first.calls, 'robot')).toEqual([ROBOT_1_FILE, ROBOT_2_FILE]);
    expect(pathsOf(first.calls, 'environment-sensor')).toEqual([SENSOR_1_FILE]);
    // 1 分後: ロボット 1（既定 1 分）のファイルだけ。センサー（5 分）は、取り込み元ごと、動かさない
    expect(after1.sources).toEqual(['robot']);
    expect(pathsOf(after1.calls, 'robot')).toEqual([ROBOT_1_FILE]);
    expect(after2.sources).toEqual(['robot']);
    expect(pathsOf(after2.calls, 'robot')).toEqual([ROBOT_1_FILE]);
    // 5 分後: ロボット 1（前回から 3 分以上）・ロボット 2（5 分）・センサー（5 分）が、すべて来る
    expect(after5.sources).toEqual(['environment-sensor', 'robot']);
    expect(pathsOf(after5.calls, 'robot')).toEqual([ROBOT_1_FILE, ROBOT_2_FILE]);
    expect(pathsOf(after5.calls, 'environment-sensor')).toEqual([SENSOR_1_FILE]);
  });

  it('間隔が来ていない設備のファイルは、一覧の問い合わせにも含めない。どの設備も来ていない取り込み元は、問い合わせない', async () => {
    const { runAfter } = await build({ connection: HTTP_CONNECTION });
    await runAfter(0);

    const after30s = await runAfter(30 * MS);

    expect(after30s.sources).toEqual([]);
    expect(after30s.calls).toEqual([]);
  });

  it('起動のずれを許す: 間隔の 5 秒前までに起動されても、間隔が来たものとして扱う。それより早ければ、扱わない', async () => {
    const { runAfter } = await build({ connection: HTTP_CONNECTION });
    await runAfter(0);

    const early = await runAfter(54 * MS);
    const slightlyEarly = await runAfter(2 * MS); // 前回の起動（初回）から 56 秒
    const tooEarly = await runAfter(54 * MS); // 前回の起動から 54 秒

    expect(early.sources).toEqual([]);
    expect(slightlyEarly.sources).toEqual(['robot']);
    expect(tooEarly.sources).toEqual([]);
  });

  it('取得間隔を変えると、次の判定から、反映される（設備ごとの設定 intervalMinutes）', async () => {
    const { runAfter, repositories } = await build({ connection: HTTP_CONNECTION });
    const robot = await repositories.equipment.get(ROBOT_ID);
    if (robot === undefined) {
      throw new Error('テストの前提');
    }
    await runAfter(0);
    await repositories.equipment.save({ ...robot, intervalMinutes: 30 });

    const after5 = await runAfter(5 * MINUTE);
    const after30 = await runAfter(25 * MINUTE);

    // 5 分後: ロボット 1 は、30 分に変えたため、来ていない。ロボット 2（5 分）・センサー（5 分）は、来ている
    expect(pathsOf(after5.calls, 'robot')).toEqual([ROBOT_2_FILE]);
    expect(pathsOf(after30.calls, 'robot')).toContain(ROBOT_1_FILE);
  });

  it('ファイルパスのない設備・削除済みの設備は、取り込まない（取り込みの記録も、更新しない）', async () => {
    const { runAfter, repositories } = await build({ connection: HTTP_CONNECTION });
    const robot2 = await repositories.equipment.get(ROBOT_2_ID);
    if (robot2 === undefined) {
      throw new Error('テストの前提');
    }
    await repositories.equipment.save({ ...robot2, sourceFilePath: undefined });
    const robot1 = await repositories.equipment.get(ROBOT_ID);
    if (robot1 === undefined) {
      throw new Error('テストの前提');
    }
    await repositories.equipment.save({ ...robot1, isDeleted: true });

    const first = await runAfter(0);

    // ロボットのファイルは、どちらも対象外（パスなし・削除済み）。ロボットの取り込み元は、動かさない
    expect(first.sources).toEqual(['environment-sensor']);
    const states = await repositories.ingestion.listEquipmentRuns();
    expect([...states.keys()]).toEqual(['SENSOR-T1']);
  });

  it('接続できなかった場合も、開始の日時を更新する（間隔が来るまで、再試行しない）', async () => {
    const { runAfter, control, repositories } = await build({ connection: HTTP_CONNECTION });
    control.listFails = true;

    const failed = await runAfter(0);
    const retryTooSoon = await runAfter(30 * MS);
    control.listFails = false;
    const retry = await runAfter(30 * MS);

    expect(failed.sources).toEqual(['environment-sensor', 'robot']);
    expect((await repositories.ingestion.listEquipmentRuns()).size).toBe(3);
    expect(retryTooSoon.sources).toEqual([]);
    expect(retry.sources).toEqual(['robot']);
  });

  it('即時取得（runSource）は、間隔に関係なく、その取り込み元のすべての設備を取り込み、開始の日時を更新する。そのあとの、定期の実行は、間隔が来るまで、動かない', async () => {
    const { service, runAfter, listCalls, repositories } = await build({
      connection: HTTP_CONNECTION,
    });

    await service.runSource('robot');
    const states = await repositories.ingestion.listEquipmentRuns();
    const immediately = await runAfter(0);

    // 手動: ファイルパスの指定なし（すべての設備のファイル）
    expect(listCalls[0]).toEqual({ sourceId: 'robot', paths: undefined });
    expect([...states.keys()].sort()).toEqual(['ROBOT-T1', 'ROBOT-T2']);
    // 定期: ロボットは、いま取り込んだため、来ていない。センサーは、まだ取り込んでいないため、動く
    expect(immediately.sources).toEqual(['environment-sensor']);
  });

  it('無効にした取り込み元は、動かさず、その設備の記録も、更新しない', async () => {
    const { runAfter, repositories } = await build({ connection: HTTP_CONNECTION });
    const settings = createIngestionSettings(repositories.settings);
    await settings.saveSources(
      (await settings.listSources()).map((source) => ({
        ...source,
        isEnabled: source.sourceId === 'robot',
      })),
    );

    const first = await runAfter(0);

    expect(first.sources).toEqual(['robot']);
    expect([...(await repositories.ingestion.listEquipmentRuns()).keys()].sort()).toEqual([
      'ROBOT-T1',
      'ROBOT-T2',
    ]);
  });
});

describe('接続方式 MOCK（モック・S3。1 つのファイルに、複数の設備が入る）', () => {
  it('その取り込み元の設備の、どれかの間隔が来たら、ファイル全体を取り込む（ファイルパスは指定しない）。すべての設備の開始の日時を更新する', async () => {
    const { runAfter, repositories } = await build({ connection: { type: 'MOCK' } });

    const first = await runAfter(0);
    const after1 = await runAfter(MINUTE);
    const after2 = await runAfter(MINUTE);

    // ロボット 1（既定 1 分）が、毎分来るため、ロボットの取り込み元は、毎分動く。センサー（5 分）は、動かない
    expect(first.sources).toEqual(['environment-sensor', 'robot']);
    expect(first.calls).toEqual([
      { sourceId: 'robot', paths: undefined },
      { sourceId: 'environment-sensor', paths: undefined },
    ]);
    expect(after1.sources).toEqual(['robot']);
    expect(after2.sources).toEqual(['robot']);
    const states = await repositories.ingestion.listEquipmentRuns();
    expect(states.get('ROBOT-T2')?.startedAt.toISOString()).toBe(
      new Date(TEST_NOW.getTime() + 2 * MINUTE).toISOString(),
    );
  });

  it('設備の間隔が、すべて長ければ、その最短の間隔まで、動かさない（ロボット 1 を 30 分にすれば、ロボットの取り込み元は、最短の 5 分）', async () => {
    const { runAfter, repositories } = await build({ connection: { type: 'MOCK' } });
    const robot = await repositories.equipment.get(ROBOT_ID);
    if (robot === undefined) {
      throw new Error('テストの前提');
    }
    await repositories.equipment.save({ ...robot, intervalMinutes: 30 });
    await runAfter(0);

    const after1 = await runAfter(MINUTE);
    const after5 = await runAfter(4 * MINUTE);

    expect(after1.sources).toEqual([]);
    expect(after5.sources).toEqual(['environment-sensor', 'robot']);
  });

  it('設備が 1 つもない種別の取り込み元は、種別ごとの既定の間隔（ロボット 1 分）で、動かす（未登録の記録を、棄却として数えるため）', async () => {
    const { runAfter, repositories } = await build({ connection: { type: 'MOCK' } });
    for (const id of [ROBOT_ID, ROBOT_2_ID]) {
      const item = await repositories.equipment.get(id);
      if (item !== undefined) {
        await repositories.equipment.save({ ...item, isDeleted: true });
      }
    }
    await runAfter(0);

    const after30s = await runAfter(30 * MS);
    const after1 = await runAfter(30 * MS);

    expect(after30s.sources).toEqual([]);
    expect(after1.sources).toEqual(['robot']);
  });
});

describe('取り込みログは、設備ごと。空振りは残さず、設備ごとの最終の実行を持つ（Issue #201。ADR-0016 の D-48）', () => {
  const logsOf = async (repositories: Awaited<ReturnType<typeof build>>['repositories']) =>
    (await repositories.ingestion.listLogs({}, { limit: 50 })).items;

  it('新しいデータがあった設備ごとに、ログを 1 件ずつ残す（設備・取り込み元・件数・結果・ハウス）', async () => {
    const { runAfter, repositories } = await build({ connection: HTTP_CONNECTION });

    await runAfter(0);

    const logs = (await logsOf(repositories)).sort((left, right) =>
      String(left.equipmentId).localeCompare(String(right.equipmentId)),
    );
    expect(logs.map((log) => [log.equipmentId, log.sourceId, log.result, log.recordCount])).toEqual(
      [
        ['ROBOT-T1', 'robot', 'SUCCESS', 1],
        ['ROBOT-T2', 'robot', 'SUCCESS', 1],
        ['SENSOR-T1', 'environment-sensor', 'SUCCESS', 1],
      ],
    );
    expect(logs[0]).toMatchObject({
      filesProcessed: 1,
      rejectedCount: 0,
      facilities: [{ result: 'SUCCESS', recordCount: 1 }],
    });
  });

  it('空振り（新しいデータがない成功）は、ログに残さない。設備ごとの最終の実行（開始・終了・結果）は、更新し、最後にデータが取れた日時は、そのまま', async () => {
    const { runAfter, repositories } = await build({ connection: HTTP_CONNECTION });
    await runAfter(0);
    const firstLogs = (await logsOf(repositories)).length;

    // 1 分後: ロボット 1（既定 1 分）が動く。ファイルの内容は変わったが、観測値（同じ計測日時・同じ値）は同じ
    await runAfter(MINUTE);

    expect(await logsOf(repositories)).toHaveLength(firstLogs);
    const state = (await repositories.ingestion.listEquipmentRuns()).get('ROBOT-T1');
    expect(state?.startedAt.toISOString()).toBe(
      new Date(TEST_NOW.getTime() + MINUTE).toISOString(),
    );
    expect(state?.result).toBe('SUCCESS');
    expect(state?.lastDataAt?.toISOString()).toBe(TEST_NOW.toISOString());
  });

  it('接続できない失敗は、設備に結びつかないため、取り込み元ごとに 1 件（設備の指定なし）。設備ごとの最終の実行は、失敗にする', async () => {
    const { runAfter, control, repositories } = await build({ connection: HTTP_CONNECTION });
    control.listFails = true;

    await runAfter(0);

    const logs = await logsOf(repositories);
    expect(logs.map((log) => [log.sourceId, log.equipmentId, log.result]).sort()).toEqual([
      ['environment-sensor', undefined, 'FAILURE'],
      ['robot', undefined, 'FAILURE'],
    ]);
    const states = await repositories.ingestion.listEquipmentRuns();
    expect([...states.values()].map((state) => state.result)).toEqual([
      'FAILURE',
      'FAILURE',
      'FAILURE',
    ]);
    expect(states.get('ROBOT-T1')?.lastSucceededAt).toBeNull();
  });

  it('設備のファイルが形式違いなら、その設備のログ（失敗）を残す。ほかの設備は、成功のログ', async () => {
    const { runAfter, repositories } = await build({
      connection: HTTP_CONNECTION,
      brokenFiles: [ROBOT_2_FILE],
    });

    await runAfter(0);

    const logs = await logsOf(repositories);
    const robot2 = logs.find((log) => log.equipmentId === ROBOT_2_ID);
    expect(robot2).toMatchObject({ result: 'FAILURE', sourceId: 'robot', recordCount: 0 });
    expect(robot2?.errorMessage).toContain('1件のファイル');
    expect(logs.find((log) => log.equipmentId === ROBOT_ID)?.result).toBe('SUCCESS');
    expect((await repositories.ingestion.listEquipmentRuns()).get('ROBOT-T2')?.result).toBe(
      'FAILURE',
    );
    expect((await repositories.ingestion.listEquipmentRuns()).get('ROBOT-T1')?.result).toBe(
      'SUCCESS',
    );
  });

  it('1 つのファイルに複数の設備が入る（モック・S3）ときは、設備ごとのログに件数を分ける。どの設備にも結びつかない記録は、取り込み元単位のログ（一部成功）に数える', async () => {
    const { runAfter, repositories } = await build({
      connection: { type: 'MOCK' },
      files: { '/all.json': 'ROBOT-SAMPLE-01+ROBOT-SAMPLE-02+UNKNOWN-ROBOT' },
    });

    await runAfter(0);

    const robotLogs = (await logsOf(repositories)).filter((log) => log.sourceId === 'robot');
    const byEquipment = robotLogs
      .filter((log) => log.equipmentId !== undefined)
      .map((log) => [log.equipmentId, log.recordCount, log.result])
      .sort();
    expect(byEquipment).toEqual([
      ['ROBOT-T1', 1, 'SUCCESS'],
      ['ROBOT-T2', 1, 'SUCCESS'],
    ]);
    const unlinked = robotLogs.filter((log) => log.equipmentId === undefined);
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toMatchObject({ result: 'PARTIAL', recordCount: 0, rejectedCount: 1 });
  });

  it('設備が 1 つもない取り込み元は、取り込み元ごとの最終の開始日時を持つ（取得間隔の判定に使う）', async () => {
    const { runAfter, repositories } = await build({ connection: { type: 'MOCK' } });
    for (const id of [ROBOT_ID, ROBOT_2_ID]) {
      const item = await repositories.equipment.get(id);
      if (item !== undefined) {
        await repositories.equipment.save({ ...item, isDeleted: true });
      }
    }

    await runAfter(0);

    expect((await repositories.ingestion.lastStartedAt('robot'))?.toISOString()).toBe(
      TEST_NOW.toISOString(),
    );
  });

  it('取り込めなかった不正な値は、その設備のログに数える。同じ不正な値が続いても（新しく保存した観測値がない）、ログを増やさない', async () => {
    const { runAfter, repositories } = await build({
      connection: HTTP_CONNECTION,
      files: { [ROBOT_1_FILE]: 'ROBOT-SAMPLE-01' },
      // 収穫数に小数（整数の項目）は、不正
      fields: { harvestCount: 1.5 },
    });

    await runAfter(0);
    const first = await logsOf(repositories);
    await runAfter(MINUTE);
    const second = await logsOf(repositories);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      equipmentId: ROBOT_ID,
      recordCount: 0,
      rejectedCount: 1,
      result: 'FAILURE',
    });
    expect(second).toHaveLength(1);
  });
});
