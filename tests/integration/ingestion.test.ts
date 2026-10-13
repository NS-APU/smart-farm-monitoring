/**
 * 取り込み（UC-08, UC-09, UC-15, UC-24。JB-01）の結合テスト。
 * モックのファイルサーバー（一時ディレクトリ + 合成データのフィクスチャ）、メモリ上のデータ、固定した時計を使う。
 */

import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@smart-farm/shared/errors';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { createIngestionService } from '../../src/backend/application/ingestion/ingestion-service.ts';
import { createIngestionSettings } from '../../src/backend/application/ingestion/ingestion-settings.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { DEFAULT_APP_SETTINGS } from '../../src/backend/application/settings.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import { createDefaultFormatProfileRegistry } from '../../src/backend/infrastructure/format-profiles/declarative-profile.ts';
import { FileSourceUnavailableError } from '../../src/backend/application/ports/file-source-port.ts';
import { equipmentSet, ROBOT_ID, SENSOR_ID, FACILITY_ID } from '../support/builders.ts';
import { createTestContext, TEST_NOW, TEST_USER } from '../support/test-context.ts';

type FileSource = Parameters<typeof createIngestionService>[0]['fileSource'];

/** 指定した名前のファイルを持ち、内容は空の JSON オブジェクトを返す、ファイルサーバーのスタブ。 */
function stubFileSource(names: readonly string[]): FileSource {
  return {
    testConnection: () => Promise.resolve(),
    listFiles: () =>
      Promise.resolve(
        names.map((name) => ({ fileId: name, name, modifiedAt: TEST_NOW, sizeBytes: 1 })),
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
    ingestionSettings: createIngestionSettings(repositories.settings, 15),
    fileSource,
    profiles,
    evaluation: {
      evaluateAll: vi.fn().mockResolvedValue({}),
      evaluateAffected: vi.fn().mockResolvedValue({}),
    },
    notifications: {
      notifyStatusChange: vi.fn(),
      notifyIngestionFailure,
      list: vi.fn(),
      unreadCount: vi.fn(),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      deliverPending: vi.fn(),
    },
    federation: { enqueue: vi.fn().mockResolvedValue(undefined), runPending: vi.fn() },
    clock: createControllableClock(TEST_NOW),
    ids: createSequentialIdGenerator(),
    settings: { ...DEFAULT_APP_SETTINGS.ingestion, retryBaseDelayMs: 0 },
    logger: NULL_LOGGER,
  });
  return { service, repositories, notifyIngestionFailure };
}

async function setup() {
  const context = await createTestContext();
  for (const equipment of equipmentSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  return context;
}

async function observationsOf(context: Awaited<ReturnType<typeof setup>>, equipmentId = ROBOT_ID) {
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
    context.placeFixture('robot', 'robot/robot-sample-001.json');

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({
      result: 'SUCCESS',
      filesProcessed: 1,
      recordCount: 14,
      rejectedCount: 0,
      attempts: 1,
    });
    const observations = await observationsOf(context);
    expect(observations).toHaveLength(14);
    expect(
      observations.every(
        (item) => item.source === 'AUTO_IMPORT' && item.sourceFileId === 'robot-sample-001.json',
      ),
    ).toBe(true);
    // 解釈に使った版（仮決め）を、観測値に残す
    expect(observations[0]?.formatProfileVersion).toBe('robot-json@0.1.0(PROVISIONAL)');
    const latest = await context.container.repositories.evaluations.listLatest(FACILITY_ID);
    expect(latest.length).toBeGreaterThan(0);
  });

  it('取り込みログに、成功・件数・解釈の版を記録する', async () => {
    const context = await setup();
    context.placeFixture('robot', 'robot/robot-sample-001.json');

    await context.container.ingestionService.runSource('robot');

    const logs = await context.container.repositories.ingestion.listLogs({}, { limit: 10 });
    expect(logs.items[0]).toMatchObject({
      sourceId: 'robot',
      result: 'SUCCESS',
      filesProcessed: 1,
      recordCount: 14,
      formatProfileVersion: 'robot-json@0.1.0(PROVISIONAL)',
    });
  });

  it('同じファイルを、重複して取り込まない', async () => {
    const context = await setup();
    context.placeFixture('robot', 'robot/robot-sample-001.json');
    await context.container.ingestionService.runSource('robot');

    const again = await context.container.ingestionService.runSource('robot');

    expect(again).toMatchObject({ filesProcessed: 0, recordCount: 0, result: 'SUCCESS' });
    expect(await observationsOf(context)).toHaveLength(14);
  });

  it('名前が違っても内容が同じファイルは取り込まない。内容が変わったファイルは新しい版として取り込む', async () => {
    const context = await setup();
    context.placeFixture('robot', 'robot/robot-sample-001.json');
    await context.container.ingestionService.runSource('robot');
    context.placeFixture('robot', 'robot/robot-sample-001.json', 'copy-of-001.json');

    const copied = await context.container.ingestionService.runSource('robot');
    context.placeFile(
      'robot',
      'robot-sample-001.json',
      JSON.stringify({
        robotId: 'ROBOT-SAMPLE-01',
        records: [{ timestamp: '2026-10-09T01:00:00Z', harvestCount: 20 }],
      }),
    );
    const updated = await context.container.ingestionService.runSource('robot');

    expect(copied.filesProcessed).toBe(0);
    expect(updated).toMatchObject({ filesProcessed: 1, recordCount: 1 });
    // 観測値の一意キーが同じ（設備・項目・計測日時・取得元）ため、上書きされ、二重に数えない
    const harvest = (await observationsOf(context)).filter(
      (item) => item.itemKey === 'harvestCount' && item.observedAt === '2026-10-09T01:00:00.000Z',
    );
    expect(harvest.map((item) => item.value)).toEqual([20]);
  });

  it('欠損・不正な値を区別して記録し、評価に使う値は有効な値だけにする', async () => {
    const context = await setup();
    context.placeFixture('robot', 'robot/robot-sample-002-partial.json');
    // 計測の直後（遅延にならない時刻）に取り込む
    context.clock.set(new Date('2026-10-09T02:05:00Z'));

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({
      result: 'PARTIAL',
      filesProcessed: 1,
      recordCount: 7,
      rejectedCount: 4,
    });
    const observations = await observationsOf(context);
    const byQuality = (quality: string) => observations.filter((item) => item.quality === quality);
    expect(byQuality('VALID')).toHaveLength(7);
    expect(byQuality('MISSING').map((item) => [item.itemKey, item.value])).toEqual([
      ['harvestCount', null],
    ]);
    expect(
      byQuality('INVALID')
        .map((item) => item.itemKey)
        .sort(),
    ).toEqual(['harvestCount', 'statusCode']);
    // 不正な値は、元の値を残す（調査できるように）
    expect(byQuality('INVALID').find((item) => item.itemKey === 'harvestCount')?.value).toBe(-3);
  });

  it('形式違いのファイルは、失敗として記録し、他のファイルの取り込みを継続する', async () => {
    const context = await setup();
    context.placeFixture('robot', 'robot/robot-sample-003-broken.json');
    context.placeFixture('robot', 'robot/robot-sample-001.json');

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'PARTIAL', filesProcessed: 2, recordCount: 14 });
    const logs = await context.container.repositories.ingestion.listLogs({}, { limit: 10 });
    expect(logs.items[0]?.errorMessage).toBe('1件のファイルを取り込めませんでした');
    // 同じ形式違いのファイルは、再び取り込もうとしない
    expect((await context.container.ingestionService.runSource('robot')).filesProcessed).toBe(0);
  });

  it('形式違いのファイルだけのとき、取り込み結果は失敗にする', async () => {
    const context = await setup();
    context.placeFixture('robot', 'robot/robot-sample-003-broken.json');

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'FAILURE', recordCount: 0, rejectedCount: 1 });
  });

  it('登録されていない設備（外部の識別子が未登録）のデータは、読み取れなかったものとして数える', async () => {
    const context = await setup();
    context.placeFile(
      'robot',
      'unknown.json',
      JSON.stringify({
        robotId: 'ROBOT-NOT-REGISTERED',
        records: [{ timestamp: '2026-10-09T01:00:00Z', harvestCount: 1 }],
      }),
    );

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ recordCount: 0, rejectedCount: 1 });
    expect(await observationsOf(context)).toHaveLength(0);
  });

  it('削除した設備のデータ上の識別子のデータは、取り込みの対象から外れ、読み取れなかったものとして数える（UC-12）', async () => {
    const context = await setup();
    await context.container.equipmentService.delete(ROBOT_ID, toUserId(TEST_USER.userId));
    context.placeFixture('robot', 'robot/robot-sample-001.json');

    const summary = await context.container.ingestionService.runSource('robot');

    // ファイルの2件のレコードは、どちらも対応する設備がなく、除外される
    expect(summary).toMatchObject({ recordCount: 0, rejectedCount: 2 });
    expect(await observationsOf(context)).toHaveLength(0);
  });

  it('カタログにない項目は、保存せず、読み取れなかったものとして数える', async () => {
    const { service, repositories } = build(stubFileSource(['x.json']), {
      get: () => ({
        profileId: 'robot-json',
        version: 'test',
        status: 'PROVISIONAL',
        versionLabel: 'robot-json@test(PROVISIONAL)',
        parse: () => ({
          records: [
            {
              externalId: 'ROBOT-SAMPLE-01',
              observedAt: '2026-10-09T01:00:00Z',
              fields: { notInCatalog: 1, harvestCount: 2 },
            },
          ],
          rejectedCount: 0,
        }),
      }),
    });
    const [, robot] = equipmentSet();
    if (robot === undefined) {
      throw new Error('テストの前提');
    }
    await repositories.equipment.save(robot);

    const summary = await service.runSource('robot');

    expect(summary).toMatchObject({ recordCount: 1, rejectedCount: 1 });
    expect(
      (await repositories.observations.query({}, { limit: 10 })).items.map((item) => item.itemKey),
    ).toEqual(['harvestCount']);
  });

  it('計測から60分を超えて届いたデータは、遅延として区別して記録し、評価には使う', async () => {
    const context = await setup();
    context.placeFixture('robot', 'robot/robot-sample-001.json');
    // 計測（01:00・01:15）から、1時間以上あとの 03:00 に届く

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
    context.placeFixture('robot', 'robot/robot-sample-001.json');

    await context.container.ingestionService.runSource('robot');

    const due = await context.container.repositories.federation.listDue(
      new Date(TEST_NOW.getTime() + 1000),
      100,
    );
    expect(due.filter((item) => item.targetType === 'OBSERVATION')).toHaveLength(1);
  });
});

describe('UC-09 環境センサーデータの自動取り込み', () => {
  it('CSV を読み、センサーに紐づけて保存する。空の値は欠損として記録する', async () => {
    const context = await setup();
    context.placeFixture('environment-sensor', 'environment-sensor/sensor-sample-001.csv');

    const summary = await context.container.ingestionService.runSource('environment-sensor');

    expect(summary).toMatchObject({
      result: 'PARTIAL',
      filesProcessed: 1,
      recordCount: 11,
      rejectedCount: 1,
    });
    const observations = await observationsOf(context, SENSOR_ID);
    expect(observations).toHaveLength(12);
    expect(observations.filter((item) => item.quality === 'MISSING')).toHaveLength(1);
    expect(observations[0]?.formatProfileVersion).toBe('environment-sensor-csv@0.1.0(PROVISIONAL)');
  });

  it('範囲外・数値でない値・列の欠けた行・未登録のセンサーを区別して扱う', async () => {
    const context = await setup();
    context.placeFixture('environment-sensor', 'environment-sensor/sensor-sample-002-invalid.csv');

    const summary = await context.container.ingestionService.runSource('environment-sensor');

    // 温度 abc、湿度 120 は不正。列数の違う行 1、未登録のセンサー 1 は読み取れなかった
    expect(summary).toMatchObject({ recordCount: 2, rejectedCount: 4 });
    expect(
      (await observationsOf(context, SENSOR_ID))
        .filter((item) => item.quality === 'INVALID')
        .map((item) => item.itemKey)
        .sort(),
    ).toEqual(['humidityPercent', 'temperatureCelsius']);
  });

  it('見出しが仕様と異なる CSV は、形式違いとして扱う', async () => {
    const context = await setup();
    context.placeFixture(
      'environment-sensor',
      'environment-sensor/sensor-sample-003-bad-header.csv',
    );

    expect(await context.container.ingestionService.runSource('environment-sensor')).toMatchObject({
      result: 'FAILURE',
    });
  });

  it('取り込んだ環境の値から、環境適応性が評価される', async () => {
    const context = await setup();
    context.placeFixture('environment-sensor', 'environment-sensor/sensor-sample-001.csv');
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
    context.container.dev?.faults.fileServer.set({ mode: 'DOWN' });
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

  it('同じ取り込み元の失敗は、抑制の期間内は繰り返し通知しない', async () => {
    const context = await setup();
    context.container.dev?.faults.fileServer.set({ mode: 'DOWN' });

    await context.container.ingestionService.runSource('robot');
    await context.container.ingestionService.runSource('robot');

    expect(
      await context.container.repositories.notifications.unreadCount(toUserId(TEST_USER.userId)),
    ).toBe(1);
    context.clock.advance(61 * 60_000);
    await context.container.ingestionService.runSource('robot');
    expect(
      await context.container.repositories.notifications.unreadCount(toUserId(TEST_USER.userId)),
    ).toBe(2);
  });

  it('接続できない取り込み元があっても、他の取り込み元の取り込みは継続できる（取り込み元ごとに独立）', async () => {
    const context = await setup();
    context.placeFixture('environment-sensor', 'environment-sensor/sensor-sample-001.csv');
    context.container.dev?.faults.fileServer.set({ mode: 'DOWN' });
    const failed = await context.container.ingestionService.runSource('robot');
    context.container.dev?.faults.fileServer.set({ mode: 'UP' });

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
    await expect(context.container.ingestionService.testConnection('none')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('実行中の取り込み元を重ねて実行すると、競合（二重実行の防止）にする', async () => {
    const context = await setup();
    context.container.dev?.faults.fileServer.set({ mode: 'SLOW', delayMs: 10 });

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

  it('接続テスト: 成功と失敗を、内部情報を含まないメッセージで返す', async () => {
    const context = await setup();
    context.placeFixture('robot', 'robot/robot-sample-001.json');

    const ok = await context.container.ingestionService.testConnection('robot');
    context.container.dev?.faults.fileServer.set({ mode: 'DOWN' });
    const ng = await context.container.ingestionService.testConnection('robot');

    expect(ok).toEqual({ ok: true, message: '接続できました' });
    expect(ng.ok).toBe(false);
    expect(ng.message).not.toContain('ファイルサーバーに接続できません');
    expect(ng.message).toContain('接続先と認証情報の設定を確認');
  });

  it('スケジューラからの実行: 取得間隔が来た取り込み元だけ実行する', async () => {
    const context = await setup();
    context.placeFixture('robot', 'robot/robot-sample-001.json');

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

    await expect(service.runDueSources()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    const logs = await repositories.ingestion.listLogs(
      { sourceId: 'environment-sensor' },
      { limit: 10 },
    );
    expect(logs.items).toHaveLength(1);
  });

  it('無効にした取り込み元は、スケジューラから実行しない', async () => {
    const context = await setup();
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
    context.placeFixture('robot', 'robot/robot-sample-001.json');
    const spy = vi
      .spyOn(context.container.evaluationService, 'evaluateAffected')
      .mockRejectedValue(new Error('評価の失敗'));

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary.result).toBe('SUCCESS');
    expect(spy).toHaveBeenCalled();
  });

  it('取り込み設定の保存がなければ既定の取り込み元（ロボット・環境センサー）を返し、保存した設定を優先する', async () => {
    const context = await setup();

    const defaults = await context.container.ingestionSettings.listSources();
    const [robotSource] = defaults;
    if (robotSource === undefined) {
      throw new Error('テストの前提');
    }
    await context.container.ingestionSettings.saveSources([
      { ...robotSource, intervalMinutes: 60 },
    ]);
    const saved = await context.container.ingestionSettings.listSources();

    expect(defaults.map((source) => [source.sourceId, source.intervalMinutes])).toEqual([
      ['robot', 15],
      ['environment-sensor', 15],
    ]);
    expect(saved).toEqual([{ ...robotSource, intervalMinutes: 60 }]);
  });
});

describe('取り込みの境界（スタブのファイル取得）', () => {
  it('ファイルを読めなかった場合は、そのファイルを失敗として数え、取り込みは失敗にする', async () => {
    const { service, repositories } = build({
      testConnection: () => Promise.resolve(),
      listFiles: () =>
        Promise.resolve([{ fileId: 'a.json', name: 'a.json', modifiedAt: TEST_NOW, sizeBytes: 1 }]),
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
      testConnection: () => Promise.resolve(),
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
    });
  });

  it('形式違い以外の想定外のエラーは、握りつぶさず、呼び出し元へ伝える', async () => {
    const { service, repositories } = build({
      testConnection: () => Promise.resolve(),
      listFiles: () =>
        Promise.resolve([{ fileId: 'a.json', name: 'a.json', modifiedAt: TEST_NOW, sizeBytes: 1 }]),
      readFile: () => Promise.resolve(JSON.stringify({ robotId: 'R', records: [] })),
    });
    vi.spyOn(repositories.observations, 'saveMany').mockRejectedValue(new Error('保存の失敗'));

    await expect(service.runSource('robot')).rejects.toThrow('保存の失敗');
  });
});
