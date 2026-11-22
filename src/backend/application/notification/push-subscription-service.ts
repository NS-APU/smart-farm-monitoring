/**
 * Web Push の購読のユースケース（UC-23。FR-7.2）。購読は、利用者・端末（endpoint）ごと（暫定。dev_spec.md 4章 No.19）。
 * 配信は、通知の作成後に、JB-04 が購読者全員へ行う（notification-service.ts）。購読がなければ、画面内の通知のみ。
 * 公開鍵（VAPID）が設定されていない環境では、購読を受け付けない。
 * テスト通知（設定画面の「テスト通知を送る」。#159 SC-15-2）は、自分のこの端末（この購読）だけへ、1 分に 1 回まで送る。通知の記録には、残さない。
 */

import { createHash } from 'node:crypto';
import { AppError } from '@smart-farm/shared/errors';
import type { UserId } from '@smart-farm/shared/schemas/common';
import type { PushKeys, PushStatusResponse } from '@smart-farm/shared/schemas/notification';
import type { ClockPort } from '../ports/clock-port.ts';
import {
  NotificationDeliveryError,
  type DeliveryOutcome,
  type NotifierPort,
} from '../ports/notifier-port.ts';
import type { PushSubscriptionRepository } from '../ports/repositories.ts';
import { OperationTimeoutError, withTimeout } from '../with-timeout.ts';

/** テスト通知を、同じ端末（購読）へ送れる間隔（秒。1 分に 1 回まで）。Web Push の有効期限（TTL）にも使う（古いテスト通知を、あとから届けない）。 */
export const PUSH_TEST_INTERVAL_SECONDS = 60;

const INVALIDATED_MESSAGE =
  'この端末の Web Push 通知は、無効になりました。もう一度有効にしてください';

export interface PushSubscriptionService {
  /** 購読の状態。endpoint を指定すれば、その端末の購読が有効か。指定しなければ、利用者のいずれかの端末が有効か。 */
  status(userId: UserId, endpoint?: string): Promise<PushStatusResponse>;
  /**
   * 購読を登録する（同じ利用者・端末は上書き）。公開鍵の設定がなければ SERVICE_UNAVAILABLE。
   * `keys` は、本文つきの配信に使う暗号鍵（#241）。なければ、本文なしで配信する。
   */
  subscribe(userId: UserId, endpoint: string, keys?: PushKeys): Promise<void>;
  /** 購読を解除する。endpoint を指定しなければ、利用者の購読をすべて解除する。 */
  unsubscribe(userId: UserId, endpoint?: string): Promise<void>;
  /**
   * この端末（endpoint の購読）へ、テスト通知を送る。通知の記録は作らない。
   * 購読がない（利用者のものでない・解除済み）なら NOT_FOUND、無効にされた購読・配信サービスが購読を無効と返したなら CONFLICT（購読を無効にする）、
   * 1 分以内の再送は RATE_LIMITED、配信の失敗は SERVICE_UNAVAILABLE。制限は、送る前に、購読の記録へ書く（失敗も数える。複数の実行環境でも守る）。
   */
  sendTest(userId: UserId, endpoint: string): Promise<void>;
}

export interface PushSubscriptionServiceDeps {
  readonly subscriptions: PushSubscriptionRepository;
  readonly clock: ClockPort;
  /** 購読に使う公開鍵（VAPID）。未設定は undefined。 */
  readonly publicKey: string | undefined;
  /** テスト通知の送信先（Web Push の配信。実配信かダミー）。 */
  readonly webPush: NotifierPort;
  /** テスト通知の 1 回の送信のタイムアウト（ミリ秒。0 以下はタイムアウトなし）。 */
  readonly ioTimeoutMs: number;
}

export function pushSubscriptionId(userId: UserId, endpoint: string): string {
  return `sub-${createHash('sha256').update(`${userId}\n${endpoint}`).digest('hex').slice(0, 24)}`;
}

export function createPushSubscriptionService(
  deps: PushSubscriptionServiceDeps,
): PushSubscriptionService {
  const { subscriptions, clock, publicKey, webPush, ioTimeoutMs } = deps;

  return {
    async status(userId, endpoint) {
      const own = await subscriptions.listByUser(userId);
      const targets = own.filter(
        (subscription) => endpoint === undefined || subscription.endpoint === endpoint,
      );
      const isSubscribed = targets.some((subscription) => subscription.isActive);
      return {
        isAvailable: publicKey !== undefined,
        publicKey: publicKey ?? null,
        isSubscribed,
        // 無効にされた購読の記録が残っていて、有効なものがない（もう一度有効にすると、記録は有効になり、消える）
        isInvalidated: !isSubscribed && targets.some((subscription) => !subscription.isActive),
      };
    },

    async subscribe(userId, endpoint, keys) {
      if (publicKey === undefined) {
        throw new AppError('SERVICE_UNAVAILABLE', 'このサーバーでは、Web Push を利用できません');
      }
      const subscriptionId = pushSubscriptionId(userId, endpoint);
      // テスト通知の制限は、購読し直しても、消えない（解除・再登録で、1 分の制限を避けられないように）
      const testSentAt = (await subscriptions.listByUser(userId)).find(
        (subscription) => subscription.subscriptionId === subscriptionId,
      )?.testSentAt;
      await subscriptions.save({
        subscriptionId,
        userId,
        endpoint,
        ...(keys === undefined ? {} : { keys }),
        isActive: true,
        createdAt: clock.now().toISOString(),
        ...(testSentAt === undefined ? {} : { testSentAt }),
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

    async sendTest(userId, endpoint) {
      const subscription = (await subscriptions.listByUser(userId)).find(
        (candidate) => candidate.endpoint === endpoint,
      );
      if (subscription === undefined) {
        throw new AppError('NOT_FOUND', 'この端末は、Web Push 通知を有効にしていません');
      }
      if (!subscription.isActive) {
        throw new AppError('CONFLICT', INVALIDATED_MESSAGE);
      }
      const now = clock.now();
      if (subscription.testSentAt !== undefined) {
        const nextAt =
          new Date(subscription.testSentAt).getTime() + PUSH_TEST_INTERVAL_SECONDS * 1000;
        const waitSeconds = Math.ceil((nextAt - now.getTime()) / 1000);
        if (waitSeconds > 0) {
          throw new AppError(
            'RATE_LIMITED',
            `テスト通知は、1 分に 1 回までです。あと ${String(waitSeconds)} 秒たってから、もう一度お試しください`,
          );
        }
      }
      // 送る前に、制限の記録を書く（送信の失敗も、1 分の制限に数える。配信サービスへ、続けて送らない）
      const reserved = { ...subscription, testSentAt: now.toISOString() };
      await subscriptions.save(reserved);
      let outcome: DeliveryOutcome;
      try {
        outcome = await withTimeout(
          () => webPush.deliverTest(reserved, { ttlSeconds: PUSH_TEST_INTERVAL_SECONDS }),
          ioTimeoutMs,
          'Web Push のテスト通知',
        );
      } catch (error) {
        if (error instanceof NotificationDeliveryError || error instanceof OperationTimeoutError) {
          // 配信サービスの内部の情報（宛先・状態コードなど）は、利用者に見せない
          throw new AppError(
            'SERVICE_UNAVAILABLE',
            'テスト通知を送れませんでした。しばらくしてから、もう一度お試しください',
          );
        }
        throw error;
      }
      if (outcome === 'SUBSCRIPTION_GONE') {
        await subscriptions.deactivate(subscription.subscriptionId);
        throw new AppError('CONFLICT', INVALIDATED_MESSAGE);
      }
    },
  };
}
