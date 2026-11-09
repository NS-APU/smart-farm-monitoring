/**
 * 通知の配信手段のポート（NotifierPort。architecture.md 8章）。
 * 画面内の通知は、通知の保存そのもの（必ず行う）。追加の配信手段（Web Push、将来のメール等）を
 * このポートの実装として追加する。通知サービスの停止は、評価・取り込み・画面内通知に影響させない。
 */

import type { Notification } from '@smart-farm/shared/schemas/notification';
import type { PushSubscriptionRecord } from './records.ts';
import { namedErrorClass } from '../named-error.ts';

/** 一時的な配信の失敗（再送の対象）。メッセージに秘密情報・内部情報を含めない。 */
export class NotificationDeliveryError extends namedErrorClass('NotificationDeliveryError') {}

export type DeliveryOutcome = 'DELIVERED' | 'SUBSCRIPTION_GONE';

/** 配信の指定。 */
export interface DeliveryOptions {
  /**
   * Web Push の有効期限（秒）。配信の期限（通知を作ってから 1 時間。ADR-0019 の D-38）までの残りの時間。
   * この時間を過ぎると、配信サービスは、端末へ届けずに、破棄する。
   */
  readonly ttlSeconds: number;
}

export interface NotifierPort {
  /**
   * 1つの購読へ配信する。購読が無効（解除・期限切れ）の場合は SUBSCRIPTION_GONE を返す
   * （呼び出し側が購読を無効にする）。一時的な失敗は NotificationDeliveryError を投げる。
   */
  deliver(
    notification: Notification,
    subscription: PushSubscriptionRecord,
    options: DeliveryOptions,
  ): Promise<DeliveryOutcome>;
}
