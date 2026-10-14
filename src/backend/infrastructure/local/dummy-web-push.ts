/**
 * Web Push のダミー（NotifierPort の実装）。実際の配信は行わず、配信した内容を記録する。
 * E2E では、購読の登録・解除と配信の記録を検証する（ブラウザへの実配信は検証しない）。
 * UP: 配信できる／DOWN: 配信に失敗する（再送の検証）／REJECT: 購読が無効（購読の無効化の検証）。
 */

import {
  NotificationDeliveryError,
  type DeliveryOutcome,
  type NotifierPort,
} from '../../application/ports/notifier-port.ts';
import type { PushSubscriptionRecord } from '../../application/ports/records.ts';
import type { Notification } from '@smart-farm/shared/schemas/notification';
import type { FaultController } from './faults.ts';

export interface DummyWebPush extends NotifierPort {
  delivered(): readonly { notificationId: string; subscriptionId: string }[];
  reset(): void;
}

export function createDummyWebPush(options: { faults: FaultController }): DummyWebPush {
  const delivered: { notificationId: string; subscriptionId: string }[] = [];
  return {
    deliver(
      notification: Notification,
      subscription: PushSubscriptionRecord,
    ): Promise<DeliveryOutcome> {
      const { mode } = options.faults.get();
      if (mode === 'DOWN') {
        return Promise.reject(
          new NotificationDeliveryError('Web Push の配信サービスに接続できません'),
        );
      }
      if (mode === 'REJECT') {
        return Promise.resolve('SUBSCRIPTION_GONE');
      }
      delivered.push({
        notificationId: notification.notificationId,
        subscriptionId: subscription.subscriptionId,
      });
      return Promise.resolve('DELIVERED');
    },
    delivered: () => delivered,
    reset() {
      delivered.length = 0;
    },
  };
}
