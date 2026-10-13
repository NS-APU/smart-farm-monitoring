/**
 * Web Push の購読のユースケース（UC-23。FR-7.2）。購読は、利用者・端末（endpoint）ごと（暫定。dev_spec.md 4章 No.19）。
 * 配信は、通知の作成後に、JB-04 が購読者全員へ行う（notification-service.ts）。購読がなければ、画面内の通知のみ。
 * 公開鍵（VAPID）が設定されていない環境では、購読を受け付けない。
 */

import { createHash } from 'node:crypto';
import { AppError } from '@smart-farm/shared/errors';
import type { UserId } from '@smart-farm/shared/schemas/common';
import type { PushStatusResponse } from '@smart-farm/shared/schemas/notification';
import type { ClockPort } from '../ports/clock-port.ts';
import type { PushSubscriptionRepository } from '../ports/repositories.ts';

export interface PushSubscriptionService {
  /** 購読の状態。endpoint を指定すれば、その端末の購読が有効か。指定しなければ、利用者のいずれかの端末が有効か。 */
  status(userId: UserId, endpoint?: string): Promise<PushStatusResponse>;
  /** 購読を登録する（同じ利用者・端末は上書き）。公開鍵の設定がなければ SERVICE_UNAVAILABLE。 */
  subscribe(userId: UserId, endpoint: string): Promise<void>;
  /** 購読を解除する。endpoint を指定しなければ、利用者の購読をすべて解除する。 */
  unsubscribe(userId: UserId, endpoint?: string): Promise<void>;
}

export interface PushSubscriptionServiceDeps {
  readonly subscriptions: PushSubscriptionRepository;
  readonly clock: ClockPort;
  /** 購読に使う公開鍵（VAPID）。未設定は undefined。 */
  readonly publicKey: string | undefined;
}

export function pushSubscriptionId(userId: UserId, endpoint: string): string {
  return `sub-${createHash('sha256').update(`${userId}\n${endpoint}`).digest('hex').slice(0, 24)}`;
}

export function createPushSubscriptionService(
  deps: PushSubscriptionServiceDeps,
): PushSubscriptionService {
  const { subscriptions, clock, publicKey } = deps;

  return {
    async status(userId, endpoint) {
      const own = await subscriptions.listByUser(userId);
      return {
        isAvailable: publicKey !== undefined,
        publicKey: publicKey ?? null,
        isSubscribed: own.some(
          (subscription) =>
            subscription.isActive && (endpoint === undefined || subscription.endpoint === endpoint),
        ),
      };
    },

    async subscribe(userId, endpoint) {
      if (publicKey === undefined) {
        throw new AppError('SERVICE_UNAVAILABLE', 'このサーバーでは、Web Push を利用できません');
      }
      await subscriptions.save({
        subscriptionId: pushSubscriptionId(userId, endpoint),
        userId,
        endpoint,
        isActive: true,
        createdAt: clock.now().toISOString(),
      });
    },

    async unsubscribe(userId, endpoint) {
      const targets = (await subscriptions.listByUser(userId)).filter(
        (subscription) => endpoint === undefined || subscription.endpoint === endpoint,
      );
      for (const subscription of targets) {
        await subscriptions.delete(subscription.subscriptionId);
      }
    },
  };
}
