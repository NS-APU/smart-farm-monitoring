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
  /** テスト通知（#159 SC-15-2）として送った内容。通知の配信（`delivered`）とは、別に記録する。 */
  testDelivered(): readonly { subscriptionId: string }[];
  reset(): void;
}

export function createDummyWebPush(options: { faults: FaultController }): DummyWebPush {
  const delivered: { notificationId: string; subscriptionId: string }[] = [];
  const testDelivered: { subscriptionId: string }[] = [];

  /** 通知の配信・テスト通知で共通の、状態（停止・拒否）の再現。配信できるときだけ、undefined を返す。 */
  function simulatedFailure(): Promise<DeliveryOutcome> | undefined {
    const { mode } = options.faults.get();
    if (mode === 'DOWN') {
      return Promise.reject(
        new NotificationDeliveryError('Web Push の配信サービスに接続できません'),
      );
    }
    if (mode === 'REJECT') {
      return Promise.resolve('SUBSCRIPTION_GONE');
    }
    return undefined;
  }

  return {
    deliver(
      notification: Notification,
      subscription: PushSubscriptionRecord,
    ): Promise<DeliveryOutcome> {
      const failure = simulatedFailure();
      if (failure !== undefined) {
        return failure;
      }
      delivered.push({
        notificationId: notification.notificationId,
        subscriptionId: subscription.subscriptionId,
      });
      return Promise.resolve('DELIVERED');
    },
    deliverTest(subscription: PushSubscriptionRecord): Promise<DeliveryOutcome> {
      const failure = simulatedFailure();
      if (failure !== undefined) {
        return failure;
      }
      testDelivered.push({ subscriptionId: subscription.subscriptionId });
      return Promise.resolve('DELIVERED');
    },
    delivered: () => delivered,
    testDelivered: () => testDelivered,
    reset() {
      delivered.length = 0;
      testDelivered.length = 0;
    },
  };
}
