/**
 * 異常検知・通知のユースケース（UC-05, UC-10, UC-22, UC-24。JB-04）。
 * 通知の作成（重複抑制つき）、一覧・既読、Web Push の配信と再送。
 * 画面内の通知は、通知の保存そのもの（必ず行う）。Web Push の失敗は、評価・取り込み・画面内通知に影響させない。
 */

import { findViewpointMeta, type ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import type {
  EvaluationStatus,
  NotificationKind,
  ReadState,
} from '@smart-farm/shared/constants/status';
import type { NotificationId, UserId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type {
  Delivery,
  Notification,
  NotificationListResponse,
} from '@smart-farm/shared/schemas/notification';
import { NotificationIdSchema } from '@smart-farm/shared/schemas/common';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import {
  buildIngestionFailureDedupKey,
  buildIngestionFailureMessage,
  type IngestionNotificationSituation,
  buildStatusChangeDedupKey,
  buildStatusChangeMessage,
  isWithinSuppression,
} from '../../domain/notification-rules.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { IdGeneratorPort } from '../ports/id-generator-port.ts';
import type { Logger } from '../ports/logger-port.ts';
import { NotificationDeliveryError, type NotifierPort } from '../ports/notifier-port.ts';
import type {
  NotificationListFilter,
  NotificationRepository,
  PushSubscriptionRepository,
} from '../ports/repositories.ts';
import type { PushSubscriptionRecord } from '../ports/records.ts';
import type { AppSettings } from '../settings.ts';
import { OperationTimeoutError, withTimeout } from '../with-timeout.ts';

export interface StatusChangeNotificationInput {
  readonly equipment: Equipment;
  readonly viewpointId: ViewpointId;
  readonly status: EvaluationStatus;
  readonly diagnosticMessage: string;
}

export interface DeliveryRunSummary {
  readonly notificationsProcessed: number;
  readonly delivered: number;
  readonly failed: number;
}

export interface NotificationService {
  /** 「注意」「異常」への変化の通知を作る。抑制の期間内の重複は作らず、null を返す。 */
  notifyStatusChange(input: StatusChangeNotificationInput): Promise<Notification | null>;
  /**
   * 取り込みの失敗（再試行後）、または、データ取得の停止（situation: 'STOPPED'。新しいデータが届かない）の通知を作る。
   * 抑制の期間内の重複は作らず、null を返す（失敗と停止は、別々に数える）。
   */
  notifyIngestionFailure(input: {
    sourceId: string;
    sourceName: string;
    reason: string;
    situation?: IngestionNotificationSituation;
  }): Promise<Notification | null>;
  list(
    userId: UserId,
    query: {
      kind?: NotificationKind | undefined;
      readState?: ReadState | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ): Promise<NotificationListResponse>;
  unreadCount(userId: UserId): Promise<number>;
  /** 既読にする。通知がなければ false。 */
  markRead(notificationId: NotificationId, userId: UserId): Promise<boolean>;
  markAllRead(userId: UserId, filter: NotificationListFilter): Promise<number>;
  /** 配信が未完了の通知を、Web Push の購読へ配信する（JB-04）。 */
  deliverPending(): Promise<DeliveryRunSummary>;
}

export interface NotificationServiceDeps {
  readonly notifications: NotificationRepository;
  readonly pushSubscriptions: PushSubscriptionRepository;
  readonly webPush: NotifierPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly settings: AppSettings['notification'];
  readonly logger: Logger;
}

/** 通知を、API の一覧の項目にする。 */
function toNotificationItem(
  notification: Notification,
  isRead: boolean,
): NotificationListResponse['items'][number] {
  return {
    notificationId: notification.notificationId,
    kind: notification.kind,
    ...omitUndefined({
      viewpointId: notification.viewpointId,
      equipmentId: notification.equipmentId,
      sourceId: notification.sourceId,
      status: notification.status,
    }),
    message: notification.message,
    createdAt: notification.createdAt,
    readState: isRead ? 'READ' : 'UNREAD',
  };
}

/** Web Push の配信の状態（今回の試行の結果）。failure があれば失敗として、メッセージを残す。 */
function buildWebPushDelivery(
  previous: Delivery | undefined,
  failure: string | undefined,
  updatedAt: string,
): Delivery {
  const attempts = (previous?.attempts ?? 0) + 1;
  return failure === undefined
    ? { channel: 'WEB_PUSH', result: 'SUCCESS', attempts, updatedAt }
    : { channel: 'WEB_PUSH', result: 'FAILURE', attempts, updatedAt, errorMessage: failure };
}

export function createNotificationService(deps: NotificationServiceDeps): NotificationService {
  const { notifications, pushSubscriptions, webPush, clock, ids, settings, logger } = deps;

  async function createIfNotSuppressed(
    fields: Omit<Notification, 'notificationId' | 'createdAt' | 'deliveries'>,
  ): Promise<Notification | null> {
    const now = clock.now();
    const latest = await notifications.findLatestByDedupKey(fields.dedupKey);
    const lastCreatedAt = latest === undefined ? null : new Date(latest.createdAt);
    if (isWithinSuppression(lastCreatedAt, now, settings.suppressionMinutes)) {
      return null;
    }
    const createdAt = now.toISOString();
    const notification: Notification = {
      ...fields,
      notificationId: NotificationIdSchema.parse(ids.next()),
      createdAt,
      deliveries: [
        { channel: 'IN_APP', result: 'SUCCESS', attempts: 1, updatedAt: createdAt },
        { channel: 'WEB_PUSH', result: 'PENDING', attempts: 0, updatedAt: createdAt },
      ],
    };
    await notifications.add(notification);
    logger.info('通知を作成しました', { kind: notification.kind, dedupKey: notification.dedupKey });
    return notification;
  }

  /**
   * 通知を、購読へ順に配信する。無効になった購読は無効化する。失敗は、記録して再送する
   * （他の購読・機能には影響させない）。失敗があれば、最後の失敗のメッセージを返す。
   */
  async function deliverToSubscriptions(
    notification: Notification,
    subscriptions: readonly PushSubscriptionRecord[],
    gone: Set<string>,
  ): Promise<string | undefined> {
    let failure: string | undefined;
    for (const subscription of subscriptions) {
      try {
        const outcome = await withTimeout(
          () => webPush.deliver(notification, subscription),
          settings.ioTimeoutMs,
          'Web Push の配信',
        );
        if (outcome === 'SUBSCRIPTION_GONE') {
          await pushSubscriptions.deactivate(subscription.subscriptionId);
          gone.add(subscription.subscriptionId);
        }
      } catch (error) {
        failure =
          error instanceof NotificationDeliveryError
            ? error.message
            : error instanceof OperationTimeoutError
              ? '配信がタイムアウトしました'
              : '配信に失敗しました';
        logger.warn('Web Push の配信に失敗しました', {
          notificationId: notification.notificationId,
        });
      }
    }
    return failure;
  }

  return {
    notifyStatusChange(input) {
      const viewpointName = findViewpointMeta(input.viewpointId)?.name ?? input.viewpointId;
      return createIfNotSuppressed({
        kind: 'STATUS_CHANGE',
        viewpointId: input.viewpointId,
        equipmentId: input.equipment.equipmentId,
        status: input.status,
        message: buildStatusChangeMessage({
          viewpointName,
          equipmentName: input.equipment.name,
          status: input.status,
          diagnosticMessage: input.diagnosticMessage,
        }),
        dedupKey: buildStatusChangeDedupKey(
          input.viewpointId,
          input.equipment.equipmentId,
          input.status,
        ),
      });
    },

    notifyIngestionFailure(input) {
      return createIfNotSuppressed({
        kind: 'INGESTION_FAILURE',
        sourceId: input.sourceId,
        message: buildIngestionFailureMessage(input.sourceName, input.reason, input.situation),
        dedupKey: buildIngestionFailureDedupKey(input.sourceId, input.situation),
      });
    },

    async list(userId, query) {
      const filter: NotificationListFilter = omitUndefined({
        kind: query.kind,
        readState: query.readState,
      });
      const page = await notifications.list(userId, filter, {
        limit: query.limit,
        cursor: query.cursor,
      });
      return {
        items: page.items.map(({ notification, isRead }) =>
          toNotificationItem(notification, isRead),
        ),
        nextCursor: page.nextCursor,
      };
    },

    unreadCount: (userId) => notifications.unreadCount(userId),
    markRead: (notificationId, userId) =>
      notifications.markRead(notificationId, userId, clock.now()),
    markAllRead: (userId, filter) => notifications.markAllRead(userId, filter, clock.now()),

    async deliverPending() {
      const pending = await notifications.listUndelivered(settings.maxDeliveryAttempts);
      let delivered = 0;
      let failed = 0;
      // 購読は、1回の実行につき1度だけ取得する。配信で無効になった購読（SUBSCRIPTION_GONE）は、以降の通知の配信先から除く
      let subscriptions = await pushSubscriptions.listActive();
      for (const notification of pending) {
        const now = clock.now().toISOString();
        const previous = notification.deliveries.find(
          (delivery) => delivery.channel === 'WEB_PUSH',
        );
        const gone = new Set<string>();
        const failure = await deliverToSubscriptions(notification, subscriptions, gone);
        if (gone.size > 0) {
          subscriptions = subscriptions.filter((item) => !gone.has(item.subscriptionId));
        }
        const updated = buildWebPushDelivery(previous, failure, now);
        await notifications.update({
          ...notification,
          deliveries: [
            ...notification.deliveries.filter((delivery) => delivery.channel !== 'WEB_PUSH'),
            updated,
          ],
        });
        if (failure === undefined) {
          delivered += 1;
        } else {
          failed += 1;
        }
      }
      return { notificationsProcessed: pending.length, delivered, failed };
    },
  };
}
