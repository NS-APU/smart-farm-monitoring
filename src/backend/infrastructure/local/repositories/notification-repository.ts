/** 通知の Repository（ローカル実装）。通知の既読は、通知と利用者の組ごとに記録する。 */

import { z } from 'zod';
import { NotificationSchema, type Notification } from '@smart-farm/shared/schemas/notification';
import type {
  NotificationListFilter,
  NotificationRepository,
} from '../../../application/ports/repositories.ts';
import type { LocalStore } from '../local-store.ts';
import { paginated, readKey, saverOf } from './collection-helpers.ts';

const NotificationReadSchema = z.object({
  notificationId: z.string(),
  userId: z.string(),
  readAt: z.string(),
});

function newestFirst<Item extends { createdAt: string }>(left: Item, right: Item): number {
  return right.createdAt.localeCompare(left.createdAt);
}

function matchesNotification(
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

export function createNotificationRepository(store: LocalStore): NotificationRepository {
  const notifications = store.collection(
    'notifications',
    NotificationSchema,
    (item) => item.notificationId,
  );
  const notificationReads = store.collection('notificationReads', NotificationReadSchema, (item) =>
    readKey(item.notificationId, item.userId),
  );
  const isReadBy = (notification: Notification, userId: string): boolean =>
    notificationReads.get(readKey(notification.notificationId, userId)) !== undefined;

  return {
    add: saverOf(notifications),
    get: (notificationId) => Promise.resolve(notifications.get(notificationId)),
    findLatestByDedupKey(dedupKey) {
      // 最も新しい1件だけが必要なため、並べ替えず、1回の走査で求める
      let latest: Notification | undefined;
      for (const item of notifications.values()) {
        if (item.dedupKey === dedupKey && (latest === undefined || newestFirst(item, latest) < 0)) {
          latest = item;
        }
      }
      return Promise.resolve(latest);
    },
    list(userId, filter, page) {
      const matched = notifications
        .values()
        .filter((item) => matchesNotification(item, isReadBy(item, userId), filter))
        .sort(
          (left, right) =>
            newestFirst(left, right) || left.notificationId.localeCompare(right.notificationId),
        )
        .map((notification) => ({ notification, isRead: isReadBy(notification, userId) }));
      return paginated(matched, page);
    },
    unreadCount: (userId) =>
      Promise.resolve(notifications.values().filter((item) => !isReadBy(item, userId)).length),
    markRead(notificationId, userId, readAt) {
      if (notifications.get(notificationId) === undefined) {
        return Promise.resolve(false);
      }
      if (notificationReads.get(readKey(notificationId, userId)) === undefined) {
        notificationReads.put({ notificationId, userId, readAt: readAt.toISOString() });
      }
      return Promise.resolve(true);
    },
    markAllRead(userId, filter, readAt) {
      let count = 0;
      for (const item of notifications.values()) {
        if (!isReadBy(item, userId) && matchesNotification(item, false, filter)) {
          notificationReads.put({
            notificationId: item.notificationId,
            userId,
            readAt: readAt.toISOString(),
          });
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    update: saverOf(notifications),
    listUndelivered: (maxAttempts) =>
      Promise.resolve(
        notifications.values().filter((item) => {
          const webPush = item.deliveries.find((delivery) => delivery.channel === 'WEB_PUSH');
          return (
            webPush !== undefined &&
            (webPush.result === 'PENDING' ||
              (webPush.result === 'FAILURE' && webPush.attempts < maxAttempts))
          );
        }),
      ),
  };
}
