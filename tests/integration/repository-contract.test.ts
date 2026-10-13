/**
 * Repository の契約テスト。ポート（application/ports/repositories.ts）の振る舞いを、実装ごとに検証する。
 * いまはローカル実装（メモリ、ファイル永続化）。DynamoDB の実装を追加する際は、同じテストを適用する
 * （architecture.md 14章「DBアダプタは Repository の契約テストを共通にする」）。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '@smart-farm/shared/errors';
import { NotificationIdSchema, toEquipmentId, toUserId } from '@smart-farm/shared/schemas/common';
import type { ManualEntry } from '@smart-farm/shared/schemas/manual-entry';
import type { Notification } from '@smart-farm/shared/schemas/notification';
import type { EvaluationResult } from '@smart-farm/shared/schemas/evaluation';
import type { Repositories } from '../../src/backend/application/ports/repositories.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import { equipmentSet, observation, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';

interface Subject {
  readonly repositories: Repositories;
  flush(): void;
}

const FACTORIES: readonly { readonly name: string; readonly create: () => Subject }[] = [
  {
    name: 'メモリ',
    create() {
      const { repositories, store } = createLocalRepositories();
      return {
        repositories,
        flush: () => {
          store.flush();
        },
      };
    },
  },
  {
    name: 'ファイル永続化',
    create() {
      const filePath = join(mkdtempSync(join(tmpdir(), 'smart-farm-repo-')), 'store.json');
      const { repositories, store } = createLocalRepositories({ filePath, flushDelayMs: 0 });
      return {
        repositories,
        flush: () => {
          store.flush();
        },
      };
    },
  },
];

const USER = toUserId('user-1');
const OTHER_USER = toUserId('user-2');

function notification(id: string, overrides: Partial<Notification> = {}): Notification {
  return {
    notificationId: NotificationIdSchema.parse(id),
    kind: 'STATUS_CHANGE',
    viewpointId: 'safety',
    equipmentId: ROBOT_ID,
    status: 'ERROR',
    message: `通知 ${id}`,
    createdAt: `2026-10-09T0${id.slice(-1)}:00:00.000Z`,
    dedupKey: `key-${id}`,
    deliveries: [
      {
        channel: 'WEB_PUSH',
        result: 'PENDING',
        attempts: 0,
        updatedAt: '2026-10-09T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function evaluationResult(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    equipmentId: ROBOT_ID,
    viewpointId: 'safety',
    horizon: 'SHORT',
    periodDays: null,
    status: 'NORMAL',
    metrics: { emergencyStopPerHour: 0 },
    indicatorStatuses: { emergencyStopPerHour: 'NORMAL' },
    statusDetail: null,
    diagnosticMessage: '正常',
    recommendedAction: '維持',
    criteriaVersion: 'DEFAULT',
    isCustomCriteria: false,
    evaluatedFrom: '2026-10-08T03:00:00.000Z',
    evaluatedTo: '2026-10-09T03:00:00.000Z',
    evaluatedAt: '2026-10-09T03:00:00.000Z',
    ...overrides,
  };
}

describe.each(FACTORIES)('Repository の契約（$name）', ({ create }) => {
  it('設備: 保存・取得でき、論理削除は一覧から除く（指定すれば含める）', async () => {
    const { repositories } = create();
    const [facility, robot] = equipmentSet();
    if (facility === undefined || robot === undefined) {
      throw new Error('テストの前提');
    }

    await repositories.equipment.save(facility);
    await repositories.equipment.save(robot);
    await repositories.equipment.save({ ...robot, isDeleted: true });

    expect(await repositories.equipment.get(facility.equipmentId)).toEqual(facility);
    expect(await repositories.equipment.get(toEquipmentId('NONE'))).toBeUndefined();
    expect(await repositories.equipment.list()).toEqual([facility]);
    expect(await repositories.equipment.list({ includeDeleted: true })).toHaveLength(2);
  });

  it('ステータスコード: 保存・取得でき、論理削除は一覧から除く', async () => {
    const { repositories } = create();
    await repositories.statusCodes.save({
      code: 'A',
      name: 'a',
      category: 'NORMAL',
      isDeleted: false,
    });
    await repositories.statusCodes.save({
      code: 'B',
      name: 'b',
      category: 'ERROR',
      isDeleted: true,
    });

    expect(await repositories.statusCodes.get('A')).toMatchObject({ name: 'a' });
    expect(await repositories.statusCodes.get('Z')).toBeUndefined();
    expect((await repositories.statusCodes.list()).map((item) => item.code)).toEqual(['A']);
    expect(await repositories.statusCodes.list({ includeDeleted: true })).toHaveLength(2);
  });

  it('判断基準: 変更後の値を保存・取得・削除できる', async () => {
    const { repositories } = create();
    const criteria = {
      viewpointId: 'safety' as const,
      criteria: [
        {
          indicator: 'a',
          kind: 'UPPER' as const,
          thresholds: { cautionFrom: 1, errorFrom: 2 },
          label: 'a',
        },
      ],
      version: 'v1',
      isDefault: false,
    };

    await repositories.criteria.save(criteria);
    expect(await repositories.criteria.get('safety')).toEqual(criteria);
    await repositories.criteria.delete('safety');
    expect(await repositories.criteria.get('safety')).toBeUndefined();
  });

  describe('観測値', () => {
    async function seeded() {
      const subject = create();
      const { observations } = subject.repositories;
      await observations.saveMany([
        observation({
          itemKey: 'harvestCount',
          value: 3,
          observedAt: '2026-10-09T01:00:00.000Z',
          receivedAt: '2026-10-09T01:10:00.000Z',
        }),
        observation({
          itemKey: 'harvestCount',
          value: 1,
          observedAt: '2026-10-09T02:00:00.000Z',
          receivedAt: '2026-10-09T02:10:00.000Z',
        }),
        observation({
          itemKey: 'operatingHours',
          value: 2,
          observedAt: '2026-10-09T02:00:00.000Z',
        }),
        observation({
          itemKey: 'failureCount',
          value: 1,
          source: 'MANUAL',
          observedAt: '2026-10-09T02:30:00.000Z',
        }),
        observation({
          itemKey: 'statusCode',
          value: 'RUNNING',
          observedAt: '2026-10-09T02:40:00.000Z',
        }),
        observation({
          equipmentId: SENSOR_ID,
          itemKey: 'temperatureCelsius',
          value: 21,
          observedAt: '2026-10-09T02:00:00.000Z',
          receivedAt: '2026-10-09T02:50:00.000Z',
        }),
        observation({
          itemKey: 'harvestCount',
          value: 99,
          observedAt: '2026-10-09T03:00:00.000Z',
          isDeleted: true,
        }),
      ]);
      return subject.repositories;
    }

    it('同じ一意キー（設備・項目・計測日時・取得元）の値は、上書きする', async () => {
      const repositories = await seeded();
      await repositories.observations.saveMany([
        observation({ itemKey: 'harvestCount', value: 30, observedAt: '2026-10-09T01:00:00.000Z' }),
      ]);

      const page = await repositories.observations.query(
        { itemKey: 'harvestCount' },
        { limit: 10 },
        { key: 'observedAt', direction: 'asc' },
      );

      expect(page.items.map((item) => item.value)).toEqual([30, 1]);
    });

    it('評価の入力: 指定した設備・期間の、論理削除でない観測値を返す', async () => {
      const repositories = await seeded();

      const found = await repositories.observations.findForEvaluation(
        [ROBOT_ID],
        new Date('2026-10-09T01:30:00.000Z'),
        new Date('2026-10-09T03:00:00.000Z'),
      );

      expect(found.map((item) => item.itemKey).sort()).toEqual([
        'failureCount',
        'harvestCount',
        'operatingHours',
        'statusCode',
      ]);
      expect(found.every((item) => item.equipmentId === ROBOT_ID && !item.isDeleted)).toBe(true);
    });

    it.each([
      ['カテゴリ', { category: 'HARVEST' as const }, 2],
      ['項目', { itemKey: 'operatingHours' }, 1],
      ['取得元', { source: 'MANUAL' as const }, 1],
      ['設備', { equipmentIds: [SENSOR_ID] }, 1],
      ['期間（開始）', { from: new Date('2026-10-09T02:30:00.000Z') }, 2],
      ['期間（終了）', { to: new Date('2026-10-09T01:00:00.000Z') }, 1],
      ['論理削除を含める', { includeDeleted: true }, 7],
    ])('一覧: %s で絞り込める', async (_name, filter, expectedCount) => {
      const repositories = await seeded();

      const page = await repositories.observations.query(filter, { limit: 50 });

      expect(page.items).toHaveLength(expectedCount);
    });

    it('一覧: 複数の項目（itemKeys）と、アプリ側の追加の条件（matches）で絞り込める', async () => {
      const repositories = await seeded();

      const byItems = await repositories.observations.query(
        { itemKeys: ['harvestCount', 'operatingHours'] },
        { limit: 50 },
      );
      const byPredicate = await repositories.observations.query(
        { matches: (item) => item.value === 21 },
        { limit: 50 },
      );
      const both = await repositories.observations.query(
        { itemKeys: ['harvestCount'], matches: (item) => item.value === 21 },
        { limit: 50 },
      );

      expect(new Set(byItems.items.map((item) => item.itemKey))).toEqual(
        new Set(['harvestCount', 'operatingHours']),
      );
      expect(byPredicate.items.map((item) => item.itemKey)).toEqual(['temperatureCelsius']);
      expect(both.items).toEqual([]);
    });

    it('一覧: 計測日時・カテゴリ・値で並べ替えられる（既定は計測日時の新しい順）', async () => {
      const repositories = await seeded();
      const query = (key: 'observedAt' | 'category' | 'value', direction: 'asc' | 'desc') =>
        repositories.observations.query(
          { equipmentIds: [ROBOT_ID] },
          { limit: 50 },
          { key, direction },
        );

      const byDefault = await repositories.observations.query(
        { itemKey: 'harvestCount' },
        { limit: 50 },
      );
      const byValue = await query('value', 'desc');
      const byCategory = await query('category', 'asc');
      const byTime = await query('observedAt', 'asc');

      expect(byDefault.items.map((item) => item.value)).toEqual([1, 3]);
      expect(byValue.items[0]?.value).toBe(3);
      expect(byCategory.items[0]?.category).toBe('FAILURE');
      expect(byTime.items[0]?.observedAt).toBe('2026-10-09T01:00:00.000Z');
    });

    it('一覧: ページ分割し、次のページのカーソルを返す', async () => {
      const repositories = await seeded();

      const first = await repositories.observations.query({}, { limit: 4 });
      const second = await repositories.observations.query(
        {},
        { limit: 4, cursor: first.nextCursor ?? undefined },
      );

      expect(first.items).toHaveLength(4);
      expect(first.nextCursor).not.toBeNull();
      expect(second.items).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      expect(
        new Set(
          [...first.items, ...second.items].map(
            (item) => `${item.itemKey}${item.observedAt}${item.source}${item.equipmentId}`,
          ),
        ).size,
      ).toBe(6);
    });

    it('一覧: 不正なカーソルは、入力不正（VALIDATION_ERROR）にする', async () => {
      const repositories = await seeded();

      await expect(repositories.observations.query({}, { limit: 5, cursor: '!!' })).rejects.toThrow(
        AppError,
      );
      await expect(
        repositories.observations.query(
          {},
          { limit: 5, cursor: Buffer.from('-3').toString('base64url') },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('最終のデータ取得日時: 受信日時の最大（設備を指定すればその設備のみ）。1件もなければ null', async () => {
      const repositories = await seeded();
      const empty = create().repositories;

      expect(await repositories.observations.latestReceivedAt()).toEqual(
        new Date('2026-10-09T03:00:00.000Z'),
      );
      expect(await repositories.observations.latestReceivedAt([SENSOR_ID])).toEqual(
        new Date('2026-10-09T02:50:00.000Z'),
      );
      expect(await empty.observations.latestReceivedAt()).toBeNull();
    });
  });

  it('評価結果: 観点・視点・期間ごとの最新を上書き保存し、状態の変化を記録できる', async () => {
    const { repositories } = create();
    await repositories.evaluations.saveLatest(evaluationResult());
    await repositories.evaluations.saveLatest(evaluationResult({ status: 'ERROR' }));
    await repositories.evaluations.saveLatest(evaluationResult({ horizon: 'LONG', periodDays: 7 }));

    expect(
      (await repositories.evaluations.getLatest(ROBOT_ID, 'safety', 'SHORT', null))?.status,
    ).toBe('ERROR');
    expect(await repositories.evaluations.getLatest(ROBOT_ID, 'safety', 'LONG', 7)).toBeDefined();
    expect(
      await repositories.evaluations.getLatest(ROBOT_ID, 'safety', 'LONG', 30),
    ).toBeUndefined();
    expect(await repositories.evaluations.listLatest(ROBOT_ID)).toHaveLength(2);
    expect(await repositories.evaluations.listLatest(SENSOR_ID)).toHaveLength(0);

    expect(await repositories.evaluations.getLastStatusChange(ROBOT_ID, 'safety')).toBeUndefined();
    await repositories.evaluations.appendStatusChange({
      equipmentId: ROBOT_ID,
      viewpointId: 'safety',
      status: 'CAUTION',
      changedAt: '2026-10-09T01:00:00.000Z',
    });
    await repositories.evaluations.appendStatusChange({
      equipmentId: ROBOT_ID,
      viewpointId: 'safety',
      status: 'ERROR',
      changedAt: '2026-10-09T02:00:00.000Z',
    });
    expect((await repositories.evaluations.getLastStatusChange(ROBOT_ID, 'safety'))?.status).toBe(
      'ERROR',
    );
    // 状態の変化の履歴は、古い順（ステータスの推移。FR-6.10）。観点・設備ごと
    expect(
      (await repositories.evaluations.listStatusChanges(ROBOT_ID, 'safety')).map(
        (entry) => entry.status,
      ),
    ).toEqual(['CAUTION', 'ERROR']);
    expect(await repositories.evaluations.listStatusChanges(ROBOT_ID, 'durability')).toEqual([]);
    expect(await repositories.evaluations.listStatusChanges(SENSOR_ID, 'safety')).toEqual([]);
  });

  describe('通知', () => {
    async function seeded() {
      const { repositories } = create();
      await repositories.notifications.add(notification('n-1'));
      await repositories.notifications.add(
        notification('n-2', { kind: 'INGESTION_FAILURE', dedupKey: 'same' }),
      );
      await repositories.notifications.add(notification('n-3', { dedupKey: 'same' }));
      return repositories;
    }

    it('新しい順に一覧でき、種別・既読／未読で絞り込める。既読は利用者ごと', async () => {
      const repositories = await seeded();
      expect(
        await repositories.notifications.markRead(
          NotificationIdSchema.parse('n-1'),
          USER,
          new Date('2026-10-09T05:00:00Z'),
        ),
      ).toBe(true);

      const all = await repositories.notifications.list(USER, {}, { limit: 10 });
      const unread = await repositories.notifications.list(
        USER,
        { readState: 'UNREAD' },
        { limit: 10 },
      );
      const read = await repositories.notifications.list(
        USER,
        { readState: 'READ' },
        { limit: 10 },
      );
      const failures = await repositories.notifications.list(
        USER,
        { kind: 'INGESTION_FAILURE' },
        { limit: 10 },
      );
      const otherUserUnread = await repositories.notifications.list(
        OTHER_USER,
        { readState: 'UNREAD' },
        { limit: 10 },
      );

      expect(all.items.map((entry) => entry.notification.notificationId)).toEqual([
        'n-3',
        'n-2',
        'n-1',
      ]);
      expect(unread.items).toHaveLength(2);
      expect(read.items.map((entry) => entry.notification.notificationId)).toEqual(['n-1']);
      expect(failures.items).toHaveLength(1);
      expect(otherUserUnread.items).toHaveLength(3);
    });

    it('未読の件数は、利用者ごとに数える', async () => {
      const repositories = await seeded();
      await repositories.notifications.markRead(
        NotificationIdSchema.parse('n-1'),
        USER,
        new Date(),
      );
      await repositories.notifications.markRead(
        NotificationIdSchema.parse('n-1'),
        USER,
        new Date(),
      );

      expect(await repositories.notifications.unreadCount(USER)).toBe(2);
      expect(await repositories.notifications.unreadCount(OTHER_USER)).toBe(3);
    });

    it('存在しない通知を既読にすると false を返す', async () => {
      const repositories = await seeded();

      expect(
        await repositories.notifications.markRead(
          NotificationIdSchema.parse('none'),
          USER,
          new Date(),
        ),
      ).toBe(false);
    });

    it('一括で既読にでき、絞り込みの範囲のみ既読にする', async () => {
      const repositories = await seeded();

      const failuresOnly = await repositories.notifications.markAllRead(
        USER,
        { kind: 'INGESTION_FAILURE' },
        new Date(),
      );
      const rest = await repositories.notifications.markAllRead(USER, {}, new Date());
      const again = await repositories.notifications.markAllRead(USER, {}, new Date());

      expect(failuresOnly).toBe(1);
      expect(rest).toBe(2);
      expect(again).toBe(0);
      expect(await repositories.notifications.unreadCount(USER)).toBe(0);
    });

    it('同じ重複抑制のキーの、最新の通知を取得できる', async () => {
      const repositories = await seeded();

      expect((await repositories.notifications.findLatestByDedupKey('same'))?.notificationId).toBe(
        'n-3',
      );
      expect(await repositories.notifications.findLatestByDedupKey('none')).toBeUndefined();
      expect((await repositories.notifications.get(NotificationIdSchema.parse('n-2')))?.kind).toBe(
        'INGESTION_FAILURE',
      );
      expect(
        await repositories.notifications.get(NotificationIdSchema.parse('none')),
      ).toBeUndefined();
    });

    it('配信が未完了の通知: 未配信、または試行回数が上限未満の失敗のみ返す', async () => {
      const { repositories } = create();
      const delivery = (result: 'PENDING' | 'SUCCESS' | 'FAILURE', attempts: number) => [
        { channel: 'WEB_PUSH' as const, result, attempts, updatedAt: '2026-10-09T00:00:00.000Z' },
      ];
      await repositories.notifications.add(
        notification('n-1', { deliveries: delivery('PENDING', 0) }),
      );
      await repositories.notifications.add(
        notification('n-2', { deliveries: delivery('SUCCESS', 1) }),
      );
      await repositories.notifications.add(
        notification('n-3', { deliveries: delivery('FAILURE', 2) }),
      );
      await repositories.notifications.add(
        notification('n-4', { deliveries: delivery('FAILURE', 3) }),
      );
      await repositories.notifications.add(notification('n-5', { deliveries: [] }));

      const undelivered = await repositories.notifications.listUndelivered(3);
      await repositories.notifications.update(
        notification('n-1', { deliveries: delivery('SUCCESS', 1) }),
      );
      const afterUpdate = await repositories.notifications.listUndelivered(3);

      expect(undelivered.map((item) => item.notificationId).sort()).toEqual(['n-1', 'n-3']);
      expect(afterUpdate.map((item) => item.notificationId)).toEqual(['n-3']);
    });
  });

  it('取り込み: 同じファイル（識別子とハッシュ、または内容のハッシュ）を、取り込み済みとして判定できる', async () => {
    const { repositories } = create();
    const base = { sourceId: 'robot', fetchedAt: '2026-10-09T01:00:00.000Z', recordCount: 1 };
    await repositories.ingestion.recordFile({
      ...base,
      fileId: 'a.json',
      contentHash: 'h1',
      result: 'SUCCESS',
    });
    await repositories.ingestion.recordFile({
      ...base,
      fileId: 'bad.json',
      contentHash: 'h2',
      result: 'FAILURE',
    });

    expect(await repositories.ingestion.findIngestedFile('robot', 'a.json', 'h1')).toBeDefined();
    // 名前が違っても、内容が同じで取り込みに成功していれば、取り込み済み
    expect(await repositories.ingestion.findIngestedFile('robot', 'copy.json', 'h1')).toBeDefined();
    // 名前が同じでも、内容が変わっていれば、新しい版として取り込む
    expect(
      await repositories.ingestion.findIngestedFile('robot', 'a.json', 'h-new'),
    ).toBeUndefined();
    // 失敗したファイルは、同じ名前・同じ内容のときだけ、取り込み済み（失敗）として判定する
    expect(await repositories.ingestion.findIngestedFile('robot', 'bad.json', 'h2')).toBeDefined();
    expect(
      await repositories.ingestion.findIngestedFile('robot', 'other.json', 'h2'),
    ).toBeUndefined();
    expect(
      await repositories.ingestion.findIngestedFile('environment-sensor', 'a.json', 'h1'),
    ).toBeUndefined();
  });

  it('取り込みログ: 新しい順に一覧でき、取り込み元で絞り込め、直近の開始日時を返す', async () => {
    const { repositories } = create();
    const log = (logId: string, sourceId: string, startedAt: string) => ({
      logId,
      sourceId,
      startedAt,
      finishedAt: startedAt,
      result: 'SUCCESS' as const,
      filesProcessed: 1,
      recordCount: 1,
      rejectedCount: 0,
      attempts: 1,
    });
    await repositories.ingestion.addLog(log('l-1', 'robot', '2026-10-09T01:00:00.000Z'));
    await repositories.ingestion.addLog(log('l-2', 'robot', '2026-10-09T02:00:00.000Z'));
    await repositories.ingestion.addLog(
      log('l-3', 'environment-sensor', '2026-10-09T03:00:00.000Z'),
    );

    const all = await repositories.ingestion.listLogs({}, { limit: 10 });
    const robot = await repositories.ingestion.listLogs({ sourceId: 'robot' }, { limit: 10 });

    expect(all.items.map((item) => item.logId)).toEqual(['l-3', 'l-2', 'l-1']);
    expect(robot.items).toHaveLength(2);
    expect(await repositories.ingestion.lastStartedAt('robot')).toEqual(
      new Date('2026-10-09T02:00:00.000Z'),
    );
    expect(await repositories.ingestion.lastStartedAt('none')).toBeNull();
  });

  it('取り込みログ: 直近の成功（結果が SUCCESS）の終了日時を返す。成功がなければ null', async () => {
    const { repositories } = create();
    const log = (logId: string, result: 'SUCCESS' | 'PARTIAL' | 'FAILURE', finishedAt: string) => ({
      logId,
      sourceId: 'robot',
      startedAt: finishedAt,
      finishedAt,
      result,
      filesProcessed: 1,
      recordCount: 1,
      rejectedCount: 0,
      attempts: 1,
    });
    await repositories.ingestion.addLog(log('l-1', 'FAILURE', '2026-10-09T01:00:00.000Z'));
    expect(await repositories.ingestion.lastSucceededAt('robot')).toBeNull();
    await repositories.ingestion.addLog(log('l-2', 'SUCCESS', '2026-10-09T02:00:00.000Z'));
    await repositories.ingestion.addLog(log('l-3', 'PARTIAL', '2026-10-09T03:00:00.000Z'));

    expect(await repositories.ingestion.lastSucceededAt('robot')).toEqual(
      new Date('2026-10-09T02:00:00.000Z'),
    );
    expect(await repositories.ingestion.lastSucceededAt('none')).toBeNull();
  });

  it('取り込みログ: 新しいデータ（記録が1件以上）を取り込んだ直近の終了日時を返す。一度もなければ null（V-018）', async () => {
    const { repositories } = create();
    const log = (logId: string, recordCount: number, finishedAt: string, sourceId = 'robot') => ({
      logId,
      sourceId,
      startedAt: finishedAt,
      finishedAt,
      result: 'SUCCESS' as const,
      filesProcessed: recordCount > 0 ? 1 : 0,
      recordCount,
      rejectedCount: 0,
      attempts: 1,
    });
    await repositories.ingestion.addLog(log('l-1', 0, '2026-10-09T01:00:00.000Z'));
    expect(await repositories.ingestion.lastDataIngestedAt('robot')).toBeNull();
    await repositories.ingestion.addLog(log('l-2', 5, '2026-10-09T02:00:00.000Z'));
    await repositories.ingestion.addLog(log('l-3', 0, '2026-10-09T03:00:00.000Z'));
    await repositories.ingestion.addLog(
      log('l-4', 9, '2026-10-09T04:00:00.000Z', 'environment-sensor'),
    );

    expect(await repositories.ingestion.lastDataIngestedAt('robot')).toEqual(
      new Date('2026-10-09T02:00:00.000Z'),
    );
    expect(await repositories.ingestion.lastDataIngestedAt('none')).toBeNull();
  });

  it('連携キュー: 次の試行の日時が来た、送信済みでない項目を、積んだ順に返す', async () => {
    const { repositories } = create();
    const item = (
      id: string,
      status: 'PENDING' | 'SENT' | 'FAILED' | 'HELD',
      nextAttemptAt: string,
      enqueuedAt: string,
    ) => ({
      federationItemId: id,
      targetType: 'EVALUATION' as const,
      targetRef: id,
      payload: {},
      status,
      attempts: 0,
      enqueuedAt,
      updatedAt: enqueuedAt,
      nextAttemptAt,
    });
    await repositories.federation.enqueue(
      item('f-2', 'PENDING', '2026-10-09T00:00:00.000Z', '2026-10-09T00:02:00.000Z'),
    );
    await repositories.federation.enqueue(
      item('f-1', 'HELD', '2026-10-09T00:00:00.000Z', '2026-10-09T00:01:00.000Z'),
    );
    await repositories.federation.enqueue(
      item('f-3', 'SENT', '2026-10-09T00:00:00.000Z', '2026-10-09T00:03:00.000Z'),
    );
    await repositories.federation.enqueue(
      item('f-4', 'FAILED', '2026-10-09T09:00:00.000Z', '2026-10-09T00:04:00.000Z'),
    );

    const due = await repositories.federation.listDue(new Date('2026-10-09T03:00:00.000Z'), 10);
    const limited = await repositories.federation.listDue(new Date('2026-10-09T03:00:00.000Z'), 1);
    await repositories.federation.update({
      ...item('f-2', 'SENT', '2026-10-09T00:00:00.000Z', '2026-10-09T00:02:00.000Z'),
    });

    expect(due.map((entry) => entry.federationItemId)).toEqual(['f-1', 'f-2']);
    expect(limited).toHaveLength(1);
    expect(await repositories.federation.countByStatus()).toEqual({
      PENDING: 0,
      SENT: 2,
      FAILED: 1,
      HELD: 1,
    });
  });

  it('連携ログ: 新しい順に一覧できる', async () => {
    const { repositories } = create();
    await repositories.federation.addLog({
      logId: 'a',
      occurredAt: '2026-10-09T01:00:00.000Z',
      result: 'HELD',
      itemCount: 2,
    });
    await repositories.federation.addLog({
      logId: 'b',
      occurredAt: '2026-10-09T02:00:00.000Z',
      result: 'SENT',
      itemCount: 2,
    });

    const page = await repositories.federation.listLogs({ limit: 10 });

    expect(page.items.map((entry) => entry.logId)).toEqual(['b', 'a']);
  });

  it('変更履歴: 操作種別・変更者・期間で絞り込める（新しい順）', async () => {
    const { repositories } = create();
    const entry = (
      auditId: string,
      operation: 'CREATE' | 'UPDATE' | 'DELETE',
      actor: typeof USER,
      occurredAt: string,
    ) => ({
      auditId,
      operation,
      actor,
      occurredAt,
      targetType: 'manual-entry' as const,
      targetId: 'e-1',
    });
    await repositories.auditLogs.add(entry('a-1', 'CREATE', USER, '2026-10-09T01:00:00.000Z'));
    await repositories.auditLogs.add(
      entry('a-2', 'UPDATE', OTHER_USER, '2026-10-09T02:00:00.000Z'),
    );
    await repositories.auditLogs.add(entry('a-3', 'DELETE', USER, '2026-10-09T03:00:00.000Z'));

    const ids = async (filter: Parameters<Repositories['auditLogs']['list']>[0]) =>
      (await repositories.auditLogs.list(filter, { limit: 10 })).items.map((item) => item.auditId);

    expect(await ids({})).toEqual(['a-3', 'a-2', 'a-1']);
    expect(await ids({ operation: 'UPDATE' })).toEqual(['a-2']);
    expect(await ids({ actor: USER })).toEqual(['a-3', 'a-1']);
    expect(await ids({ targetType: 'manual-entry' })).toEqual(['a-3', 'a-2', 'a-1']);
    expect(await ids({ targetType: 'criteria' })).toEqual([]);
    expect(await ids({ direction: 'asc' })).toEqual(['a-1', 'a-2', 'a-3']);
    expect(await ids({ direction: 'desc' })).toEqual(['a-3', 'a-2', 'a-1']);
    expect(
      await ids({
        from: new Date('2026-10-09T02:00:00.000Z'),
        to: new Date('2026-10-09T02:30:00.000Z'),
      }),
    ).toEqual(['a-2']);
  });

  it('ユーザー: 保存・取得・一覧・削除できる', async () => {
    const { repositories } = create();
    const user = (userId: string) => ({
      userId: toUserId(userId),
      userName: userId,
      role: 'worker',
      passwordHash: 'scrypt$00$00',
      createdAt: '2026-10-09T00:00:00.000Z',
    });
    await repositories.users.save(user('b-user'));
    await repositories.users.save(user('a-user'));

    expect((await repositories.users.list()).map((item) => item.userId)).toEqual([
      'a-user',
      'b-user',
    ]);
    expect(await repositories.users.get(toUserId('a-user'))).toBeDefined();
    await repositories.users.delete(toUserId('a-user'));
    expect(await repositories.users.get(toUserId('a-user'))).toBeUndefined();
  });

  it('Web Push の購読: 有効なものだけ返し、無効化・利用者ごとの削除ができる', async () => {
    const { repositories } = create();
    const subscription = (subscriptionId: string, userId: typeof USER) => ({
      subscriptionId,
      userId,
      endpoint: `https://push.invalid/${subscriptionId}`,
      isActive: true,
      createdAt: '2026-10-09T00:00:00.000Z',
    });
    await repositories.pushSubscriptions.save(subscription('s-1', USER));
    await repositories.pushSubscriptions.save(subscription('s-2', USER));
    await repositories.pushSubscriptions.save(subscription('s-3', OTHER_USER));

    await repositories.pushSubscriptions.deactivate('s-1');
    await repositories.pushSubscriptions.deactivate('none');
    expect(
      (await repositories.pushSubscriptions.listActive()).map((item) => item.subscriptionId).sort(),
    ).toEqual(['s-2', 's-3']);
    await repositories.pushSubscriptions.deleteByUser(USER);
    expect(
      (await repositories.pushSubscriptions.listActive()).map((item) => item.subscriptionId),
    ).toEqual(['s-3']);
  });

  it('Web Push の購読: 利用者ごとに一覧でき（無効を含む）、識別子で削除できる。同じ識別子は上書きする', async () => {
    const { repositories } = create();
    const subscription = (subscriptionId: string, userId: typeof USER, endpoint: string) => ({
      subscriptionId,
      userId,
      endpoint,
      isActive: true,
      createdAt: '2026-10-09T00:00:00.000Z',
    });
    await repositories.pushSubscriptions.save(subscription('s-2', USER, 'https://push.invalid/a'));
    await repositories.pushSubscriptions.save(subscription('s-1', USER, 'https://push.invalid/b'));
    await repositories.pushSubscriptions.save(
      subscription('s-3', OTHER_USER, 'https://push.invalid/c'),
    );
    await repositories.pushSubscriptions.save(subscription('s-2', USER, 'https://push.invalid/a2'));
    await repositories.pushSubscriptions.deactivate('s-1');

    const own = await repositories.pushSubscriptions.listByUser(USER);
    await repositories.pushSubscriptions.delete('s-2');
    await repositories.pushSubscriptions.delete('none');

    expect(own.map((item) => item.subscriptionId)).toEqual(['s-1', 's-2']);
    expect(own[1]?.endpoint).toBe('https://push.invalid/a2');
    expect(own[0]?.isActive).toBe(false);
    expect(
      (await repositories.pushSubscriptions.listByUser(USER)).map((item) => item.subscriptionId),
    ).toEqual(['s-1']);
  });

  describe('手動入力（1回の入力）', () => {
    const entry = (entryId: string, overrides: Partial<ManualEntry> = {}): ManualEntry => ({
      entryId,
      equipmentId: ROBOT_ID,
      category: 'OPERABILITY',
      observedAt: '2026-10-09T01:00:00.000Z',
      items: { operationMinutes: 5 },
      enteredBy: USER,
      createdAt: '2026-10-09T01:00:00.000Z',
      updatedAt: '2026-10-09T01:00:00.000Z',
      isDeleted: false,
      ...overrides,
    });

    async function populated() {
      const subject = create();
      const { manualEntries } = subject.repositories;
      await manualEntries.save(entry('e-1'));
      await manualEntries.save(
        entry('e-2', {
          category: 'FAILURE',
          observedAt: '2026-10-09T02:00:00.000Z',
          enteredBy: OTHER_USER,
        }),
      );
      await manualEntries.save(
        entry('e-3', { equipmentId: SENSOR_ID, observedAt: '2026-10-09T03:00:00.000Z' }),
      );
      await manualEntries.save(entry('e-4', { isDeleted: true }));
      return subject.repositories;
    }

    const ids = async (
      repositories: Repositories,
      filter: Parameters<Repositories['manualEntries']['list']>[0],
      sort?: Parameters<Repositories['manualEntries']['list']>[2],
    ) =>
      (await repositories.manualEntries.list(filter, { limit: 10 }, sort)).items.map(
        (item) => item.entryId,
      );

    it('保存・取得でき、一覧は、論理削除を除き、計測日時の新しい順（既定）で返す。同じ識別子は上書きする', async () => {
      const repositories = await populated();
      await repositories.manualEntries.save(entry('e-1', { note: '修正後' }));

      expect(await ids(repositories, {})).toEqual(['e-3', 'e-2', 'e-1']);
      expect((await repositories.manualEntries.get('e-1'))?.note).toBe('修正後');
      expect((await repositories.manualEntries.get('e-4'))?.isDeleted).toBe(true);
      expect(await repositories.manualEntries.get('none')).toBeUndefined();
    });

    it('カテゴリ・設備・期間・アプリ側の条件（matches）で絞り込める', async () => {
      const repositories = await populated();

      expect(await ids(repositories, { category: 'FAILURE' })).toEqual(['e-2']);
      expect(await ids(repositories, { equipmentId: SENSOR_ID })).toEqual(['e-3']);
      expect(await ids(repositories, { from: new Date('2026-10-09T02:00:00.000Z') })).toEqual([
        'e-3',
        'e-2',
      ]);
      expect(await ids(repositories, { to: new Date('2026-10-09T02:00:00.000Z') })).toEqual([
        'e-2',
        'e-1',
      ]);
      expect(await ids(repositories, { matches: (item) => item.enteredBy === OTHER_USER })).toEqual(
        ['e-2'],
      );
    });

    it('計測日時・カテゴリ・入力者で並べ替えられる（同じ値は、計測日時の新しい順）', async () => {
      const repositories = await populated();

      expect(await ids(repositories, {}, { key: 'observedAt', direction: 'asc' })).toEqual([
        'e-1',
        'e-2',
        'e-3',
      ]);
      expect(await ids(repositories, {}, { key: 'category', direction: 'asc' })).toEqual([
        'e-2',
        'e-3',
        'e-1',
      ]);
      expect(await ids(repositories, {}, { key: 'category', direction: 'desc' })).toEqual([
        'e-3',
        'e-1',
        'e-2',
      ]);
      expect(await ids(repositories, {}, { key: 'enteredBy', direction: 'asc' })).toEqual([
        'e-3',
        'e-1',
        'e-2',
      ]);
    });

    it('ページ分割し、不正なカーソルは入力不正にする', async () => {
      const repositories = await populated();

      const first = await repositories.manualEntries.list({}, { limit: 2 });
      const second = await repositories.manualEntries.list(
        {},
        { limit: 2, cursor: first.nextCursor ?? undefined },
      );

      expect(first.items.map((item) => item.entryId)).toEqual(['e-3', 'e-2']);
      expect(second.items.map((item) => item.entryId)).toEqual(['e-1']);
      expect(second.nextCursor).toBeNull();
      await expect(
        repositories.manualEntries.list({}, { limit: 2, cursor: 'bad' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  it('設定: キーごとに値を保存・取得できる。未設定は undefined', async () => {
    const { repositories } = create();

    expect(await repositories.settings.get('a')).toBeUndefined();
    await repositories.settings.set('a', { nested: [1, 2] });
    expect(await repositories.settings.get('a')).toEqual({ nested: [1, 2] });
  });
});

describe('ファイル永続化', () => {
  function newFile(): string {
    return join(mkdtempSync(join(tmpdir(), 'smart-farm-persist-')), 'nested', 'store.json');
  }

  it('保存したデータを、再起動（新しいインスタンスの読み込み）後も保持する', async () => {
    const filePath = newFile();
    const first = createLocalRepositories({ filePath });
    const [facility] = equipmentSet();
    if (facility === undefined) {
      throw new Error('テストの前提');
    }
    await first.repositories.equipment.save(facility);
    await first.repositories.observations.saveMany([
      observation({ itemKey: 'harvestCount', value: 3 }),
    ]);
    await first.repositories.settings.set('k', 'v');
    first.store.flush();

    const second = createLocalRepositories({ filePath });
    second.store.load();

    expect(await second.repositories.equipment.list()).toHaveLength(1);
    expect((await second.repositories.observations.query({}, { limit: 10 })).items).toHaveLength(1);
    expect(await second.repositories.settings.get('k')).toBe('v');
    // 読み込み後に追加した観測値も、設備ごとの索引に反映される
    await second.repositories.observations.saveMany([
      observation({ itemKey: 'harvestCount', value: 4, observedAt: '2026-10-09T02:30:00.000Z' }),
    ]);
    expect(
      await second.repositories.observations.findForEvaluation(
        [ROBOT_ID],
        new Date('2026-10-09T00:00:00Z'),
        new Date('2026-10-09T04:00:00Z'),
      ),
    ).toHaveLength(2);
  });

  it('変更は、少し待ってからまとめてファイルへ書く', async () => {
    const filePath = newFile();
    const { repositories } = createLocalRepositories({ filePath, flushDelayMs: 10 });

    await repositories.settings.set('k', 'v');
    // 実際の待ち時間が処理の負荷で前後しても安定するよう、書かれるまで待つ
    await vi.waitFor(() => {
      expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({ version: 1 });
    });
  });

  it('ファイルがなければ、空の状態で始める', () => {
    const { store, repositories } = createLocalRepositories({ filePath: newFile() });

    store.load();

    return expect(repositories.equipment.list()).resolves.toEqual([]);
  });

  it('ファイルの内容がスキーマに合わなければ、読み込みを失敗させる（壊れたデータを使わない）', () => {
    const filePath = newFile();
    mkdirSync(dirname(filePath), { recursive: true });
    const { store } = createLocalRepositories({ filePath });
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, collections: { equipment: [{ equipmentId: 'X' }] } }),
    );

    expect(() => {
      store.load();
    }).toThrow();
  });

  it('リセットすると、すべてのデータを消す', async () => {
    const { repositories, store } = createLocalRepositories();
    await repositories.settings.set('k', 'v');

    store.clear();

    expect(await repositories.settings.get('k')).toBeUndefined();
  });

  it('同じ名前のコレクションを重複して登録できない', () => {
    const { store } = createLocalRepositories();

    expect(() => store.collection('equipment', z.string(), (value) => value)).toThrow('重複');
  });
});
