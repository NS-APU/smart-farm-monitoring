/**
 * DynamoDB アダプタ固有の振る舞い（ADR-0007）のテスト。契約テスト（repository-contract.test.ts）が確かめない、
 * 時刻の正規化・複数のパーティションの併合・カウンター・読み取りの上限・競合の少ない更新などを、DynamoDB Local で確かめる。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '@smart-farm/shared/errors';
import { NotificationIdSchema, toUserId } from '@smart-farm/shared/schemas/common';
import type { Notification } from '@smart-farm/shared/schemas/notification';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import { compareObservations } from '../../src/backend/infrastructure/common/observation-rules.ts';
import type {
  ObservationFilter,
  Repositories,
} from '../../src/backend/application/ports/repositories.ts';
import { createDynamoRepositories } from '../../src/backend/infrastructure/dynamodb/dynamodb-repositories.ts';
import {
  createTables,
  deleteTables,
} from '../../src/backend/infrastructure/dynamodb/table-admin.ts';
import { createContainer } from '../../src/backend/runtime/container.ts';
import { parseConfig } from '../../src/backend/runtime/config.ts';
import { observation, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import {
  createDynamoTestDatabase,
  dropDynamoTestTables,
  dynamoTestClientOptions,
} from '../support/dynamodb-test-database.ts';

afterAll(dropDynamoTestTables);

async function setup(options: { observationReadLimit?: number } = {}): Promise<Repositories> {
  const database = createDynamoTestDatabase();
  await database.ready;
  return createDynamoRepositories({ client: database.client, tables: database.tables, ...options });
}

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
    deliveries: [],
    ...overrides,
  };
}

describe('観測値（DynamoDB）', () => {
  it('計測日時は、ミリ秒の有無にかかわらず、同じ時刻なら同じキー。保存したときの文字列を返す', async () => {
    const { observations } = await setup();
    const withoutMs = observation({
      itemKey: 'harvestCount',
      value: 1,
      observedAt: '2026-10-09T02:00:00Z',
    });
    await observations.saveMany([withoutMs]);

    const first = await observations.query({}, { limit: 10 });
    await observations.saveMany([
      { ...withoutMs, observedAt: '2026-10-09T02:00:00.000Z', value: 2 },
    ]);
    const second = await observations.query({}, { limit: 10 });

    expect(first.items.map((item) => item.observedAt)).toEqual(['2026-10-09T02:00:00Z']);
    expect(second.items.map((item) => [item.observedAt, item.value])).toEqual([
      ['2026-10-09T02:00:00.000Z', 2],
    ]);
    expect(
      (
        await observations.findByKey(
          ROBOT_ID,
          'harvestCount',
          '2026-10-09T02:00:00Z',
          'AUTO_IMPORT',
        )
      )?.value,
    ).toBe(2);
  });

  it('正規化していない計測日時でも、カーソルでページを送れる', async () => {
    const { observations } = await setup();
    await observations.saveMany(
      [1, 2, 3].map((minute) =>
        observation({
          itemKey: 'harvestCount',
          value: minute,
          observedAt: `2026-10-09T02:0${minute}:00Z`,
        }),
      ),
    );

    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await observations.query(
        {},
        { limit: 1, cursor },
        { key: 'observedAt', direction: 'asc' },
      );
      seen.push(...page.items.map((item) => Number(item.value)));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(seen).toEqual([1, 2, 3]);
  });

  it('カテゴリは、項目カタログにない項目・カタログと違う値でも、そのまま保存し、絞り込める', async () => {
    const { observations } = await setup();
    const base = observation({ itemKey: 'harvestCount', value: 1 });
    await observations.saveMany([
      { ...base, itemKey: 'unknownItem', category: 'SAFETY' },
      { ...base, observedAt: '2026-10-09T03:00:00.000Z', category: 'COST' },
    ]);

    const safety = await observations.query({ category: 'SAFETY' }, { limit: 10 });
    const cost = await observations.query({ category: 'COST' }, { limit: 10 });
    const harvest = await observations.query({ category: 'HARVEST' }, { limit: 10 });

    expect(safety.items.map((item) => item.itemKey)).toEqual(['unknownItem']);
    // カタログ（収穫量 = HARVEST）と違うカテゴリで保存した値は、カタログのカテゴリの絞り込みでは、見つからない
    expect(cost.items).toEqual([]);
    expect(harvest.items).toEqual([]);
    expect(
      (
        await observations.findByKey(
          ROBOT_ID,
          'harvestCount',
          '2026-10-09T03:00:00.000Z',
          'AUTO_IMPORT',
        )
      )?.category,
    ).toBe('COST');
  });

  describe('計測日時の順の一覧（複数のパーティションの併合）', () => {
    const times = [
      '2026-10-09T01:00:00.000Z',
      '2026-10-09T02:00:00.000Z',
      '2026-10-09T03:00:00.000Z',
      '2026-10-09T04:00:00.000Z',
    ];
    const targets = [
      { equipmentId: ROBOT_ID, itemKey: 'harvestCount' },
      { equipmentId: ROBOT_ID, itemKey: 'operatingHours' },
      { equipmentId: ROBOT_ID, itemKey: 'failureCount' },
      { equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius' },
    ];

    /** 同じ計測日時のものが、複数のパーティション・取得元にまたがる、合成データ。 */
    function dataset(): Observation[] {
      return targets.flatMap((target, targetIndex) =>
        times.flatMap((observedAt, timeIndex) => {
          const base = observation({ ...target, value: targetIndex * 10 + timeIndex, observedAt });
          return [
            base,
            ...(timeIndex % 2 === 0
              ? [{ ...base, source: 'MANUAL' as const, value: base.value as number }]
              : []),
            ...(timeIndex === 3 ? [{ ...base, isDeleted: true, source: 'MANUAL' as const }] : []),
          ];
        }),
      );
    }

    const filters: readonly [string, ObservationFilter][] = [
      ['条件なし', {}],
      ['手動入力（疎なインデックス）', { source: 'MANUAL' }],
      ['自動取り込み', { source: 'AUTO_IMPORT' }],
      ['カテゴリ', { category: 'HARVEST' }],
      ['設備', { equipmentIds: [SENSOR_ID] }],
      ['項目', { itemKeys: ['operatingHours', 'temperatureCelsius'] }],
      ['期間', { from: new Date(times[1] ?? ''), to: new Date(times[2] ?? '') }],
      ['論理削除を含める', { includeDeleted: true }],
    ];

    it.each(filters)(
      '%s: どの件数でページを送っても、ローカルの実装と同じ順序（昇順・降順）で、すべて返る',
      async (_name, filter) => {
        const { observations } = await setup();
        const all = dataset();
        await observations.saveMany(all);
        const matches = (item: Observation): boolean =>
          (filter.includeDeleted === true || !item.isDeleted) &&
          (filter.source === undefined || item.source === filter.source) &&
          (filter.category === undefined || item.category === filter.category) &&
          (filter.equipmentIds === undefined || filter.equipmentIds.includes(item.equipmentId)) &&
          (filter.itemKeys === undefined || filter.itemKeys.includes(item.itemKey)) &&
          (filter.from === undefined || item.observedAt >= filter.from.toISOString()) &&
          (filter.to === undefined || item.observedAt <= filter.to.toISOString());

        for (const direction of ['asc', 'desc'] as const) {
          const expected = all.filter(matches).sort(compareObservations('observedAt', direction));
          for (const limit of [1, 3, 100]) {
            const returned: Observation[] = [];
            let cursor: string | undefined;
            do {
              const page = await observations.query(
                filter,
                { limit, cursor },
                { key: 'observedAt', direction },
              );
              returned.push(...page.items);
              cursor = page.nextCursor ?? undefined;
            } while (cursor !== undefined);
            expect(returned).toEqual(expected);
          }
        }
      },
    );

    it('値・カテゴリの順は、条件に合う観測値を読み、アプリ側で並べ替える（ページ送りも同じ）', async () => {
      const { observations } = await setup();
      const all = dataset();
      await observations.saveMany(all);

      for (const key of ['value', 'category'] as const) {
        const expected = all
          .filter((item) => !item.isDeleted)
          .sort(compareObservations(key, 'desc'));
        const returned: Observation[] = [];
        let cursor: string | undefined;
        do {
          const page = await observations.query(
            {},
            { limit: 4, cursor },
            { key, direction: 'desc' },
          );
          returned.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        expect(returned).toEqual(expected);
      }
    });

    it('値・カテゴリの順で、不正なカーソルは、読む前に、入力不正にする', async () => {
      const { observations } = await setup();

      await expect(
        observations.query({}, { limit: 4, cursor: '!!' }, { key: 'value', direction: 'asc' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('計測日時の順で、不正なカーソル（形式・取得元・日時）は、入力不正にする', async () => {
      const { observations } = await setup();
      const encode = (parts: readonly string[]): string =>
        Buffer.from(JSON.stringify(parts)).toString('base64url');

      for (const cursor of [
        encode(['a', 'b']),
        encode([ROBOT_ID, 'harvestCount', '2026-10-09T01:00:00.000Z', 'OTHER']),
        encode([ROBOT_ID, 'harvestCount', 'not-a-date', 'MANUAL']),
      ]) {
        await expect(observations.query({}, { limit: 4, cursor })).rejects.toThrow(AppError);
      }
    });
  });

  it('範囲が空（開始が終了より後）なら、何も返さない', async () => {
    const { observations } = await setup();
    await observations.saveMany([observation({ itemKey: 'harvestCount', value: 1 })]);
    const later = new Date('2026-10-10T00:00:00.000Z');
    const earlier = new Date('2026-10-08T00:00:00.000Z');

    expect((await observations.query({ from: later, to: earlier }, { limit: 10 })).items).toEqual(
      [],
    );
    expect(await observations.findForEvaluation([ROBOT_ID], later, earlier)).toEqual([]);
  });

  it('読む観測値が上限を超えたら、期間を絞り込むよう、入力不正にする（評価の入力は、上限なし）', async () => {
    const { observations } = await setup({ observationReadLimit: 3 });
    await observations.saveMany(
      [1, 2, 3, 4, 5].map((hour) =>
        observation({
          itemKey: 'harvestCount',
          value: hour,
          observedAt: `2026-10-09T0${hour}:00:00.000Z`,
        }),
      ),
    );

    await expect(observations.query({}, { limit: 100 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      observations.query({}, { limit: 100 }, { key: 'value', direction: 'asc' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(
      await observations.findForEvaluation(
        [ROBOT_ID],
        new Date('2026-10-09T00:00:00.000Z'),
        new Date('2026-10-09T23:00:00.000Z'),
      ),
    ).toHaveLength(5);
    expect((await observations.query({}, { limit: 1 })).items).toHaveLength(1);
  });

  it('最終の受信日時: 自動取り込み（論理削除・手動入力を除く）と全体を、別に持ち、古い値で戻さない', async () => {
    const { observations } = await setup();
    const at = (hour: string) => `2026-10-09T${hour}:00:00.000Z`;
    await observations.saveMany([
      observation({ itemKey: 'harvestCount', value: 1, receivedAt: at('10') }),
      observation({ itemKey: 'failureCount', value: 1, source: 'MANUAL', receivedAt: at('11') }),
      observation({ itemKey: 'operatingHours', value: 1, isDeleted: true, receivedAt: at('12') }),
    ]);
    await observations.saveMany([
      observation({
        itemKey: 'harvestCount',
        value: 2,
        observedAt: '2026-10-09T01:00:00.000Z',
        receivedAt: at('09'),
      }),
    ]);

    expect(await observations.latestReceivedAt([ROBOT_ID], { autoImportOnly: true })).toEqual(
      new Date(at('10')),
    );
    expect(await observations.latestReceivedAt([ROBOT_ID])).toEqual(new Date(at('12')));
    expect(await observations.latestReceivedAt([])).toBeNull();
    expect(await observations.latestReceivedAt([SENSOR_ID])).toBeNull();
    // 自動取り込みが、論理削除だけの設備は、null
    await observations.saveMany([
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 1,
        isDeleted: true,
      }),
    ]);
    expect(await observations.latestReceivedAt([SENSOR_ID], { autoImportOnly: true })).toBeNull();
    expect(await observations.latestReceivedAt(undefined, { autoImportOnly: true })).toEqual(
      new Date(at('10')),
    );
  });

  it('保存: 空は何もしない。25 件を超えても保存でき、同じ一意キーは、あとのものを残す', async () => {
    const { observations } = await setup();
    const many = Array.from({ length: 60 }, (_, index) =>
      observation({
        itemKey: 'harvestCount',
        value: index,
        observedAt: new Date(Date.UTC(2026, 9, 9, 0, index)).toISOString(),
      }),
    );

    await observations.saveMany([]);
    await observations.saveMany([...many, { ...many[0], value: 999 } as Observation]);

    const page = await observations.query(
      {},
      { limit: 100 },
      { key: 'observedAt', direction: 'asc' },
    );
    expect(page.items).toHaveLength(60);
    expect(page.items[0]?.value).toBe(999);
  });

  it('解釈できない計測日時の検索は、見つからない。知らない設備の絞り込みは、空', async () => {
    const { observations } = await setup();
    await observations.saveMany([observation({ itemKey: 'harvestCount', value: 1 })]);

    expect(
      await observations.findByKey(ROBOT_ID, 'harvestCount', 'x', 'AUTO_IMPORT'),
    ).toBeUndefined();
    expect((await observations.query({ equipmentIds: [SENSOR_ID] }, { limit: 10 })).items).toEqual(
      [],
    );
  });
});

describe('通知（DynamoDB）', () => {
  it('同じ識別子の通知を追加すると、上書きする（件数は増えない）。なければ、更新は追加になる', async () => {
    const { notifications } = await setup();

    await notifications.add(notification('n-1'));
    await notifications.add(notification('n-1', { message: '修正後' }));
    await notifications.update(notification('n-2'));

    const all = await notifications.list(USER, {}, { limit: 10 });
    expect(
      all.items.map((entry) => [entry.notification.notificationId, entry.notification.message]),
    ).toEqual([
      ['n-2', '通知 n-2'],
      ['n-1', '修正後'],
    ]);
    expect(await notifications.unreadCount(USER)).toBe(2);
  });

  it('カーソルでページを送れる。絞り込みで埋まらないページも、続きを探して埋める。不正なカーソルは入力不正', async () => {
    const { notifications } = await setup();
    for (const index of [1, 2, 3, 4, 5, 6]) {
      await notifications.add(
        notification(`n-${index}`, {
          kind: index % 2 === 0 ? 'INGESTION_FAILURE' : 'STATUS_CHANGE',
        }),
      );
    }
    const ids = async (filter: Parameters<typeof notifications.list>[1], limit: number) => {
      const returned: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await notifications.list(USER, filter, { limit, cursor });
        returned.push(...page.items.map((entry) => entry.notification.notificationId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return returned;
    };

    expect(await ids({}, 2)).toEqual(['n-6', 'n-5', 'n-4', 'n-3', 'n-2', 'n-1']);
    expect(await ids({ kind: 'INGESTION_FAILURE' }, 1)).toEqual(['n-6', 'n-4', 'n-2']);
    await expect(notifications.list(USER, {}, { limit: 2, cursor: '!!' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('重複抑制のキーは、あとから、古い通知を追加しても、最新の通知を指したまま', async () => {
    const { notifications } = await setup();

    await notifications.add(notification('n-3', { dedupKey: 'same' }));
    await notifications.add(notification('n-1', { dedupKey: 'same' }));

    expect((await notifications.findLatestByDedupKey('same'))?.notificationId).toBe('n-3');
  });

  it('既読にしても、2 回目は数えない。既読済みの絞り込み（READ）の一括は、0 件', async () => {
    const { notifications } = await setup();
    await notifications.add(notification('n-1'));
    await notifications.add(notification('n-2'));
    const id = NotificationIdSchema.parse('n-1');

    expect(await notifications.markRead(id, USER, new Date())).toBe(true);
    expect(await notifications.markRead(id, USER, new Date())).toBe(true);

    expect(await notifications.unreadCount(USER)).toBe(1);
    expect(await notifications.markAllRead(USER, { readState: 'READ' }, new Date())).toBe(0);
    expect(await notifications.markAllRead(OTHER_USER, {}, new Date())).toBe(2);
    expect(await notifications.unreadCount(OTHER_USER)).toBe(0);
  });

  it('配信の状態が変わると、未完了の一覧に、載る・載らなくなる', async () => {
    const { notifications } = await setup();
    const delivery = (result: 'PENDING' | 'SUCCESS' | 'FAILURE', attempts: number) => [
      { channel: 'WEB_PUSH' as const, result, attempts, updatedAt: '2026-10-09T00:00:00.000Z' },
      {
        channel: 'IN_APP' as const,
        result: 'SUCCESS' as const,
        attempts: 1,
        updatedAt: '2026-10-09T00:00:00.000Z',
      },
    ];
    await notifications.add(notification('n-1', { deliveries: delivery('SUCCESS', 1) }));

    expect(await notifications.listUndelivered(3)).toEqual([]);
    await notifications.update(notification('n-1', { deliveries: delivery('FAILURE', 1) }));
    expect((await notifications.listUndelivered(3)).map((item) => item.notificationId)).toEqual([
      'n-1',
    ]);
    expect(await notifications.listUndelivered(1)).toEqual([]);
  });
});

describe('連携（DynamoDB）', () => {
  const item = (
    id: string,
    status: 'PENDING' | 'SENT' | 'FAILED' | 'HELD',
    minute: number,
    nextAttemptAt = '2026-10-09T00:00:00.000Z',
  ) => ({
    federationItemId: id,
    targetType: 'EVALUATION' as const,
    targetRef: id,
    payload: { nested: { values: [1, 2] } },
    status,
    attempts: 0,
    enqueuedAt: `2026-10-09T00:${String(minute).padStart(2, '0')}:00.000Z`,
    updatedAt: '2026-10-09T00:00:00.000Z',
    nextAttemptAt,
  });

  it('状態が変わるたびに、状態ごとの件数を更新する。同じ状態の更新は、件数を変えない', async () => {
    const { federation } = await setup();

    await federation.enqueue(item('f-1', 'PENDING', 1));
    await federation.enqueue(item('f-2', 'PENDING', 2));
    await federation.update({ ...item('f-1', 'FAILED', 1), attempts: 1 });
    await federation.update({ ...item('f-1', 'FAILED', 1), attempts: 2 });
    await federation.update(item('f-2', 'SENT', 2));

    expect(await federation.countByStatus()).toEqual({ PENDING: 0, SENT: 1, FAILED: 1, HELD: 0 });
  });

  it('送信してよい項目は、読む 1 回の件数より多くても、積んだ順に、上限の件数だけ返す', async () => {
    const { federation } = await setup();
    for (let minute = 0; minute < 40; minute += 1) {
      await federation.enqueue(item(`f-${String(minute).padStart(2, '0')}`, 'PENDING', minute));
    }

    const due = await federation.listDue(new Date('2026-10-09T01:00:00.000Z'), 30);

    expect(due.map((entry) => entry.federationItemId)).toEqual(
      Array.from({ length: 30 }, (_, minute) => `f-${String(minute).padStart(2, '0')}`),
    );
  });

  it('連携ログは、カーソルでページを送れる（新しい順）', async () => {
    const { federation } = await setup();
    for (const hour of [1, 2, 3]) {
      await federation.addLog({
        logId: `l-${hour}`,
        occurredAt: `2026-10-09T0${hour}:00:00.000Z`,
        result: 'SENT',
        itemCount: 1,
      });
    }

    const first = await federation.listLogs({ limit: 2 });
    const second = await federation.listLogs({ limit: 2, cursor: first.nextCursor ?? undefined });

    expect(first.items.map((entry) => entry.logId)).toEqual(['l-3', 'l-2']);
    expect(second.items.map((entry) => entry.logId)).toEqual(['l-1']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('取り込み（DynamoDB）', () => {
  const log = (logId: string, sourceId: string, startedAt: string, recordCount = 1) => ({
    logId,
    sourceId,
    startedAt,
    finishedAt: startedAt,
    result: 'SUCCESS' as const,
    filesProcessed: 1,
    recordCount,
    rejectedCount: 0,
    attempts: 1,
  });

  it('同じ内容で、成功した記録が複数あっても、最初の成功を残す', async () => {
    const { ingestion } = await setup();
    const base = { sourceId: 'robot', fetchedAt: '2026-10-09T01:00:00.000Z', recordCount: 1 };
    await ingestion.recordFile({ ...base, fileId: 'a.json', contentHash: 'h1', result: 'SUCCESS' });
    await ingestion.recordFile({
      ...base,
      fileId: 'copy.json',
      contentHash: 'h1',
      result: 'SUCCESS',
    });

    expect((await ingestion.findIngestedFile('robot', 'other.json', 'h1'))?.fileId).toBe('a.json');
    expect((await ingestion.findIngestedFile('robot', 'copy.json', 'h1'))?.fileId).toBe(
      'copy.json',
    );
  });

  it('取り込み元の直近の日時は、古いログを後から足しても、戻らない', async () => {
    const { ingestion } = await setup();

    await ingestion.addLog(log('l-2', 'robot', '2026-10-09T02:00:00.000Z'));
    await ingestion.addLog(log('l-1', 'robot', '2026-10-09T01:00:00.000Z'));

    expect(await ingestion.lastStartedAt('robot')).toEqual(new Date('2026-10-09T02:00:00.000Z'));
    expect(await ingestion.lastSucceededAt('robot')).toEqual(new Date('2026-10-09T02:00:00.000Z'));
    expect(await ingestion.lastDataIngestedAt('robot')).toEqual(
      new Date('2026-10-09T02:00:00.000Z'),
    );
  });

  it('取り込みログは、取り込み元をまたいで、カーソルでページを送れる（新しい順）。取り込み元で絞ってもページを送れる', async () => {
    const { ingestion } = await setup();
    await ingestion.addLog(log('l-1', 'robot', '2026-10-09T01:00:00.000Z'));
    await ingestion.addLog(log('l-2', 'sensor', '2026-10-09T02:00:00.000Z'));
    await ingestion.addLog(log('l-3', 'robot', '2026-10-09T03:00:00.000Z'));
    await ingestion.addLog(log('l-4', 'sensor', '2026-10-09T04:00:00.000Z'));

    const first = await ingestion.listLogs({}, { limit: 3 });
    const second = await ingestion.listLogs(
      {},
      { limit: 3, cursor: first.nextCursor ?? undefined },
    );
    const robotFirst = await ingestion.listLogs({ sourceId: 'robot' }, { limit: 1 });
    const robotSecond = await ingestion.listLogs(
      { sourceId: 'robot' },
      { limit: 1, cursor: robotFirst.nextCursor ?? undefined },
    );

    expect(first.items.map((entry) => entry.logId)).toEqual(['l-4', 'l-3', 'l-2']);
    expect(second.items.map((entry) => entry.logId)).toEqual(['l-1']);
    expect(robotFirst.items.map((entry) => entry.logId)).toEqual(['l-3']);
    expect(robotSecond.items.map((entry) => entry.logId)).toEqual(['l-1']);
    expect(robotSecond.nextCursor).toBeNull();
  });
});

describe('変更履歴・手動入力（DynamoDB）', () => {
  it('変更履歴は、絞り込みの結果で、ページを送れる。範囲が空なら、何も返さない', async () => {
    const { auditLogs } = await setup();
    for (const hour of [1, 2, 3, 4, 5]) {
      await auditLogs.add({
        auditId: `a-${hour}`,
        operation: 'UPDATE',
        actor: hour % 2 === 0 ? OTHER_USER : USER,
        occurredAt: `2026-10-09T0${hour}:00:00.000Z`,
        targetType: 'manual-entry',
        targetId: 'e-1',
      });
    }
    const ids = async (direction: 'asc' | 'desc') => {
      const returned: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await auditLogs.list({ actor: USER, direction }, { limit: 2, cursor });
        returned.push(...page.items.map((entry) => entry.auditId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return returned;
    };

    expect(await ids('desc')).toEqual(['a-5', 'a-3', 'a-1']);
    expect(await ids('asc')).toEqual(['a-1', 'a-3', 'a-5']);
    expect(
      (
        await auditLogs.list(
          { from: new Date('2026-10-09T05:00:00.000Z'), to: new Date('2026-10-09T01:00:00.000Z') },
          { limit: 5 },
        )
      ).items,
    ).toEqual([]);
  });

  it('手動入力は、計測日時を変えて保存しても、1 件のまま（古い位置を残さない）', async () => {
    const { manualEntries } = await setup();
    const entry = {
      entryId: 'e-1',
      equipmentId: ROBOT_ID,
      category: 'OPERABILITY' as const,
      observedAt: '2026-10-09T01:00:00.000Z',
      items: { operationMinutes: 5 },
      enteredBy: USER,
      createdAt: '2026-10-09T01:00:00.000Z',
      updatedAt: '2026-10-09T01:00:00.000Z',
      isDeleted: false,
    };

    await manualEntries.save(entry);
    await manualEntries.save({ ...entry, observedAt: '2026-10-09T05:00:00.000Z' });
    await manualEntries.save({ ...entry, observedAt: '2026-10-09T05:00:00.000Z', note: 'メモ' });

    const all = await manualEntries.list({}, { limit: 10 });
    expect(all.items.map((item) => [item.entryId, item.observedAt, item.note])).toEqual([
      ['e-1', '2026-10-09T05:00:00.000Z', 'メモ'],
    ]);
    expect((await manualEntries.get('e-1'))?.observedAt).toBe('2026-10-09T05:00:00.000Z');
    expect(
      (await manualEntries.list({ to: new Date('2026-10-09T02:00:00.000Z') }, { limit: 10 })).items,
    ).toEqual([]);
  });
});

describe('テーブルの作成・組み立て（DynamoDB）', () => {
  it('テーブルの作成は、すでにあれば、そのまま使う。消すのは、なくても失敗しない', async () => {
    const options = dynamoTestClientOptions();
    const tables = { observations: 'testtablesadminobs', main: 'testtablesadminmain' };

    await createTables(options, tables);
    await createTables(options, tables);

    await expect(deleteTables(options, [tables])).resolves.toBeUndefined();
    await expect(deleteTables(options, [tables])).resolves.toBeUndefined();
  });

  it('PERSISTENCE=dynamodb（接続先を指定）: 起動時にテーブルを作り、初期データを用意する', async () => {
    const options = dynamoTestClientOptions();
    const tables = { observations: 'testcontainerobs', main: 'testcontainermain' };
    const config = parseConfig({
      APP_MODE: 'test',
      PERSISTENCE: 'dynamodb',
      DYNAMODB_OBSERVATIONS_TABLE: tables.observations,
      DYNAMODB_MAIN_TABLE: tables.main,
      DYNAMODB_ENDPOINT: options.endpoint,
      INITIAL_USER_ID: 'first-user',
      INITIAL_USER_NAME: '最初のユーザー',
      INITIAL_USER_PASSWORD: 'Dummy-Passw0rd-1',
    });
    const container = createContainer(config);

    try {
      await container.initialize();
      await container.initialize();

      expect(await container.repositories.statusCodes.list()).toHaveLength(8);
      expect(await container.repositories.users.list()).toHaveLength(1);
      expect(container.dev).toBeUndefined();
    } finally {
      container.close();
      await deleteTables(options, [tables]);
    }
  });
});
