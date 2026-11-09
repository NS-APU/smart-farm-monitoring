/**
 * 通知の Repository（DynamoDB 実装）。通知の既読は、通知と利用者の組ごと（暫定。Q-018）。
 *
 * - 通知: `NOTIF` / `{作成日時}#{通知ID}`（新しい順に Query）。配信が未完了の間だけ、疎な GSI1（`UNDELIVERED`）に載る
 * - ポインタ: `NID#{通知ID}`（通知のソートキー）、`DEDUP#{重複抑制のキー}`（最新の通知のソートキー）。強い整合で引く
 * - 既読: `READ#{利用者}` / `{通知ID}`。通知の総数（`NOTIF_TOTAL`）と、利用者ごとの既読数（`READ#{利用者}`）は、
 *   カウンターで持つ。未読の件数は、その差（全件を数えない）。利用者が作られる前の通知も、未読に数える
 * - 通知の作成日時は、変えない（ソートキーに入っているため、更新では、作成時のソートキーを使う）
 */

import {
  NotificationMemoSchema,
  NotificationSchema,
  type Notification,
} from '@smart-farm/shared/schemas/notification';
import { needsWebPushDelivery } from '../../domain/notification-delivery.ts';
import type {
  NotificationListFilter,
  NotificationRepository,
  NotificationWithReadState,
  Page,
  StatusChangeNotificationTime,
} from '../../application/ports/repositories.ts';
import { decodeKeyCursor, encodeKeyCursor } from './key-cursor.ts';
import { instantKey, timedSortKey, upperBoundOf } from './keys.ts';
import { counterAdd, mainAggregate, readCounters } from './main-table.ts';
import {
  batchGetItems,
  getItem,
  isTransactionConditionFailed,
  mapConcurrent,
  queryAll,
  queryItems,
  queryPages,
  transactWrite,
  CONCURRENCY,
  type Database,
  type Item,
  type TransactItem,
} from './operations.ts';
import { MAIN_INDEX_1 } from './table-schema.ts';

const NOTIFICATION = 'NOTIF';
const UNDELIVERED = 'UNDELIVERED';
const TOTAL_COUNTER = 'NOTIF_TOTAL';
/** 通知の一覧で、1 回の Query で読む件数。 */
const LIST_PAGE_SIZE = 100;

const idPartition = (notificationId: string): string => `NID#${notificationId}`;
const dedupPartition = (dedupKey: string): string => `DEDUP#${dedupKey}`;
const readPartition = (userId: string): string => `READ#${userId}`;
const readCounter = (userId: string): string => `READ#${userId}`;
/** 通知のメモ（#239）: `NMEMO#{通知ID}` / `{作成日時}#{メモID}`（入力の古い順に Query）。件数は、カウンター `NMEMO#{通知ID}`。 */
const memoPartition = (notificationId: string): string => `NMEMO#${notificationId}`;
const memoCounter = (notificationId: string): string => `NMEMO#${notificationId}`;

function matchesFilter(
  notification: Notification,
  isRead: boolean,
  filter: NotificationListFilter,
): boolean {
  if (filter.kind !== undefined && notification.kind !== filter.kind) {
    return false;
  }
  if (filter.readState === 'READ' && !isRead) {
    return false;
  }
  return !(filter.readState === 'UNREAD' && isRead);
}

export function createNotificationRepository(db: Database): NotificationRepository {
  const table = db.tables.main;
  const notifications = mainAggregate(db, NotificationSchema);
  const memos = mainAggregate(db, NotificationMemoSchema);

  /** 配信が未完了の通知だけが持つ、GSI1 のキー。 */
  const indexKeys = (notification: Notification, sortKey: string): Item =>
    needsWebPushDelivery(notification) ? { gsi1pk: UNDELIVERED, gsi1sk: sortKey } : {};

  async function pointedSortKey(partition: string): Promise<string | undefined> {
    const pointer = await getItem(db, table, { pk: partition, sk: 'P' });
    return pointer === undefined ? undefined : String(pointer.nsk);
  }

  async function getByPartition(partition: string): Promise<Notification | undefined> {
    const sortKey = await pointedSortKey(partition);
    return sortKey === undefined ? undefined : notifications.get(NOTIFICATION, sortKey);
  }

  /** 通知を既読にする（利用者ごとに、1 回だけ数える）。新しく既読にしたら true。 */
  async function markReadOnce(
    notificationId: string,
    userId: string,
    readAt: Date,
  ): Promise<boolean> {
    try {
      await transactWrite(db, [
        {
          Put: {
            TableName: table,
            Item: { pk: readPartition(userId), sk: notificationId, readAt: readAt.toISOString() },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        counterAdd(db, readCounter(userId), 1),
      ]);
      return true;
    } catch (error) {
      if (isTransactionConditionFailed(error)) {
        return false;
      }
      throw error;
    }
  }

  /** 通知のページを、新しい順に読み、利用者ごとの既読を付ける。`until` があれば、その日時以前（ちょうどを含む）だけを読む。 */
  async function* newestFirst(
    userId: string,
    startAfter: Item | undefined,
    until?: Date,
  ): AsyncGenerator<{ readonly sortKey: string; readonly entry: NotificationWithReadState }> {
    for await (const items of queryPages(db, {
      table,
      hashName: 'pk',
      hashValue: NOTIFICATION,
      sortName: 'sk',
      upper: until === undefined ? undefined : upperBoundOf(instantKey(until.toISOString())),
      forward: false,
      pageSize: LIST_PAGE_SIZE,
      consistent: true,
      startAfter,
    })) {
      const parsed = items.map((item) => ({
        sortKey: String(item.sk),
        notification: notifications.parse(item),
      }));
      const reads = new Set(
        (
          await batchGetItems(
            db,
            table,
            parsed.map(({ notification }) => ({
              pk: readPartition(userId),
              sk: notification.notificationId,
            })),
          )
        ).map((read) => String(read.sk)),
      );
      for (const { sortKey, notification } of parsed) {
        yield { sortKey, entry: { notification, isRead: reads.has(notification.notificationId) } };
      }
    }
  }

  /** 絞り込みの範囲（`until` 以前を含む）の、未読の通知の識別子。既読だけの範囲（`readState=READ`）は、なし。 */
  async function unreadIdsIn(userId: string, filter: NotificationListFilter): Promise<string[]> {
    const unread: string[] = [];
    if (filter.readState === 'READ') {
      return unread;
    }
    for await (const found of newestFirst(userId, undefined, filter.until)) {
      if (!found.entry.isRead && matchesFilter(found.entry.notification, false, filter)) {
        unread.push(found.entry.notification.notificationId);
      }
    }
    return unread;
  }

  const repository: NotificationRepository = {
    async add(notification) {
      if ((await pointedSortKey(idPartition(notification.notificationId))) !== undefined) {
        // 同じ識別子の通知は、上書きする（件数は増やさない）
        await repository.update(notification);
        return;
      }
      const sortKey = timedSortKey(notification.createdAt, notification.notificationId);
      const pointer = { nsk: sortKey };
      // 重複抑制のキーの最新は、新しいほうを残す
      const latestDedup = await pointedSortKey(dedupPartition(notification.dedupKey));
      const operations: TransactItem[] = [
        notifications.putOperation(
          NOTIFICATION,
          sortKey,
          notification,
          indexKeys(notification, sortKey),
        ),
        {
          Put: {
            TableName: table,
            Item: { pk: idPartition(notification.notificationId), sk: 'P', ...pointer },
          },
        },
        counterAdd(db, TOTAL_COUNTER, 1),
        ...(latestDedup === undefined || latestDedup <= sortKey
          ? [
              {
                Put: {
                  TableName: table,
                  Item: { pk: dedupPartition(notification.dedupKey), sk: 'P', ...pointer },
                },
              },
            ]
          : []),
      ];
      await transactWrite(db, operations);
    },
    get: (notificationId) => getByPartition(idPartition(notificationId)),
    findLatestByDedupKey: (dedupKey) => getByPartition(dedupPartition(dedupKey)),
    async list(userId, filter, page): Promise<Page<NotificationWithReadState>> {
      const after = decodeKeyCursor(page.cursor, 1)?.[0];
      const collected: { sortKey: string; entry: NotificationWithReadState }[] = [];
      for await (const found of newestFirst(
        userId,
        after === undefined ? undefined : { pk: NOTIFICATION, sk: after },
        filter.until,
      )) {
        if (matchesFilter(found.entry.notification, found.entry.isRead, filter)) {
          collected.push(found);
          if (collected.length > page.limit) {
            break;
          }
        }
      }
      const items = collected.slice(0, page.limit);
      const last = items.at(-1);
      return {
        items: items.map((found) => found.entry),
        nextCursor:
          collected.length > page.limit && last !== undefined
            ? encodeKeyCursor([last.sortKey])
            : null,
      };
    },
    async unreadCount(userId) {
      const counts = await readCounters(db, [TOTAL_COUNTER, readCounter(userId)]);
      return Math.max(0, (counts.get(TOTAL_COUNTER) ?? 0) - (counts.get(readCounter(userId)) ?? 0));
    },
    async markRead(notificationId, userId, readAt) {
      if ((await pointedSortKey(idPartition(notificationId))) === undefined) {
        return false;
      }
      await markReadOnce(notificationId, userId, readAt);
      return true;
    },
    countUnread: async (userId, filter) => (await unreadIdsIn(userId, filter)).length,
    async markAllRead(userId, filter, readAt) {
      const unread = await unreadIdsIn(userId, filter);
      const results = await mapConcurrent(unread, CONCURRENCY, (notificationId) =>
        markReadOnce(notificationId, userId, readAt),
      );
      return results.filter(Boolean).length;
    },
    async update(notification) {
      const sortKey = await pointedSortKey(idPartition(notification.notificationId));
      if (sortKey === undefined) {
        await repository.add(notification);
        return;
      }
      await notifications.put(
        NOTIFICATION,
        sortKey,
        notification,
        indexKeys(notification, sortKey),
      );
    },
    async listStatusChangeTimes(since) {
      // 通知は、1 つのパーティションに、作成日時順（`{日時}#{通知ID}`）で入っている。指定した日時より後（ちょうどは含めない）を、古い順に読む
      const times: StatusChangeNotificationTime[] = [];
      for await (const item of queryItems(db, {
        table,
        hashName: 'pk',
        hashValue: NOTIFICATION,
        sortName: 'sk',
        lower: upperBoundOf(instantKey(since.toISOString())),
        forward: true,
        pageSize: LIST_PAGE_SIZE,
        consistent: true,
      })) {
        const notification = notifications.parse(item);
        if (
          notification.kind === 'STATUS_CHANGE' &&
          notification.equipmentId !== undefined &&
          notification.viewpointId !== undefined
        ) {
          times.push({
            equipmentId: notification.equipmentId,
            viewpointId: notification.viewpointId,
            createdAt: notification.createdAt,
          });
        }
      }
      return times;
    },
    async addMemo(memo) {
      // メモの項目と件数のカウンターを、同時に書く（同時の追記でも、失われない。通知の項目は、書き換えない）
      await transactWrite(db, [
        memos.putOperation(
          memoPartition(memo.notificationId),
          timedSortKey(memo.createdAt, memo.memoId),
          memo,
        ),
        counterAdd(db, memoCounter(memo.notificationId), 1),
      ]);
    },
    async listMemos(notificationId) {
      return (await queryAll(db, table, memoPartition(notificationId), { consistent: true })).map(
        memos.parse,
      );
    },
    async memoCounts(notificationIds) {
      if (notificationIds.length === 0) {
        return new Map();
      }
      const counts = await readCounters(db, notificationIds.map(memoCounter));
      return new Map(notificationIds.map((id) => [id, counts.get(memoCounter(id)) ?? 0]));
    },
    async listUndelivered() {
      const found: Notification[] = [];
      for await (const item of queryItems(db, {
        table,
        index: MAIN_INDEX_1,
        hashName: 'gsi1pk',
        hashValue: UNDELIVERED,
        sortName: 'gsi1sk',
        forward: true,
        pageSize: 1000,
      })) {
        const notification = notifications.parse(item);
        // 索引は、更新のたびに付け替える。念のため、条件を、読み取り側でも確かめる
        if (needsWebPushDelivery(notification)) {
          found.push(notification);
        }
      }
      return found;
    },
  };

  return repository;
}
