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

export interface NotifierPort {
  /**
   * 1つの購読へ配信する。購読が無効（解除・期限切れ）の場合は SUBSCRIPTION_GONE を返す
   * （呼び出し側が購読を無効にする）。一時的な失敗は NotificationDeliveryError を投げる。
   */
  deliver(
    notification: Notification,
    subscription: PushSubscriptionRecord,
  ): Promise<DeliveryOutcome>;
}
