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
  Notification,
  NotificationListResponse,
  NotificationMemo,
  NotificationMemoInput,
  NotificationProgress,
  WebPushDelivery,
} from '@smart-farm/shared/schemas/notification';
import { NotificationIdSchema } from '@smart-farm/shared/schemas/common';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import {
  buildFederationExpiredDedupKey,
  buildFederationExpiredMessage,
  buildIngestionFailureDedupKey,
  buildIngestionFailureMessage,
  type IngestionNotificationSituation,
  buildStatusChangeDedupKey,
  buildStatusChangeMessage,
  isWithinSuppression,
} from '../../domain/notification-rules.ts';
import {
  isWebPushExpired,
  summarizeWebPushDeliveries,
  webPushRetryDelayMinutes,
  webPushTtlSeconds,
} from '../../domain/notification-delivery.ts';
import { buildNotificationProgress } from '../../domain/notification-progress.ts';
import {
  ALL_EQUIPMENT,
  canViewFacility,
  facilityIdsOf,
  type EquipmentScope,
} from '../access/facility-scope.ts';
import type { NotificationRecipients } from '../access/notification-recipients.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { IdGeneratorPort } from '../ports/id-generator-port.ts';
import type { Logger } from '../ports/logger-port.ts';
import { NotificationDeliveryError, type NotifierPort } from '../ports/notifier-port.ts';
import type {
  EvaluationRepository,
  NotificationListFilter,
  NotificationRepository,
  PushSubscriptionRepository,
} from '../ports/repositories.ts';
import type { PushSubscriptionRecord, StatusChangeEntry } from '../ports/records.ts';
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
  /**
   * 「注意」「異常」への悪化の通知を作る。通知するかの判断（出来事・改善・不明）は、呼び出し側が行う
   * （評価サービス。notification-rules.ts の `isNotifiableStatusChange`）。時間による抑制はしない（再発を通知するため。D-38）。
   */
  notifyStatusChange(input: StatusChangeNotificationInput): Promise<Notification>;
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
  /**
   * 連携の期限切れ（破棄の期限を過ぎて、項目を破棄した）の通知を作る。抑制の期間内の重複は作らず、null を返す
   * （抑制の間に破棄した分は、連携のログに残る）。
   */
  notifyFederationExpired(input: { expiryDays: number }): Promise<Notification | null>;
  /**
   * 通知にメモ（自由記述）を追記する（ADR-0019 の D-42。共有・追記のみ）。入力者と日時を記録する。通知がなければ undefined。
   * 農業情報基盤には送らない。変更履歴（監査ログ）にも載せない（メモ自体が、入力者と日時の記録）。
   */
  addMemo(
    notificationId: NotificationId,
    enteredBy: UserId,
    input: NotificationMemoInput,
    scope?: EquipmentScope,
  ): Promise<NotificationMemo | undefined>;
  /** 通知のメモ（入力の古い順。全件）。通知がなければ undefined。 */
  listMemos(
    notificationId: NotificationId,
    scope?: EquipmentScope,
  ): Promise<NotificationMemo[] | undefined>;
  /**
   * 閲覧範囲（`scope`。省略は、すべての通知）: 一覧・未読の件数・既読・一括既読・メモは、閲覧できるハウスの通知だけ。
   * 範囲外・ハウスに属さない通知（全設備を閲覧できない利用者）は、存在しないものとして扱う（Issue #331）。
   */
  list(
    userId: UserId,
    query: {
      kind?: NotificationKind | undefined;
      readState?: ReadState | undefined;
      limit: number;
      cursor?: string | undefined;
    },
    scope?: EquipmentScope,
  ): Promise<NotificationListResponse>;
  /**
   * 未読の件数。範囲（`kind`・`until`）を指定すると、その範囲の件数（一括既読の確認の件数。D-39）。
   * 指定がなければ、すべての未読（ヘッダーの未読数）。
   */
  unreadCount(
    userId: UserId,
    range?: { kind?: NotificationKind | undefined; until?: Date | undefined },
    scope?: EquipmentScope,
  ): Promise<number>;
  /** 既読にする。通知がない（閲覧範囲外を含む）場合は false。 */
  markRead(
    notificationId: NotificationId,
    userId: UserId,
    scope?: EquipmentScope,
  ): Promise<boolean>;
  /** 絞り込みの範囲（`until` 以前に届いた通知だけ）の未読を、すべて既読にする。新しく既読にした件数を返す（ADR-0019 の D-39）。 */
  markAllRead(
    userId: UserId,
    filter: NotificationListFilter,
    scope?: EquipmentScope,
  ): Promise<number>;
  /** 配信が未完了の通知を、Web Push の購読へ配信する（JB-04）。 */
  deliverPending(): Promise<DeliveryRunSummary>;
}

export interface NotificationServiceDeps {
  readonly notifications: NotificationRepository;
  /** 状態の変化の履歴（通知の経過・回復日時の導出に使う。ADR-0019 の D-42）。 */
  readonly evaluations: Pick<EvaluationRepository, 'listStatusChanges'>;
  readonly pushSubscriptions: PushSubscriptionRepository;
  /** Web Push の宛先（通知のハウスを閲覧できる利用者。Issue #331）。 */
  readonly recipients: NotificationRecipients;
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
  memoCount: number,
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
    memoCount,
  };
}

export function createNotificationService(deps: NotificationServiceDeps): NotificationService {
  const {
    notifications,
    evaluations,
    pushSubscriptions,
    recipients,
    webPush,
    clock,
    ids,
    settings,
    logger,
  } = deps;

  /** 通知を閲覧できるか（範囲外・ハウスなしは、全設備を閲覧できない利用者には、存在しない）。 */
  async function findVisible(
    notificationId: NotificationId,
    scope: EquipmentScope,
  ): Promise<Notification | undefined> {
    const notification = await notifications.get(notificationId);
    return notification !== undefined && canViewFacility(scope, notification.facilityId)
      ? notification
      : undefined;
  }

  /** 通知を作って保存する（抑制の判断はしない）。 */
  async function create(
    fields: Omit<Notification, 'notificationId' | 'createdAt' | 'deliveries'>,
  ): Promise<Notification> {
    const createdAt = clock.now().toISOString();
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

  /** 通知を作る。同じ鍵の通知が、抑制の期間内にあれば、作らず null を返す（取り込みの失敗・停止、連携の期限切れ。D-38）。 */
  async function createIfNotSuppressed(
    fields: Omit<Notification, 'notificationId' | 'createdAt' | 'deliveries'>,
  ): Promise<Notification | null> {
    const latest = await notifications.findLatestByDedupKey(fields.dedupKey);
    const lastCreatedAt = latest === undefined ? null : new Date(latest.createdAt);
    if (isWithinSuppression(lastCreatedAt, clock.now(), settings.suppressionMinutes)) {
      return null;
    }
    return create(fields);
  }

  /** 購読 1 件への、1 回の配信。結果を、購読ごとの状態にして返す（購読が無効なら、購読を無効にして、断念する）。 */
  async function attemptDelivery(
    notification: Notification,
    entry: WebPushDelivery,
    subscription: PushSubscriptionRecord,
    now: Date,
  ): Promise<{ entry: WebPushDelivery; outcome: 'DELIVERED' | 'FAILED' | 'GONE' }> {
    const attempts = entry.attempts + 1;
    const updatedAt = now.toISOString();
    try {
      const outcome = await withTimeout(
        () =>
          webPush.deliver(notification, subscription, {
            ttlSeconds: webPushTtlSeconds(
              notification.createdAt,
              now,
              settings.webPushExpiryMinutes,
            ),
          }),
        settings.ioTimeoutMs,
        'Web Push の配信',
      );
      if (outcome === 'SUBSCRIPTION_GONE') {
        await pushSubscriptions.deactivate(subscription.subscriptionId);
        return {
          entry: {
            subscriptionId: entry.subscriptionId,
            result: 'ABANDONED',
            attempts,
            updatedAt,
            errorMessage: '購読が無効になりました',
          },
          outcome: 'GONE',
        };
      }
      return {
        entry: { subscriptionId: entry.subscriptionId, result: 'SUCCESS', attempts, updatedAt },
        outcome: 'DELIVERED',
      };
    } catch (error) {
      const errorMessage =
        error instanceof NotificationDeliveryError
          ? error.message
          : error instanceof OperationTimeoutError
            ? '配信がタイムアウトしました'
            : '配信に失敗しました';
      // 理由（HTTP の状態コード・設定の不足など）は、運用で原因を切り分けるために残す。メッセージは、秘密情報・宛先を含まない
      logger.warn('Web Push の配信に失敗しました', {
        notificationId: notification.notificationId,
        attempts,
        reason: errorMessage,
      });
      const delayMinutes = webPushRetryDelayMinutes(
        attempts,
        settings.webPushRetryBaseMinutes,
        settings.webPushRetryMaxMinutes,
      );
      return {
        entry: {
          subscriptionId: entry.subscriptionId,
          result: 'FAILURE',
          attempts,
          nextAttemptAt: new Date(now.getTime() + delayMinutes * MS_PER_MINUTE).toISOString(),
          updatedAt,
          errorMessage,
        },
        outcome: 'FAILED',
      };
    }
  }

  const abandon = (entry: WebPushDelivery, errorMessage: string, now: Date): WebPushDelivery => ({
    subscriptionId: entry.subscriptionId,
    result: 'ABANDONED',
    attempts: entry.attempts,
    updatedAt: now.toISOString(),
    errorMessage,
  });

  /**
   * ページ内の状態変化の通知の、経過・回復日時を導出する（ADR-0019 の D-42。新しい保存はない）。
   * 同じ観点・設備の次の通知は、ページより新しい通知も含めて探す（ページ内で最も古い通知より新しい、状態変化の通知を、1 回で読む）。
   * 状態の変化の履歴は、観点・設備の組ごとに、1 回だけ読む。
   */
  async function progressOfPage(
    page: readonly Notification[],
  ): Promise<ReadonlyMap<string, NotificationProgress | null>> {
    const targets = page.filter(
      (notification) =>
        notification.kind === 'STATUS_CHANGE' &&
        notification.equipmentId !== undefined &&
        notification.viewpointId !== undefined,
    );
    const result = new Map<string, NotificationProgress | null>();
    if (targets.length === 0) {
      return result;
    }
    const oldest = Math.min(...targets.map((notification) => Date.parse(notification.createdAt)));
    const newer = await notifications.listStatusChangeTimes(new Date(oldest));
    const pairKey = (equipmentId: string, viewpointId: string): string =>
      `${equipmentId}#${viewpointId}`;
    const histories = new Map<string, Promise<StatusChangeEntry[]>>();
    const now = clock.now();
    await Promise.all(
      targets.map(async (notification) => {
        const equipmentId = notification.equipmentId;
        const viewpointId = notification.viewpointId;
        if (equipmentId === undefined || viewpointId === undefined) {
          return;
        }
        const key = pairKey(equipmentId, viewpointId);
        let history = histories.get(key);
        if (history === undefined) {
          history = evaluations.listStatusChanges(equipmentId, viewpointId);
          histories.set(key, history);
        }
        // 同じ観点・設備の、次の通知（この通知より新しい通知のうち、最も古いもの）
        const createdAt = Date.parse(notification.createdAt);
        const next = newer.find(
          (time) =>
            time.equipmentId === equipmentId &&
            time.viewpointId === viewpointId &&
            Date.parse(time.createdAt) > createdAt,
        );
        result.set(
          notification.notificationId,
          buildNotificationProgress({
            history: await history,
            notifiedAt: new Date(createdAt),
            nextNotifiedAt: next === undefined ? null : new Date(next.createdAt),
            now,
          }),
        );
      }),
    );
    return result;
  }

  return {
    notifyStatusChange(input) {
      const viewpointName = findViewpointMeta(input.viewpointId)?.name ?? input.viewpointId;
      return create({
        kind: 'STATUS_CHANGE',
        viewpointId: input.viewpointId,
        equipmentId: input.equipment.equipmentId,
        // 閲覧範囲のハウス（作成時に固定する。ハウス自身は、その ID。Issue #331）
        facilityId: input.equipment.facilityId ?? input.equipment.equipmentId,
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

    notifyFederationExpired(input) {
      return createIfNotSuppressed({
        kind: 'FEDERATION_EXPIRED',
        message: buildFederationExpiredMessage(input.expiryDays),
        dedupKey: buildFederationExpiredDedupKey(),
      });
    },

    async list(userId, query, scope = ALL_EQUIPMENT) {
      const filter: NotificationListFilter = omitUndefined({
        kind: query.kind,
        readState: query.readState,
        facilityIds: facilityIdsOf(scope),
      });
      const page = await notifications.list(userId, filter, {
        limit: query.limit,
        cursor: query.cursor,
      });
      const progress = await progressOfPage(page.items.map(({ notification }) => notification));
      // メモの件数は、ページ内の通知を、まとめて読む（1 回）
      const memoCounts = await notifications.memoCounts(
        page.items.map(({ notification }) => notification.notificationId),
      );
      return {
        items: page.items.map(({ notification, isRead }) => ({
          ...toNotificationItem(
            notification,
            isRead,
            memoCounts.get(notification.notificationId) ?? 0,
          ),
          ...(progress.has(notification.notificationId)
            ? { progress: progress.get(notification.notificationId) ?? null }
            : {}),
        })),
        nextCursor: page.nextCursor,
        asOf: clock.now().toISOString(),
      };
    },

    async addMemo(notificationId, enteredBy, input, scope = ALL_EQUIPMENT) {
      if ((await findVisible(notificationId, scope)) === undefined) {
        return undefined;
      }
      const memo: NotificationMemo = {
        memoId: ids.next(),
        notificationId,
        enteredBy,
        body: input.body,
        createdAt: clock.now().toISOString(),
      };
      await notifications.addMemo(memo);
      logger.info('通知のメモを追記しました', { notificationId });
      return memo;
    },

    async listMemos(notificationId, scope = ALL_EQUIPMENT) {
      if ((await findVisible(notificationId, scope)) === undefined) {
        return undefined;
      }
      return notifications.listMemos(notificationId);
    },

    unreadCount(userId, range, scope = ALL_EQUIPMENT) {
      const facilityIds = facilityIdsOf(scope);
      if (range === undefined || (range.kind === undefined && range.until === undefined)) {
        return notifications.unreadCount(userId, facilityIds);
      }
      return notifications.countUnread(
        userId,
        omitUndefined({ kind: range.kind, until: range.until, facilityIds }),
      );
    },
    async markRead(notificationId, userId, scope = ALL_EQUIPMENT) {
      if ((await findVisible(notificationId, scope)) === undefined) {
        return false;
      }
      return notifications.markRead(notificationId, userId, clock.now());
    },
    markAllRead: (userId, filter, scope = ALL_EQUIPMENT) =>
      notifications.markAllRead(
        userId,
        omitUndefined({ ...filter, facilityIds: facilityIdsOf(scope) }),
        clock.now(),
      ),

    async deliverPending() {
      const pending = await notifications.listUndelivered();
      let delivered = 0;
      let failed = 0;
      // 購読は、1回の実行につき1度だけ取得する。配信で無効になった購読（SUBSCRIPTION_GONE）は、以降の通知の配信先から除く
      let subscriptions = await pushSubscriptions.listActive();
      for (const notification of pending) {
        const now = clock.now();
        const legacyWebPush = notification.deliveries.find(
          (delivery) => delivery.channel === 'WEB_PUSH',
        );
        // 配信の対象は、最初の配信の実行時点の、有効な購読。購読ごとの状態を持たない以前の形式の失敗は、配信せずに、終了させる
        const isLegacyFailure =
          notification.webPushDeliveries === undefined && legacyWebPush?.result === 'FAILURE';
        // 配信の宛先は、通知のハウスを閲覧できる利用者の購読だけ（ハウスに属さない通知は、全設備を閲覧できる利用者だけ。Issue #331）
        const allowed =
          notification.webPushDeliveries === undefined && !isLegacyFailure
            ? await recipients.recipientsOf(notification.facilityId)
            : undefined;
        const current: readonly WebPushDelivery[] =
          notification.webPushDeliveries ??
          (isLegacyFailure
            ? []
            : subscriptions
                .filter((subscription) => allowed?.has(subscription.userId) === true)
                .map((subscription) => ({
                  subscriptionId: subscription.subscriptionId,
                  result: 'PENDING' as const,
                  attempts: 0,
                  updatedAt: now.toISOString(),
                })));
        const expired = isWebPushExpired(
          notification.createdAt,
          now,
          settings.webPushExpiryMinutes,
        );
        const active = new Map(
          subscriptions.map((subscription) => [subscription.subscriptionId, subscription]),
        );
        const updated: WebPushDelivery[] = [];
        for (const entry of current) {
          if (entry.result === 'SUCCESS' || entry.result === 'ABANDONED') {
            updated.push(entry);
            continue;
          }
          const subscription = active.get(entry.subscriptionId);
          if (expired) {
            updated.push(
              abandon(
                entry,
                `配信の期限（${String(settings.webPushExpiryMinutes)} 分）を過ぎたため、断念しました`,
                now,
              ),
            );
          } else if (subscription === undefined) {
            updated.push(abandon(entry, '購読が無効になりました', now));
          } else if (
            entry.result === 'FAILURE' &&
            Date.parse(entry.nextAttemptAt ?? '') > now.getTime()
          ) {
            // 次の試行の日時の前は、再送しない
            updated.push(entry);
          } else {
            const attempt = await attemptDelivery(notification, entry, subscription, now);
            updated.push(attempt.entry);
            if (attempt.outcome === 'DELIVERED') {
              delivered += 1;
            } else if (attempt.outcome === 'FAILED') {
              failed += 1;
            } else {
              subscriptions = subscriptions.filter(
                (item) => item.subscriptionId !== entry.subscriptionId,
              );
            }
          }
        }
        // まとめの状態（画面内の通知は、別。配信が未完了の間は PENDING）。以前の形式の失敗は、失敗のまま終了させる
        const summary = isLegacyFailure
          ? { result: 'FAILURE' as const, attempts: legacyWebPush.attempts }
          : summarizeWebPushDeliveries(updated);
        await notifications.update({
          ...notification,
          webPushDeliveries: updated,
          deliveries: [
            ...notification.deliveries.filter((delivery) => delivery.channel !== 'WEB_PUSH'),
            {
              channel: 'WEB_PUSH',
              result: summary.result,
              attempts: summary.attempts,
              updatedAt: now.toISOString(),
              ...omitUndefined({
                errorMessage: isLegacyFailure ? legacyWebPush.errorMessage : summary.errorMessage,
              }),
            },
          ],
        });
      }
      return { notificationsProcessed: pending.length, delivered, failed };
    },
  };
}
