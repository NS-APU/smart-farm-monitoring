/**
 * 取り込みの信頼性（レビュー V-017〜V-020・V-042・V-044・V-046・V-052・V-057・V-058）の結合テスト。
 * 失敗の通知、データ供給の停止の検知、構造の変更・日時の解釈、外部通信のタイムアウト、想定外の例外、ファイルの大きさの上限。
 */

import { describe, expect, it, vi } from 'vitest';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { createIngestionService } from '../../src/backend/application/ingestion/ingestion-service.ts';
import { createIngestionSettings } from '../../src/backend/application/ingestion/ingestion-settings.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { DEFAULT_APP_SETTINGS } from '../../src/backend/application/settings.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import { createDefaultFormatProfileRegistry } from '../../src/backend/infrastructure/format-profiles/declarative-profile.ts';
import { equipmentSet, ROBOT_ID } from '../support/builders.ts';
import {
  createTestContext,
  TEST_NOW,
  TEST_USER,
  type TestContext,
} from '../support/test-context.ts';

type FileSource = Parameters<typeof createIngestionService>[0]['fileSource'];

const ROBOT_FILE = JSON.stringify({
  robotId: 'ROBOT-SAMPLE-01',
  records: [{ timestamp: '2026-10-09T01:00:00Z', harvestCount: 12 }],
});

function metaOf(name: string, sizeBytes = 1) {
  return { fileId: name, name, modifiedAt: TEST_NOW, sizeBytes };
}

/** ポートをスタブにした取り込みサービス（外部通信・想定外の例外の検証用）。 */
async function build(
  fileSource: FileSource,
  options: {
    settings?: Partial<typeof DEFAULT_APP_SETTINGS.ingestion>;
    saveManyFails?: boolean;
  } = {},
) {
  const { repositories } = createLocalRepositories();
  for (const equipment of equipmentSet()) {
    await repositories.equipment.save(equipment);
  }
  if (options.saveManyFails === true) {
    repositories.observations.saveMany = () => Promise.reject(new TypeError('保存に失敗'));
  }
  const notifyIngestionFailure = vi.fn().mockResolvedValue(null);
  const logs: { message: string; fields: unknown }[] = [];
  const logger = {
    ...NULL_LOGGER,
    error: (message: string, fields?: unknown) => logs.push({ message, fields }),
  };
  const clock = createControllableClock(TEST_NOW);
  const service = createIngestionService({
    repositories,
    ingestionSettings: createIngestionSettings(repositories.settings, 15),
    fileSource,
    profiles: createDefaultFormatProfileRegistry(),
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
    clock,
    ids: createSequentialIdGenerator(),
    settings: { ...DEFAULT_APP_SETTINGS.ingestion, retryBaseDelayMs: 0, ...options.settings },
    logger,
  });
  return { service, repositories, notifyIngestionFailure, logs, clock };
}

function stubSource(overrides: Partial<FileSource> = {}): FileSource {
  return {
    testConnection: () => Promise.resolve(),
    listFiles: () => Promise.resolve([metaOf('robot.json')]),
    readFile: () => Promise.resolve(ROBOT_FILE),
    ...overrides,
  };
}

const NEVER = new Promise<never>(() => undefined);

async function setup(env: Record<string, string> = {}): Promise<TestContext> {
  const context = await createTestContext({ env });
  for (const equipment of equipmentSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  return context;
}

async function notificationsOf(context: TestContext) {
  return (
    await context.container.notificationService.list(toUserId(TEST_USER.userId), { limit: 50 })
  ).items;
}

async function stoppedNotificationsOf(context: TestContext) {
  return (await notificationsOf(context)).filter((item) => item.message.includes('データ取得停止'));
}

describe('取り込み失敗の通知（V-017。FR-7.4）', () => {
  it('形式が仕様と異なるファイルだけの取り込み（失敗）でも、取り込み失敗を通知する', async () => {
    const context = await setup({ INGESTION_FILE_FAILURE_NOTIFICATION_ENABLED: 'true' });
    context.placeFixture('robot', 'robot/robot-sample-003-broken.json');

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary.result).toBe('FAILURE');
    const notifications = await notificationsOf(context);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: 'INGESTION_FAILURE', sourceId: 'robot' });
    expect(notifications[0]?.message).toContain('形式が仕様と異なる');
  });

  it('既定（設定なし）では、ファイル単位の失敗（形式違い）を通知しない（UC-24 の仕様。通知の条件は発注者の確認待ち）', async () => {
    const context = await setup();
    context.placeFixture('robot', 'robot/robot-sample-003-broken.json');

    await context.container.ingestionService.runSource('robot');

    expect(await notificationsOf(context)).toEqual([]);
  });

  it('ファイルを読めなかった場合も、取り込み失敗を通知する（内部情報を含めない）', async () => {
    const { service, notifyIngestionFailure } = await build(
      stubSource({ readFile: () => Promise.reject(new Error('/secret/path: EACCES')) }),
      { settings: { notifyFileFailures: true } },
    );

    await service.runSource('robot');

    expect(notifyIngestionFailure).toHaveBeenCalledTimes(1);
    const input = notifyIngestionFailure.mock.calls[0]?.[0] as { reason: string };
    expect(input.reason).toBe('ファイルを読めませんでした');
    expect(input.reason).not.toContain('secret');
  });

  it('一部のファイルだけ失敗した（PARTIAL の）場合も通知する。すべて成功なら通知しない', async () => {
    const files = [metaOf('ok.json'), metaOf('ng.json')];
    const partial = await build(
      stubSource({
        listFiles: () => Promise.resolve(files),
        readFile: (_sourceId, fileId) =>
          fileId === 'ng.json' ? Promise.reject(new Error('x')) : Promise.resolve(ROBOT_FILE),
      }),
      { settings: { notifyFileFailures: true } },
    );
    const success = await build(stubSource(), { settings: { notifyFileFailures: true } });

    const partialSummary = await partial.service.runSource('robot');
    const successSummary = await success.service.runSource('robot');

    expect(partialSummary.result).toBe('PARTIAL');
    expect(partial.notifyIngestionFailure).toHaveBeenCalledTimes(1);
    expect(successSummary.result).toBe('SUCCESS');
    expect(success.notifyIngestionFailure).not.toHaveBeenCalled();
  });
});

describe('データ供給の停止の検知（V-018。無音の停止）', () => {
  const INTERVAL_MINUTES = 15;
  const THRESHOLD_MINUTES = INTERVAL_MINUTES * DEFAULT_APP_SETTINGS.staleAfterIntervals;

  async function ingestOnce(context: TestContext) {
    context.placeFixture('robot', 'robot/robot-sample-001.json');
    await context.container.ingestionService.runSource('robot');
  }

  it('新しいデータの取り込みが、取得間隔×基準の倍数を超えて止まったら、データ取得の停止を通知する', async () => {
    const context = await setup();
    await ingestOnce(context);

    context.clock.advance((THRESHOLD_MINUTES + 1) * 60_000);
    await context.container.ingestionService.runDueSources();

    const stopped = (await notificationsOf(context)).filter((item) =>
      item.message.includes('データ取得停止'),
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ kind: 'INGESTION_FAILURE', sourceId: 'robot' });
    expect(stopped[0]?.message).toContain('ロボットデータ');
  });

  it('基準の期間内は通知しない。同じ停止を、抑制の期間内に繰り返し通知しない', async () => {
    const context = await setup();
    await ingestOnce(context);

    context.clock.advance((THRESHOLD_MINUTES - 1) * 60_000);
    await context.container.ingestionService.runDueSources();
    expect(
      (await notificationsOf(context)).filter((item) => item.message.includes('データ取得停止')),
    ).toHaveLength(0);

    context.clock.advance(2 * 60_000);
    await context.container.ingestionService.runDueSources();
    context.clock.advance(20 * 60_000);
    await context.container.ingestionService.runDueSources();
    expect(
      (await notificationsOf(context)).filter((item) => item.message.includes('データ取得停止')),
    ).toHaveLength(1);
  });

  it('一度もデータを取り込んでいない取り込み元（未取得）は、通知しない', async () => {
    const context = await setup();

    context.clock.advance(7 * 24 * 60 * 60_000);
    await context.container.ingestionService.runDueSources();

    expect(await notificationsOf(context)).toEqual([]);
  });

  it('環境変数で、停止の通知を無効にできる', async () => {
    const context = await setup({ INGESTION_STOP_NOTIFICATION_ENABLED: 'false' });
    await ingestOnce(context);

    context.clock.advance((THRESHOLD_MINUTES + 1) * 60_000);
    await context.container.ingestionService.runDueSources();

    expect(await stoppedNotificationsOf(context)).toEqual([]);
  });

  it('無効にした取り込み元は、停止していても通知しない', async () => {
    const context = await setup();
    await ingestOnce(context);
    const sources = await context.container.ingestionSettings.listSources();
    await context.container.ingestionSettings.saveSources(
      sources.map((source) => ({ ...source, isEnabled: false })),
    );

    context.clock.advance((THRESHOLD_MINUTES + 1) * 60_000);
    await context.container.ingestionService.runDueSources();

    expect(await stoppedNotificationsOf(context)).toEqual([]);
  });
});

describe('構造の変更の検出（V-019）', () => {
  it('項目名がすべて変わり、1つも読み取れないファイルは、形式違いとして失敗にする（0件の成功にしない）', async () => {
    const context = await setup();
    context.placeFile(
      'robot',
      'renamed.json',
      JSON.stringify({
        robotId: 'ROBOT-SAMPLE-01',
        records: [{ timestamp: '2026-10-09T01:00:00Z', harvest_total: 12, state: 'RUNNING' }],
      }),
    );

    const summary = await context.container.ingestionService.runSource('robot');

    expect(summary).toMatchObject({ result: 'FAILURE', recordCount: 0 });
    const logs = await context.container.repositories.ingestion.listLogs({}, { limit: 5 });
    expect(logs.items[0]?.errorMessage).toContain('取り込めませんでした');
  });

  it('列名が変わった CSV も、形式違いとして失敗にする', async () => {
    const context = await setup();
    context.placeFile(
      'environment-sensor',
      'renamed.csv',
      'sensor_id,timestamp,temp,humid\nSENSOR-SAMPLE-01,2026-10-09T01:00:00Z,20,50\n',
    );

    const summary = await context.container.ingestionService.runSource('environment-sensor');

    expect(summary.result).toBe('FAILURE');
  });
});

describe('計測日時の解釈（V-020）', () => {
  it('タイムゾーンのない日時は、実行環境のタイムゾーン（TZ）に関係なく、日本時間として解釈する', async () => {
    const original = process.env.TZ;
    const observedAtUnder = async (timeZone: string) => {
      process.env.TZ = timeZone;
      const context = await setup();
      context.placeFile(
        'robot',
        'local-time.json',
        JSON.stringify({
          robotId: 'ROBOT-SAMPLE-01',
          records: [{ timestamp: '2026-10-09T10:00:00', harvestCount: 12 }],
        }),
      );
      await context.container.ingestionService.runSource('robot');
      const saved = await context.container.repositories.observations.query(
        { equipmentIds: [ROBOT_ID], includeDeleted: true },
        { limit: 10 },
      );
      return saved.items.map((item) => item.observedAt);
    };
    try {
      const underUtc = await observedAtUnder('UTC');
      const underTokyo = await observedAtUnder('Asia/Tokyo');

      expect(underUtc).toEqual(['2026-10-09T01:00:00.000Z']);
      expect(underTokyo).toEqual(underUtc);
    } finally {
      if (original === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = original;
      }
    }
  });
});

describe('外部通信のタイムアウト（V-042）', () => {
  it('ファイル一覧の取得が応答しない場合も、タイムアウトして失敗として記録・通知する（再試行のあと）', async () => {
    const { service, notifyIngestionFailure, repositories } = await build(
      stubSource({ listFiles: () => NEVER }),
      { settings: { ioTimeoutMs: 20, maxAttempts: 2 } },
    );

    const summary = await service.runSource('robot');

    expect(summary).toMatchObject({ result: 'FAILURE', attempts: 2 });
    expect(notifyIngestionFailure).toHaveBeenCalledTimes(1);
    const logs = await repositories.ingestion.listLogs({}, { limit: 5 });
    expect(logs.items[0]?.errorMessage).toBe('ファイルサーバーに接続できませんでした');
  });

  it('ファイルの読み取りが応答しない場合は、そのファイルを失敗として扱い、次のファイルを処理する', async () => {
    const { service, notifyIngestionFailure } = await build(
      stubSource({
        listFiles: () => Promise.resolve([metaOf('hang.json'), metaOf('ok.json')]),
        readFile: (_sourceId, fileId) =>
          fileId === 'hang.json' ? NEVER : Promise.resolve(ROBOT_FILE),
      }),
      { settings: { ioTimeoutMs: 20, notifyFileFailures: true } },
    );

    const summary = await service.runSource('robot');

    expect(summary).toMatchObject({ result: 'PARTIAL', filesProcessed: 2 });
    expect(notifyIngestionFailure).toHaveBeenCalledTimes(1);
  });
});

describe('想定外の例外（V-046）', () => {
  it('ファイルの保存で想定外の例外が起きたら、原因のログと、失敗の取り込みログ・通知を残してから、呼び出し元へ伝える', async () => {
    const { service, notifyIngestionFailure, repositories, logs } = await build(stubSource(), {
      saveManyFails: true,
    });

    await expect(service.runSource('robot')).rejects.toThrow(TypeError);

    expect(notifyIngestionFailure).toHaveBeenCalledTimes(1);
    const savedLogs = (await repositories.ingestion.listLogs({}, { limit: 5 })).items;
    expect(savedLogs).toHaveLength(1);
    expect(savedLogs[0]).toMatchObject({
      result: 'FAILURE',
      errorMessage: 'ファイルの取り込み中にエラーが発生しました',
    });
    expect(logs[0]).toMatchObject({
      message: 'ファイルの取り込みに失敗しました',
      fields: { sourceId: 'robot', fileId: 'robot.json', errorName: 'TypeError' },
    });
  });
});

describe('ファイルの大きさの上限（V-057）', () => {
  it('上限を超えるファイルは、読まずに失敗として扱い、通知する。上限以下のファイルは取り込む', async () => {
    const readFile = vi.fn().mockResolvedValue(ROBOT_FILE);
    const { service, notifyIngestionFailure } = await build(
      stubSource({
        listFiles: () => Promise.resolve([metaOf('huge.json', 101), metaOf('ok.json', 100)]),
        readFile,
      }),
      { settings: { maxFileBytes: 100, notifyFileFailures: true } },
    );

    const summary = await service.runSource('robot');

    expect(summary).toMatchObject({ result: 'PARTIAL', filesProcessed: 2 });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith('robot', 'ok.json');
    const input = notifyIngestionFailure.mock.calls[0]?.[0] as { reason: string };
    expect(input.reason).toBe('ファイルが大きすぎるため、読み込めませんでした');
  });
});

describe('複数の取り込み元の失敗（V-058）', () => {
  it('複数の取り込み元で想定外のエラーが起きたら、すべてをまとめて（AggregateError）呼び出し元へ伝える', async () => {
    // 一覧の取得の失敗は、失敗の結果として扱われるため、想定外のエラーは、設備の一覧の取得で起こす
    const failing = await build(stubSource());
    failing.repositories.equipment.list = () => Promise.reject(new RangeError('設備の取得に失敗'));

    await expect(failing.service.runDueSources()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.any(RangeError), expect.any(RangeError)],
    });
  });
});
