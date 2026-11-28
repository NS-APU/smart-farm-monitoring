/**
 * 取り込み（UC-08, UC-09, UC-15, UC-24。JB-01）の結合テスト。
 * HTTP のテスト用ファイルサーバー（tests/support/http-file-server.ts。設備ごとのファイルパス〔1 設備 = 1 ファイル〕+ 合成データのフィクスチャ。
 * Issue #344。ADR-0025）、メモリ上のデータ、固定した時計を使う。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@smart-farm/shared/errors';
import { toEquipmentId, toUserId, type EquipmentId } from '@smart-farm/shared/schemas/common';
import { createIngestionService } from '../../src/backend/application/ingestion/ingestion-service.ts';
import { createIngestionSettings } from '../../src/backend/application/ingestion/ingestion-settings.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { DEFAULT_APP_SETTINGS } from '../../src/backend/application/settings.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import { createDefaultFormatProfileRegistry } from '../../src/backend/infrastructure/format-profiles/declarative-profile.ts';
import { FileSourceUnavailableError } from '../../src/backend/application/ports/file-source-port.ts';
import {
  equipmentSet,
  must,
  ROBOT_2_ID,
  ROBOT_ID,
  SENSOR_2_ID,
  SENSOR_ID,
  FACILITY_ID,
} from '../support/builders.ts';
import { withHttpFiles } from '../support/http-test-files.ts';
import { TEST_NOW, TEST_USER, withEquipment, type TestContext } from '../support/test-context.ts';
import { STUB_MODIFIED_AT } from '../support/test-constants.ts';

type FileSource = Parameters<typeof createIngestionService>[0]['fileSource'];

/** 指定した名前のファイルを持ち、内容は空の JSON オブジェクトを返す、ファイルサーバーのスタブ。 */
function stubFileSource(names: readonly string[]): FileSource {
  return {
    testEquipment: () => Promise.resolve(),
    listFiles: () =>
      Promise.resolve(
        names.map((name) => ({ fileId: name, name, modifiedAt: STUB_MODIFIED_AT, sizeBytes: 1 })),
      ),
    readFile: () => Promise.resolve('{}'),
  };
}

/** ポートをスタブにした取り込みサービス（ファイル取得・FormatProfile の境界の検証用）。 */
function build(fileSource: FileSource, profiles = createDefaultFormatProfileRegistry()) {
  const { repositories } = createLocalRepositories();
  const notifyIngestionFailure = vi.fn().mockResolvedValue(null);
  const service = createIngestionService({
    repositories,
    ingestionSettings: createIngestionSettings(repositories.settings),
    fileSource,
    profiles,
    evaluation: {
      evaluateAll: vi.fn().mockResolvedValue({}),
      evaluateAffected: vi.fn().mockResolvedValue({}),
      evaluateCurrent: vi.fn().mockResolvedValue({}),
    },
    notifications: {
      notifyStatusChange: vi.fn(),
      notifyIngestionFailure,
      clearRecoveredIngestionFailures: vi.fn().mockResolvedValue(undefined),
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
    clock: createControllableClock(TEST_NOW),
    ids: createSequentialIdGenerator(),
    settings: { ...DEFAULT_APP_SETTINGS.ingestion, retryBaseDelayMs: 0 },
    logger: NULL_LOGGER,
  });
  return { service, repositories, notifyIngestionFailure };
}

// 値の範囲のテストで使う、3 つ目のセンサー（1 設備 = 1 ファイル）
const SENSOR_3_ID = toEquipmentId('SENSOR-T3');
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

/** 設備の一式を登録し、取り込み元の接続を、HTTP のテスト用ファイルサーバーにする（テストの終了で、サーバーを閉じる）。 */
async function setup(options: Parameters<typeof withHttpFiles>[0] = {}) {
  const context = await withHttpFiles(options);
  closers.push(() => context.files.server.close());
  return context;
}

/**
 * ファイルを持つ設備（同じ種別・同じハウス）を、1 つ増やす（HTTP は、1 設備 = 1 ファイル。複数のファイルは、別の設備のファイルとして置く）。
 * 外部の識別子（データ上の ID）は、設備ごとに一意にする。ファイルの中の ID は、その設備の外部の識別子に合わせる。
 */
async function addEquipment(
  context: TestContext,
  type: 'ROBOT' | 'SENSOR',
  equipmentId: EquipmentId,
  externalId: string,
) {
  const { repositories } = context.container;
  const base = must(
    (await repositories.equipment.list()).find((item) => item.equipmentType === type),
  );
  await repositories.equipment.save({
    ...base,
    equipmentId,
    externalId,
    sourceFilePath: undefined,
  });
}

async function observationsOf(context: TestContext, equipmentId = ROBOT_ID) {
  return (
    await context.container.repositories.observations.query(
      { equipmentIds: [equipmentId], includeDeleted: true },
      { limit: 100 },
    )
  ).items;
}

describe('UC-08 ロボットデータの自動取り込み', () => {
  it('ファイルサーバーの新しいファイルを読み、ロボットに紐づけて保存し、評価を更新する', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({
      result: 'SUCCESS',
      filesProcessed: 1,
      recordCount: 7,
      rejectedCount: 0,
      attempts: 1,
    });
    const observations = await observationsOf(context);
    expect(observations).toHaveLength(7);
    expect(
      observations.every(
        (item) =>
          item.source === 'AUTO_IMPORT' && item.sourceFileId === '/robot/robot-sample-001.json',
      ),
    ).toBe(true);
    // 解釈に使った版（確定）を、観測値に残す
    expect(observations[0]?.formatProfileVersion).toBe('robot-json@1.0.0(CONFIRMED)');
    const latest = await context.container.repositories.evaluations.listLatest(FACILITY_ID);
    expect(latest.length).toBeGreaterThan(0);
  });

  it('取り込みログに、成功・件数・解釈の版を記録する', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');

    await context.container.ingestionService.runSource('robot');

    const logs = await context.container.repositories.ingestion.listLogs({}, { limit: 10 });
    expect(logs.items[0]).toMatchObject({
      sourceId: 'robot',
      result: 'SUCCESS',
      filesProcessed: 1,
      recordCount: 7,
      formatProfileVersion: 'robot-json@1.0.0(CONFIRMED)',
    });
  });

  it('同じファイルを、重複して取り込まない', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    await context.container.ingestionService.runSource('robot');

    const again = await context.container.ingestionService.runSource('robot');

    expect(again).toMatchObject({ filesProcessed: 0, recordCount: 0, result: 'SUCCESS' });
    expect(await observationsOf(context)).toHaveLength(7);
  });

  it('同じパスのファイルは、内容が同じなら、再び取り込まない（同じ値の観測値は保存しない）。内容が変わったファイルは新しい版として取り込む（ファイルごとに最新の版の記録。Issue #201）', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    await context.container.ingestionService.runSource('robot');
    const before = (await observationsOf(context)).length;
    // 同じパスに、同じ内容を置き直す
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');

    const copied = await context.container.ingestionService.runSource('robot');
    const afterCopy = (await observationsOf(context)).length;
    await context.files.placeFile(
      'robot',
      'robot-sample-001.json',
      JSON.stringify({ timestamp: '2026-10-09T01:00:00Z', harvestCount: 20 }),
    );
    const updated = await context.container.ingestionService.runSource('robot');

    // 内容が同じ（同じパス・同じハッシュ）なので、取り込まず、観測値も増えない
    expect(copied).toMatchObject({ filesProcessed: 0, recordCount: 0 });
    expect(afterCopy).toBe(before);
    expect(updated).toMatchObject({ filesProcessed: 1, recordCount: 1 });
    // 観測値の一意キーが同じ（設備・項目・計測日時・取得元）ため、上書きされ、二重に数えない
    const harvest = (await observationsOf(context)).filter(
      (item) => item.itemKey === 'harvestCount' && item.observedAt === '2026-10-09T01:00:00.000Z',
    );
    expect(harvest.map((item) => item.value)).toEqual([20]);
  });

  it('設備のファイルのパスを修正すると、新しいパスのファイルは、別のファイルとして読むが、同じ値の観測値は保存しない（D-08。取り込み済みの判定は、パスと内容のハッシュ）', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    await context.container.ingestionService.runSource('robot');
    const before = (await observationsOf(context)).length;
    // 設備のファイルのパスを、別のパスに修正し、同じ内容のファイルを置く
    await context.files.assignPath(ROBOT_ID, '/robot/moved.json');
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json', {
      asName: 'moved.json',
    });

    const moved = await context.container.ingestionService.runSource('robot');

    // 別のパス（別のファイル）なので読むが、同じ値（同じ計測日時・同じ値）は、触らない。観測値は増えない
    expect(moved).toMatchObject({ filesProcessed: 1, recordCount: 0 });
    expect(await observationsOf(context)).toHaveLength(before);
  });

  it('欠損・不正な値を区別して記録し、評価に使う値は有効な値だけにする', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-002-partial.json');
    // 計測の直後（遅延にならない時刻）に取り込む
    context.clock.set(new Date('2026-10-09T02:05:00Z'));

    const summary = await context.container.ingestionService.runSource('robot');

    // 収穫数（-3）・ステータスコード（未定義）は不正、待機時間（null）は欠損。残りの 3 項目は有効
    expect(summary).toMatchObject({
      result: 'PARTIAL',
      filesProcessed: 1,
      recordCount: 3,
      rejectedCount: 3,
    });
    const observations = await observationsOf(context);
    const byQuality = (quality: string) => observations.filter((item) => item.quality === quality);
    expect(byQuality('VALID')).toHaveLength(3);
    expect(byQuality('MISSING').map((item) => [item.itemKey, item.value])).toEqual([
      ['standbyHours', null],
    ]);
    expect(
      byQuality('INVALID')
        .map((item) => item.itemKey)
        .sort(),
    ).toEqual(['harvestCount', 'statusCode']);
    // 不正な値は、元の値を残す（調査できるように）
    expect(byQuality('INVALID').find((item) => item.itemKey === 'harvestCount')?.value).toBe(-3);
  });

  it('形式違いのファイルは、失敗として記録し、他のファイル（別の設備のファイル）の取り込みを継続する', async () => {
    const context = await setup();
    await addEquipment(context, 'ROBOT', ROBOT_2_ID, 'ROBOT-SAMPLE-02');
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    await context.files.placeFixture('robot', 'robot/robot-sample-003-broken.json', {
      equipmentId: ROBOT_2_ID,
    });

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'PARTIAL', filesProcessed: 2, recordCount: 7 });
    const logs = await context.container.repositories.ingestion.listLogs({}, { limit: 10 });
    expect(logs.items[0]?.errorMessage).toBe('1件のファイルを取り込めませんでした');
    // 同じ形式違いのファイルは、再び取り込もうとしない
    expect((await context.container.ingestionService.runSource('robot')).filesProcessed).toBe(0);
  });

  it('形式違いのファイルだけのとき、取り込み結果は失敗にする', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-003-broken.json');

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'FAILURE', recordCount: 0, rejectedCount: 1 });
  });

  it('設備は、ファイルのパスで決める（ファイルの中に設備の識別子はない）。設備のデータ上の識別子（externalId）は、取り込みの照合に使わない', async () => {
    const context = await setup();
    // 設備のデータ上の識別子を、ほかの値にしても、ファイルのパスの設備のデータとして取り込む
    const robot = must(await context.container.repositories.equipment.get(ROBOT_ID));
    await context.container.repositories.equipment.save({ ...robot, externalId: 'ANY-OTHER-ID' });
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'SUCCESS', recordCount: 7, rejectedCount: 0 });
    expect(await observationsOf(context, ROBOT_ID)).toHaveLength(7);
  });

  it('ファイルごとに、そのファイルのパスの設備のデータになる（別の設備のファイルの内容は、混ざらない）', async () => {
    const context = await setup();
    await addEquipment(context, 'ROBOT', ROBOT_2_ID, 'ROBOT-SAMPLE-02');
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    await context.files.placeFixture('robot', 'robot/robot-sample-002-partial.json', {
      equipmentId: ROBOT_2_ID,
    });

    await context.container.ingestionService.runSource('robot');

    const first = await observationsOf(context, ROBOT_ID);
    const second = await observationsOf(context, ROBOT_2_ID);
    expect(first.map((item) => item.sourceFileId)).toEqual(
      Array.from({ length: 7 }, () => '/robot/robot-sample-001.json'),
    );
    expect(second.map((item) => item.sourceFileId)).toEqual(
      Array.from({ length: 6 }, () => '/robot/robot-sample-002-partial.json'),
    );
  });

  it('旧構造のファイル（設備の識別子 + 記録の配列）は、読まない。形式違いとして、失敗にする', async () => {
    const context = await setup();
    await context.files.placeFile(
      'robot',
      'old.json',
      JSON.stringify({
        robotId: 'ROBOT-SAMPLE-01',
        records: [{ timestamp: '2026-10-09T01:00:00Z', harvestCount: 1 }],
      }),
    );

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'FAILURE', recordCount: 0, rejectedCount: 1 });
    expect(await observationsOf(context)).toHaveLength(0);
  });

  it('計測日時のないファイル（項目はある）は、読み取れなかった記録として数える。保存しない', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-004-no-timestamp.json');

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ recordCount: 0, rejectedCount: 1 });
    expect(await observationsOf(context)).toHaveLength(0);
  });

  it('削除した設備のファイルは、取得しない（ファイルのパスで設備を決めるため、取り込みの対象から外れる）。ほかの設備のファイルは、取り込む', async () => {
    const context = await setup();
    await addEquipment(context, 'ROBOT', ROBOT_2_ID, 'ROBOT-SAMPLE-02');
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json', {
      equipmentId: ROBOT_2_ID,
      asName: 'second.json',
    });
    await context.container.equipmentService.delete(ROBOT_ID, toUserId(TEST_USER.userId));

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ filesProcessed: 1, recordCount: 7, rejectedCount: 0 });
    expect(await observationsOf(context, ROBOT_2_ID)).toHaveLength(7);
    // 削除した設備のデータは、取り込まない
    expect(await observationsOf(context, ROBOT_ID)).toHaveLength(0);
  });

  it('設備を削除すると、そのデータ上の識別子（種別・削除日時）を、削除済みの一覧に残す（過去のログの表示のため。取り込みの照合には、使わない）。ハウスを削除すれば、配下の設備の識別子も', async () => {
    const context = await setup();

    await context.container.equipmentService.delete(FACILITY_ID, toUserId(TEST_USER.userId));

    const stored = (await context.container.repositories.settings.get(
      'equipment.deletedExternalIds',
    )) as { externalId: string; equipmentType: string; deletedAt: string }[];
    expect(stored.map((item) => [item.equipmentType, item.externalId]).sort()).toEqual([
      ['ROBOT', 'ROBOT-SAMPLE-01'],
      ['SENSOR', 'SENSOR-SAMPLE-01'],
    ]);
    expect(stored.every((item) => item.deletedAt === TEST_NOW.toISOString())).toBe(true);
  });

  it('カタログにない項目は、保存せず、読み取れなかったものとして数える', async () => {
    const { service, repositories } = build(stubFileSource(['x.json']), {
      get: () => ({
        profileId: 'robot-json',
        version: 'test',
        status: 'PROVISIONAL',
        versionLabel: 'robot-json@test(PROVISIONAL)',
        parse: () => ({
          record: {
            observedAt: '2026-10-09T01:00:00Z',
            fields: { notInCatalog: 1, harvestCount: 2 },
          },
          rejectedCount: 0,
        }),
      }),
    });
    const [, robot] = equipmentSet();
    if (robot === undefined) {
      throw new Error('テストの前提');
    }
    // ファイルのパス（スタブの一覧のファイル）で、設備が決まる
    await repositories.equipment.save({ ...robot, sourceFilePath: 'x.json' });

    const summary = await service.runSource('robot');

    expect(summary).toMatchObject({ recordCount: 1, rejectedCount: 1 });
    expect(
      (await repositories.observations.query({}, { limit: 10 })).items.map((item) => item.itemKey),
    ).toEqual(['harvestCount']);
  });

  it('計測から60分を超えて届いたデータは、遅延として区別して記録し、評価には使う', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    // 計測（01:00）から、1時間以上あとの 03:00 に届く

    await context.container.ingestionService.runSource('robot');

    const observations = await observationsOf(context);
    expect(observations.every((item) => item.quality === 'LATE')).toBe(true);
    const latest = await context.container.repositories.evaluations.getLatest(
      FACILITY_ID,
      'harvestAccuracy',
      'LONG',
      7,
    );
    expect(latest?.metrics).toBeDefined();
  });

  it('保存した観測値を、連携キューに積む（生データ）', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');

    await context.container.ingestionService.runSource('robot');

    const due = await context.container.repositories.federation.listDue(
      new Date(TEST_NOW.getTime() + 1000),
      100,
    );
    expect(due.filter((item) => item.targetType === 'OBSERVATION')).toHaveLength(1);
  });

  it('データ定義（確定）の文書のサンプル 1: 7 項目とも、すべて有効な値として保存し、解釈に使った版（確定）を残す（#299・#301）', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-definition-sample-001.json');

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({
      result: 'SUCCESS',
      filesProcessed: 1,
      recordCount: 7,
      rejectedCount: 0,
    });
    const observations = await observationsOf(context);
    expect(observations).toHaveLength(7);
    expect(observations.every((item) => item.quality === 'VALID')).toBe(true);
    expect(
      observations.every(
        (item) =>
          item.formatProfileVersion === 'robot-json@1.0.0(CONFIRMED)' &&
          item.source === 'AUTO_IMPORT' &&
          item.observedAt === '2026-10-09T02:00:00.000Z',
      ),
    ).toBe(true);
    expect(observations.map((item) => [item.itemKey, item.value]).sort()).toEqual([
      ['harvestCount', 128],
      ['harvestOperatingHours', 2.5],
      ['harvestSecondsPerFruit', 42.5],
      ['operatingHours', 3.25],
      ['standbyHours', 0.5],
      ['statusCode', 'HARVESTING'],
      ['travelStoppedHours', 0.125],
    ]);
  });

  it('データ定義（確定）の文書のサンプル 2: タイムゾーンのない日時は日本時間・null は欠損・省略した項目は保存しない（#299・#301）', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-definition-sample-002-partial.json');

    const summary = await context.container.ingestionService.runSource('robot');

    // 6 項目（1 果実あたりの収穫時間は null）。走行停止時間は省略。欠損 1 件は、棄却数に数える
    expect(summary).toMatchObject({ recordCount: 5, rejectedCount: 1 });
    const observations = await observationsOf(context);
    expect(observations).toHaveLength(6);
    expect(
      observations
        .filter((item) => item.quality === 'MISSING')
        .map((item) => [item.itemKey, item.observedAt]),
    ).toEqual([['harvestSecondsPerFruit', '2026-10-09T02:10:00.000Z']]);
    // 省略した項目（走行停止時間）は、保存しない
    expect(observations.map((item) => item.itemKey)).not.toContain('travelStoppedHours');
    expect(observations.find((item) => item.itemKey === 'statusCode')).toMatchObject({
      value: 'STANDBY',
      quality: 'VALID',
    });
  });

  it('累積の項目（収穫数・稼働時間など）は、ファイルの値（累積のスナップショット）のまま保存する。ファイルが更新されるたびに、新しい計測日時の値が積み上がる（増分に変えない。D-26）', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-definition-sample-001.json');
    await context.container.ingestionService.runSource('robot');
    // 同じファイルのパスの内容が、次の計測の値（累積が増えている）に更新される
    await context.files.placeFixture('robot', 'robot/robot-definition-sample-002-partial.json', {
      asName: 'robot-definition-sample-001.json',
    });

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ filesProcessed: 1, result: 'PARTIAL' });
    const observations = await observationsOf(context);
    const series = (itemKey: string) =>
      observations
        .filter((item) => item.itemKey === itemKey)
        .map((item) => [item.observedAt, item.value])
        .sort();
    expect(series('harvestCount')).toEqual([
      ['2026-10-09T02:00:00.000Z', 128],
      ['2026-10-09T02:10:00.000Z', 130],
    ]);
    expect(series('operatingHours')).toEqual([
      ['2026-10-09T02:00:00.000Z', 3.25],
      ['2026-10-09T02:10:00.000Z', 3.4],
    ]);
  });

  it('値の範囲（収穫数は整数の 0 以上・1 果実あたりの収穫時間は 0〜3,600・時間は 0 以上）の外は、不正にして評価に使わず、元の値を残す。境界の値は有効（D-10）', async () => {
    const context = await setup();
    await addEquipment(context, 'ROBOT', ROBOT_2_ID, 'ROBOT-SAMPLE-02');
    const timestamp = '2026-10-09T02:00:00Z';
    context.clock.set(new Date('2026-10-09T02:05:00Z'));
    // 境界の値（有効）
    await context.files.placeFile(
      'robot',
      'boundary.json',
      JSON.stringify({
        timestamp,
        harvestCount: 0,
        harvestSecondsPerFruit: 3600,
        operatingHours: 0,
      }),
    );
    // 範囲外（不正）
    await context.files.placeFile(
      'robot',
      'over.json',
      JSON.stringify({
        timestamp,
        harvestCount: 12.5,
        harvestSecondsPerFruit: 3600.5,
        operatingHours: -0.5,
        standbyHours: '0.5',
      }),
      { equipmentId: ROBOT_2_ID },
    );

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ recordCount: 3, rejectedCount: 4 });
    const valid = await observationsOf(context, ROBOT_ID);
    expect(valid.every((item) => item.quality === 'VALID')).toBe(true);
    const invalid = await observationsOf(context, ROBOT_2_ID);
    expect(invalid.every((item) => item.quality === 'INVALID')).toBe(true);
    expect(invalid.map((item) => [item.itemKey, item.value]).sort()).toEqual([
      ['harvestCount', 12.5],
      ['harvestSecondsPerFruit', 3600.5],
      ['operatingHours', -0.5],
      ['standbyHours', '0.5'],
    ]);
  });

  it('ステータスコード: 未登録の値は、棄却せず、不正の品質で、元の値のまま保存する（同じファイルの、ほかの項目は有効のまま）', async () => {
    const context = await setup();
    await context.files.placeFile(
      'robot',
      'status.json',
      JSON.stringify({
        timestamp: '2026-10-09T02:00:00Z',
        harvestCount: 5,
        statusCode: 'NEW_CODE',
      }),
    );

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'PARTIAL', recordCount: 1, rejectedCount: 1 });
    const observations = await observationsOf(context);
    expect(observations.find((item) => item.itemKey === 'statusCode')).toMatchObject({
      value: 'NEW_CODE',
      quality: 'INVALID',
    });
    expect(observations.find((item) => item.itemKey === 'harvestCount')?.quality).toBe('VALID');
  });
});

describe('UC-09 環境センサーデータの自動取り込み', () => {
  it('JSON を読み、センサーに紐づけて保存する。null の値は欠損として記録する', async () => {
    const context = await setup();
    await context.files.placeFixture(
      'environment-sensor',
      'environment-sensor/sensor-sample-001.json',
    );

    const summary = await context.container.ingestionService.runSource('environment-sensor');

    expect(summary).toMatchObject({
      result: 'PARTIAL',
      filesProcessed: 1,
      recordCount: 3,
      rejectedCount: 1,
    });
    const observations = await observationsOf(context, SENSOR_ID);
    expect(observations).toHaveLength(4);
    expect(observations.filter((item) => item.quality === 'MISSING')).toHaveLength(1);
    expect(observations[0]?.formatProfileVersion).toBe('environment-sensor-json@1.0.0(CONFIRMED)');
  });

  it('データ定義（確定）の文書のサンプル 1: 4 項目とも、すべて有効な値として保存し、解釈に使った版（確定）を残す（#300・#302）', async () => {
    const context = await setup();
    await context.files.placeFixture(
      'environment-sensor',
      'environment-sensor/sensor-definition-sample-001.json',
    );

    const summary = await context.container.ingestionService.runSource('environment-sensor');

    expect(summary).toMatchObject({
      result: 'SUCCESS',
      filesProcessed: 1,
      recordCount: 4,
      rejectedCount: 0,
    });
    const observations = await observationsOf(context, SENSOR_ID);
    expect(observations).toHaveLength(4);
    expect(observations.every((item) => item.quality === 'VALID')).toBe(true);
    expect(
      observations.every(
        (item) =>
          item.formatProfileVersion === 'environment-sensor-json@1.0.0(CONFIRMED)' &&
          item.source === 'AUTO_IMPORT',
      ),
    ).toBe(true);
    expect(
      observations
        .filter((item) => item.observedAt === '2026-10-09T02:00:00.000Z')
        .map((item) => [item.itemKey, item.value])
        .sort(),
    ).toEqual([
      ['co2Ppm', 650],
      ['humidityPercent', 62],
      ['illuminanceLux', 48000],
      ['temperatureCelsius', 24.5],
    ]);
  });

  it('データ定義（確定）の文書のサンプル 2: タイムゾーンのない日時は日本時間・null は欠損・省略した項目は保存しない（#300・#302）', async () => {
    const context = await setup();
    await context.files.placeFixture(
      'environment-sensor',
      'environment-sensor/sensor-definition-sample-002-partial.json',
    );

    const summary = await context.container.ingestionService.runSource('environment-sensor');

    // 3 項目（湿度は null、CO2 は省略）。欠損 1 件は、棄却数に数える
    expect(summary).toMatchObject({ recordCount: 2, rejectedCount: 1 });
    const observations = await observationsOf(context, SENSOR_ID);
    expect(observations).toHaveLength(3);
    expect(
      observations
        .filter((item) => item.quality === 'MISSING')
        .map((item) => [item.itemKey, item.observedAt]),
    ).toEqual([['humidityPercent', '2026-10-09T02:10:00.000Z']]);
    // 省略した項目（CO2濃度）は、保存しない
    expect(observations.map((item) => item.itemKey).sort()).toEqual([
      'humidityPercent',
      'illuminanceLux',
      'temperatureCelsius',
    ]);
  });

  it('範囲外・数値でない値を区別して扱う。計測日時のないファイルは、読み取れなかった記録として数える。項目の一部だけのファイルは、読める', async () => {
    const context = await setup();
    await context.files.placeFixture(
      'environment-sensor',
      'environment-sensor/sensor-sample-002-invalid.json',
    );

    const summary = await context.container.ingestionService.runSource('environment-sensor');

    // 温度 abc・湿度 120 は不正（照度・CO2 は有効）
    expect(summary).toMatchObject({ recordCount: 2, rejectedCount: 2 });
    expect(
      (await observationsOf(context, SENSOR_ID))
        .filter((item) => item.quality === 'INVALID')
        .map((item) => item.itemKey)
        .sort(),
    ).toEqual(['humidityPercent', 'temperatureCelsius']);
  });

  it('計測日時のないファイル（項目はある）は、読み取れなかった記録として数える。項目の一部だけのファイル（温度だけ）は、読める', async () => {
    const context = await setup();
    await addEquipment(context, 'SENSOR', SENSOR_2_ID, 'SENSOR-SAMPLE-02');
    await context.files.placeFixture(
      'environment-sensor',
      'environment-sensor/sensor-sample-004-no-timestamp.json',
    );
    await context.files.placeFile(
      'environment-sensor',
      'only-temperature.json',
      JSON.stringify({ timestamp: '2026-10-09T02:00:00Z', temperature: 22 }),
      { equipmentId: SENSOR_2_ID },
    );

    const summary = await context.container.ingestionService.runSource('environment-sensor');

    expect(summary).toMatchObject({ recordCount: 1, rejectedCount: 1 });
    expect(await observationsOf(context, SENSOR_ID)).toHaveLength(0);
    expect(
      (await observationsOf(context, SENSOR_2_ID)).map((item) => [item.itemKey, item.value]),
    ).toEqual([['temperatureCelsius', 22]]);
  });

  it('環境センサーの値の範囲（温度 −50〜100・照度 0〜200,000・CO2 0〜10,000）の外は、不正にして評価に使わず、元の値を残す。境界の値は有効（D-10）', async () => {
    const context = await setup();
    const timestamp = '2026-10-09T02:00:00Z';
    context.clock.set(new Date('2026-10-09T02:05:00Z'));
    // 1 設備 = 1 ファイル。3 つのファイルは、3 台のセンサーのファイルとして置く
    await addEquipment(context, 'SENSOR', SENSOR_2_ID, 'SENSOR-SAMPLE-02');
    await addEquipment(context, 'SENSOR', SENSOR_3_ID, 'SENSOR-SAMPLE-03');
    const place = (name: string, equipmentId: EquipmentId, fields: Record<string, number>) =>
      context.files.placeFile(
        'environment-sensor',
        name,
        JSON.stringify({ timestamp, ...fields }),
        { equipmentId },
      );
    // 境界の値（有効）
    await place('boundary.json', SENSOR_ID, {
      temperature: -50,
      illuminance: 200_000,
      co2: 10_000,
    });
    // 範囲外（不正）
    await place('over.json', SENSOR_2_ID, { temperature: 100.5, illuminance: 200_001 });
    await place('under.json', SENSOR_3_ID, { temperature: -51, co2: 10_001 });

    const summary = await context.container.ingestionService.runSource('environment-sensor');

    expect(summary).toMatchObject({ recordCount: 3, rejectedCount: 4 });
    const observations = [
      ...(await observationsOf(context, SENSOR_ID)),
      ...(await observationsOf(context, SENSOR_2_ID)),
      ...(await observationsOf(context, SENSOR_3_ID)),
    ];
    const invalid = observations.filter((item) => item.quality === 'INVALID');
    expect(invalid.map((item) => [item.itemKey, item.value]).sort()).toEqual([
      ['co2Ppm', 10_001],
      ['illuminanceLux', 200_001],
      ['temperatureCelsius', -51],
      ['temperatureCelsius', 100.5],
    ]);
    expect(observations.filter((item) => item.quality === 'VALID')).toHaveLength(3);
  });

  describe('取り込みの計測日時の未来の許容（D-13。既定 5 分。設定 INGESTION_FUTURE_TOLERANCE_MINUTES）', () => {
    const futureFile = (minutesAhead: number) =>
      JSON.stringify({
        timestamp: new Date(TEST_NOW.getTime() + minutesAhead * 60_000).toISOString(),
        temperature: 22,
      });

    it('既定: 受信の 5 分先までは有効。それを超える未来は、不正にして、棄却数に数える', async () => {
      const context = await setup();
      // HTTP は 1 設備 = 1 ファイル。2 つのファイルは、別のセンサーのファイルとして置く
      await addEquipment(context, 'SENSOR', SENSOR_2_ID, 'SENSOR-SAMPLE-02');
      await context.files.placeFile('environment-sensor', 'future-5.json', futureFile(5));
      await context.files.placeFile('environment-sensor', 'future-6.json', futureFile(6), {
        equipmentId: SENSOR_2_ID,
      });

      const summary = await context.container.ingestionService.runSource('environment-sensor');

      expect(summary).toMatchObject({ recordCount: 1, rejectedCount: 1 });
      const observations = [
        ...(await observationsOf(context, SENSOR_ID)),
        ...(await observationsOf(context, SENSOR_2_ID)),
      ];
      expect(observations.map((item) => item.quality).sort()).toEqual(['INVALID', 'VALID']);
    });

    it('設定値を変えると、許容も変わる（10 分に広げれば、6 分先は有効。0 分にすれば、5 分先も不正）', async () => {
      const wide = await setup({ env: { INGESTION_FUTURE_TOLERANCE_MINUTES: '10' } });
      const strict = await setup({ env: { INGESTION_FUTURE_TOLERANCE_MINUTES: '0' } });
      await wide.files.placeFile('environment-sensor', 'future-6.json', futureFile(6));
      await strict.files.placeFile('environment-sensor', 'future-5.json', futureFile(5));

      const wideSummary = await wide.container.ingestionService.runSource('environment-sensor');
      const strictSummary = await strict.container.ingestionService.runSource('environment-sensor');

      expect(wideSummary).toMatchObject({ recordCount: 1, rejectedCount: 0 });
      expect(strictSummary).toMatchObject({ recordCount: 0, rejectedCount: 1 });
    });
  });

  it('旧構造のファイル（設備の識別子 sensorId + 記録の配列）は、読まない。形式違いとして、失敗にする', async () => {
    const context = await setup();
    await context.files.placeFile(
      'environment-sensor',
      'old.json',
      JSON.stringify({
        sensorId: 'SENSOR-SAMPLE-01',
        records: [{ timestamp: '2026-10-09T02:00:00Z', temperature: 22 }],
      }),
    );

    const summary = await context.container.ingestionService.runSource('environment-sensor');

    expect(summary).toMatchObject({ result: 'FAILURE', recordCount: 0 });
    expect(await observationsOf(context, SENSOR_ID)).toHaveLength(0);
  });

  it('構造が仕様と異なる JSON は、形式違いとして扱う', async () => {
    const context = await setup();
    await context.files.placeFixture(
      'environment-sensor',
      'environment-sensor/sensor-sample-003-bad-structure.json',
    );

    expect(await context.container.ingestionService.runSource('environment-sensor')).toMatchObject({
      result: 'FAILURE',
    });
  });

  it('取り込んだ環境の値から、環境適応性が評価される', async () => {
    const context = await setup();
    await context.files.placeFile(
      'environment-sensor',
      'evaluation.json',
      JSON.stringify({
        timestamp: '2026-10-09T01:15:00Z',
        temperature: 22,
        humidity: 57.5,
        illuminance: 31000,
        co2: 890,
      }),
    );
    context.clock.set(new Date('2026-10-09T01:45:00Z'));

    await context.container.ingestionService.runSource('environment-sensor');

    const result = await context.container.repositories.evaluations.getLatest(
      FACILITY_ID,
      'environmentalAdaptability',
      'SHORT',
      null,
    );
    expect(result?.status).toBe('NORMAL');
    expect(result?.metrics.temperatureCelsius).toBe(22);
  });
});

describe('UC-24 取り込み失敗の通知（再試行・単独稼働）', () => {
  it('ファイルサーバーが停止していたら、間隔を広げて再試行し、失敗を記録して通知する', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    context.files.faults.set({ mode: 'DOWN' });
    const before = context.clock.now().getTime();

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'FAILURE', attempts: 3 });
    // 再試行の待ち時間: 1秒 + 2秒（2倍に広げる）
    expect(context.clock.now().getTime() - before).toBe(3000);
    const logs = await context.container.repositories.ingestion.listLogs({}, { limit: 10 });
    expect(logs.items[0]).toMatchObject({
      result: 'FAILURE',
      attempts: 3,
      errorMessage: 'ファイルサーバーに接続できませんでした',
    });
    const notifications = await context.container.repositories.notifications.list(
      toUserId(TEST_USER.userId),
      {},
      { limit: 10 },
    );
    expect(notifications.items[0]?.notification).toMatchObject({
      kind: 'INGESTION_FAILURE',
      sourceId: 'robot',
      message: expect.stringContaining('データ取得失敗'),
    });
  });

  it('同じ種類の失敗が続く間は、時間がたっても、繰り返し通知しない（D-38。#589）', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    context.files.faults.set({ mode: 'DOWN' });
    const unread = () =>
      context.container.repositories.notifications.countUnread(toUserId(TEST_USER.userId), {
        kind: 'INGESTION_FAILURE',
      });

    await context.container.ingestionService.runSource('robot');
    await context.container.ingestionService.runSource('robot');
    expect(await unread()).toBe(1);

    // 60 分を過ぎても、24 時間たっても、同じ失敗が続いているだけなら、通知は増えない
    context.clock.advance(61 * 60_000);
    await context.container.ingestionService.runSource('robot');
    context.clock.advance(24 * 60 * 60_000);
    await context.container.ingestionService.runSource('robot');
    expect(await unread()).toBe(1);
  });

  it('取り込みが成功して回復したあとの失敗は、新しい出来事として通知する（時間に関係なく）', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    const unread = () =>
      context.container.repositories.notifications.countUnread(toUserId(TEST_USER.userId), {
        kind: 'INGESTION_FAILURE',
      });
    context.files.faults.set({ mode: 'DOWN' });
    await context.container.ingestionService.runSource('robot');
    expect(await unread()).toBe(1);

    context.files.faults.set({ mode: 'UP' });
    const recovered = await context.container.ingestionService.runSource('robot');
    expect(recovered.result).toBe('SUCCESS');
    context.clock.advance(60_000);
    context.files.faults.set({ mode: 'DOWN' });
    await context.container.ingestionService.runSource('robot');

    expect(await unread()).toBe(2);
    // 再び失敗が続いても、増えない
    await context.container.ingestionService.runSource('robot');
    expect(await unread()).toBe(2);
  });

  it('別の取り込み元の失敗は、別々に数える（片方が続いていても、もう片方の最初の失敗は通知する）', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    await context.files.placeFixture(
      'environment-sensor',
      'environment-sensor/sensor-sample-001.json',
    );
    context.files.faults.set({ mode: 'DOWN' });

    await context.container.ingestionService.runSource('robot');
    await context.container.ingestionService.runSource('robot');
    await context.container.ingestionService.runSource('environment-sensor');

    expect(
      await context.container.repositories.notifications.countUnread(toUserId(TEST_USER.userId), {
        kind: 'INGESTION_FAILURE',
      }),
    ).toBe(2);
  });

  it('接続できない取り込み元があっても、他の取り込み元の取り込みは継続できる（取り込み元ごとに独立）', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    await context.files.placeFixture(
      'environment-sensor',
      'environment-sensor/sensor-sample-001.json',
    );
    context.files.faults.set({ mode: 'DOWN' });
    const failed = await context.container.ingestionService.runSource('robot');
    context.files.faults.set({ mode: 'UP' });

    const succeeded = await context.container.ingestionService.runSource('environment-sensor');

    expect(failed.result).toBe('FAILURE');
    expect(succeeded.filesProcessed).toBe(1);
  });
});

describe('取り込みの実行の制御・設定', () => {
  it('存在しない取り込み元は、見つからないエラーにする', async () => {
    const context = await setup();

    await expect(context.container.ingestionService.runSource('none')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // 接続テストは、設備ごと。存在しない設備は、見つからないエラーにする
    await expect(
      context.container.ingestionService.testEquipmentConnection('ROBOT-NONE'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('実行中の取り込み元を重ねて実行すると、競合（二重実行の防止）にする', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    context.files.faults.set({ mode: 'SLOW', delayMs: 10 });

    const results = await Promise.allSettled([
      context.container.ingestionService.runSource('robot'),
      context.container.ingestionService.runSource('robot'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(
      rejected?.status === 'rejected' &&
        rejected.reason instanceof AppError &&
        rejected.reason.code,
    ).toBe('CONFLICT');
  });

  it('接続テスト（設備ごと）: 成功と失敗を、内部情報を含まないメッセージで返す', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');

    const ok = await context.container.ingestionService.testEquipmentConnection(ROBOT_ID);
    context.files.faults.set({ mode: 'DOWN' });
    const ng = await context.container.ingestionService.testEquipmentConnection(ROBOT_ID);

    expect(ok).toEqual({ ok: true, message: '接続できました' });
    expect(ng.ok).toBe(false);
    // HTTP の停止（接続できない）は、理由が分かる失敗として、固定の理由を示す。接続先（ホスト・ポート）・ファイルのパスは含めない
    expect(ng.message).toBe(
      '接続できませんでした（ファイルサーバーに接続できません）。接続先と認証情報の設定を確認してください',
    );
    expect(ng.message).not.toContain('127.0.0.1');
    expect(ng.message).not.toContain(String(context.files.server.port));
    expect(ng.message).not.toContain('/robot/');
  });

  it('スケジューラからの実行: 取得間隔が来た取り込み元だけ実行する', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    // HTTP は、ファイルを持つ設備がある取り込み元だけが、実行の対象になる。センサーにも、ファイルを置く
    await context.files.placeFixture(
      'environment-sensor',
      'environment-sensor/sensor-sample-001.json',
    );
    // 取得間隔は、設備ごとの設定（#197）。ロボット・センサーとも、15 分にする（設備ごとの判定は、ingestion-per-equipment.test.ts）
    for (const item of await context.container.repositories.equipment.list()) {
      if (item.equipmentType !== 'FACILITY') {
        await context.container.repositories.equipment.save({ ...item, intervalMinutes: 15 });
      }
    }

    const first = await context.container.ingestionService.runDueSources();
    const immediately = await context.container.ingestionService.runDueSources();
    context.clock.advance(14 * 60_000);
    const beforeInterval = await context.container.ingestionService.runDueSources();
    context.clock.advance(60_000);
    const atInterval = await context.container.ingestionService.runDueSources();

    expect(first.map((summary) => summary.sourceId).sort()).toEqual([
      'environment-sensor',
      'robot',
    ]);
    expect(immediately).toEqual([]);
    expect(beforeInterval).toEqual([]);
    expect(atInterval).toHaveLength(2);
  });

  it('スケジューラからの実行: ある取り込み元が想定外のエラーで失敗しても、他の取り込み元は実行し、エラーは呼び出し元へ伝える', async () => {
    const defaults = createDefaultFormatProfileRegistry();
    // ロボットの FormatProfile がない（設定の誤り）ため、ロボットの取り込みは、想定外のエラーになる
    const { service, repositories } = build(stubFileSource([]), {
      get: (profileId) => (profileId === 'robot-json' ? undefined : defaults.get(profileId)),
    });
    // 定期の実行の対象は、ファイルのパスを持つ設備がある取り込み元だけ（ADR-0023）
    for (const item of equipmentSet()) {
      await repositories.equipment.save(
        item.equipmentType === 'FACILITY'
          ? item
          : {
              ...item,
              sourceFilePath: `/${item.equipmentType.toLowerCase()}/${item.equipmentId}.json`,
            },
      );
    }

    await expect(service.runDueSources()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    // センサーは実行した（設備ごとの最終の実行がある。ロボットは、実行の前に失敗したため、ない）。ファイルがなく、新しいデータもないため、ログには残さない（Issue #201）
    const runs = await repositories.ingestion.listEquipmentRuns();
    expect(runs.has(SENSOR_ID)).toBe(true);
    expect(runs.has(ROBOT_ID)).toBe(false);
    const logs = await repositories.ingestion.listLogs(
      { sourceId: 'environment-sensor' },
      { limit: 10 },
    );
    expect(logs.items).toHaveLength(0);
  });

  it('無効にした取り込み元は、スケジューラから実行しない', async () => {
    const context = await setup();
    // HTTP は、ファイルを持つ設備がある取り込み元だけが、実行の対象になる
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    await context.files.placeFixture(
      'environment-sensor',
      'environment-sensor/sensor-sample-001.json',
    );
    const sources = await context.container.ingestionSettings.listSources();
    await context.container.ingestionSettings.saveSources(
      sources.map((source) => ({ ...source, isEnabled: source.sourceId === 'robot' })),
    );

    const summaries = await context.container.ingestionService.runDueSources();

    expect(summaries.map((summary) => summary.sourceId)).toEqual(['robot']);
  });

  it('FormatProfile が見つからない設定は、内部の設定の誤りとして扱う', async () => {
    const context = await setup();
    const sources = await context.container.ingestionSettings.listSources();
    await context.container.ingestionSettings.saveSources(
      sources.map((source) => ({ ...source, profileId: 'none' })),
    );

    await expect(context.container.ingestionService.runSource('robot')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('取り込み後の評価が失敗しても、取り込みの結果は成功のままにする', async () => {
    const context = await setup();
    await context.files.placeFixture('robot', 'robot/robot-sample-001.json');
    const spy = vi
      .spyOn(context.container.evaluationService, 'evaluateAffected')
      .mockRejectedValue(new Error('評価の失敗'));

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary.result).toBe('SUCCESS');
    expect(spy).toHaveBeenCalled();
  });

  it('取り込み設定の保存がなければ既定の取り込み元（ロボット・環境センサー）を返し、保存した設定を優先する', async () => {
    // 既定の設定を確かめるため、接続設定を保存する HTTP の準備（withHttpFiles）は使わない
    const context = await withEquipment();

    const defaults = await context.container.ingestionSettings.listSources();
    const [robotSource] = defaults;
    if (robotSource === undefined) {
      throw new Error('テストの前提');
    }
    await context.container.ingestionSettings.saveSources([{ ...robotSource, isEnabled: false }]);
    const saved = await context.container.ingestionSettings.listSources();

    expect(defaults.map((source) => [source.sourceId, source.isEnabled])).toEqual([
      ['robot', true],
      ['environment-sensor', true],
    ]);
    expect(saved).toEqual([{ ...robotSource, isEnabled: false }]);
  });
});

describe('取り込みの境界（スタブのファイル取得）', () => {
  it('ファイルを読めなかった場合は、そのファイルを失敗として数え、取り込みは失敗にする', async () => {
    const { service, repositories } = build({
      testEquipment: () => Promise.resolve(),
      listFiles: () =>
        Promise.resolve([
          { fileId: 'a.json', name: 'a.json', modifiedAt: STUB_MODIFIED_AT, sizeBytes: 1 },
        ]),
      readFile: () => Promise.reject(new FileSourceUnavailableError('読めない')),
    });

    const summary = await service.runSource('robot');

    expect(summary).toMatchObject({ result: 'FAILURE', filesProcessed: 1, recordCount: 0 });
    expect((await repositories.ingestion.listLogs({}, { limit: 1 })).items[0]?.errorMessage).toBe(
      '1件のファイルを取り込めませんでした',
    );
  });

  it('一覧の取得が接続エラー以外で失敗した場合は、一覧を取得できなかった旨を記録する', async () => {
    const { service, repositories, notifyIngestionFailure } = build({
      testEquipment: () => Promise.resolve(),
      listFiles: () => Promise.reject(new Error('想定外')),
      readFile: () => Promise.resolve(''),
    });

    const summary = await service.runSource('robot');

    expect(summary).toMatchObject({ result: 'FAILURE', attempts: 3 });
    expect((await repositories.ingestion.listLogs({}, { limit: 1 })).items[0]?.errorMessage).toBe(
      'ファイルの一覧を取得できませんでした',
    );
    expect(notifyIngestionFailure).toHaveBeenCalledWith({
      sourceId: 'robot',
      sourceName: 'ロボットデータ',
      reason: 'ファイルの一覧を取得できませんでした',
      failureKeys: ['LISTING:ファイルの一覧を取得できませんでした'],
    });
  });

  it('形式違い以外の想定外のエラーは、握りつぶさず、呼び出し元へ伝える', async () => {
    const { service, repositories } = build({
      testEquipment: () => Promise.resolve(),
      listFiles: () =>
        Promise.resolve([
          { fileId: 'a.json', name: 'a.json', modifiedAt: STUB_MODIFIED_AT, sizeBytes: 1 },
        ]),
      readFile: () =>
        Promise.resolve(JSON.stringify({ timestamp: '2026-10-09T01:00:00Z', harvestCount: 1 })),
    });
    vi.spyOn(repositories.observations, 'saveMany').mockRejectedValue(new Error('保存の失敗'));

    await expect(service.runSource('robot')).rejects.toThrow('保存の失敗');
  });
});
