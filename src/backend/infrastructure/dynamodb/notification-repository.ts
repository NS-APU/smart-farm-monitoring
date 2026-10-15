/**
 * 通知の Repository（DynamoDB 実装）。通知の既読は、通知と利用者の組ごと（暫定。Q-018）。
 *
 * - 通知: `NOTIF` / `{作成日時}#{通知ID}`（新しい順に Query）。配信が未完了の間だけ、疎な GSI1（`UNDELIVERED`）に載る
 * - ポインタ: `NID#{通知ID}`（通知のソートキー）、`DEDUP#{重複抑制のキー}`（最新の通知のソートキー）。強い整合で引く
 * - 既読: `READ#{利用者}` / `{通知ID}`。通知の総数（`NOTIF_TOTAL`）と、利用者ごとの既読数（`READ#{利用者}`）は、
 *   カウンターで持つ。未読の件数は、その差（全件を数えない）。利用者が作られる前の通知も、未読に数える
 * - 通知の作成日時は、変えない（ソートキーに入っているため、更新では、作成時のソートキーを使う）
 */

import { NotificationSchema, type Notification } from '@smart-farm/shared/schemas/notification';
import type {
  NotificationListFilter,
  NotificationRepository,
  NotificationWithReadState,
  Page,
} from '../../application/ports/repositories.ts';
import { decodeKeyCursor, encodeKeyCursor } from './key-cursor.ts';
import { timedSortKey } from './keys.ts';
import { counterAdd, mainAggregate, readCounters } from './main-table.ts';
import {
  batchGetItems,
  getItem,
  isTransactionConditionFailed,
  mapConcurrent,
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

/** Web Push の配信が、未完了（未配信、または失敗）か。再送の上限は、読み取り側で見る。 */
function isUndelivered(notification: Notification): boolean {
  const webPush = notification.deliveries.find((delivery) => delivery.channel === 'WEB_PUSH');
  return webPush !== undefined && (webPush.result === 'PENDING' || webPush.result === 'FAILURE');
}

export function createNotificationRepository(db: Database): NotificationRepository {
  const table = db.tables.main;
  const notifications = mainAggregate(db, NotificationSchema);

  /** 配信が未完了の通知だけが持つ、GSI1 のキー。 */
  const indexKeys = (notification: Notification, sortKey: string): Item =>
    isUndelivered(notification) ? { gsi1pk: UNDELIVERED, gsi1sk: sortKey } : {};

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

  /** 通知のページを、新しい順に読み、利用者ごとの既読を付ける。 */
  async function* newestFirst(
    userId: string,
    startAfter: Item | undefined,
  ): AsyncGenerator<{ readonly sortKey: string; readonly entry: NotificationWithReadState }> {
    for await (const items of queryPages(db, {
      table,
      hashName: 'pk',
      hashValue: NOTIFICATION,
      sortName: 'sk',
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
    async markAllRead(userId, filter, readAt) {
      if (filter.readState === 'READ') {
        return 0;
      }
      const unread: string[] = [];
      for await (const found of newestFirst(userId, undefined)) {
        if (!found.entry.isRead && matchesFilter(found.entry.notification, false, filter)) {
          unread.push(found.entry.notification.notificationId);
        }
      }
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
    async listUndelivered(maxAttempts) {
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
        const webPush = notification.deliveries.find((delivery) => delivery.channel === 'WEB_PUSH');
        if (
          webPush?.result === 'PENDING' ||
          (webPush?.result === 'FAILURE' && webPush.attempts < maxAttempts)
        ) {
          found.push(notification);
        }
      }
      return found;
    },
  };

  return repository;
}
