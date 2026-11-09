/**
 * Web Push の配信の規則（Issue #237。ADR-0019 の D-38。純粋関数）。
 * - 配信の状態は、購読ごとに持つ。失敗した購読にだけ、再送する（二重配信をなくす）
 * - 再送の間隔は、1 分から倍々にして、最大 60 分。通知を作ってから 60 分を過ぎたら、断念する
 * - Web Push の有効期限（TTL）は、その期限（通知を作ってから 60 分）までの残りの時間にそろえる
 */

import type {
  Delivery,
  Notification,
  WebPushDelivery,
} from '@smart-farm/shared/schemas/notification';
import { MS_PER_MINUTE } from '@smart-farm/shared/time';

/** 再送の最初の間隔（分）。 */
export const DEFAULT_RETRY_BASE_MINUTES = 1;
/** 再送の間隔の上限（分）。 */
export const DEFAULT_RETRY_MAX_MINUTES = 60;
/** 配信を断念する期限（通知を作ってからの分）。Web Push の有効期限も、この期限にそろえる。 */
export const DEFAULT_DELIVERY_EXPIRY_MINUTES = 60;

/** 失敗した回数（attempts）のあと、次の試行までの間隔（分）。最初の間隔から倍々にして、上限まで。 */
export function webPushRetryDelayMinutes(
  attempts: number,
  baseMinutes: number,
  maxMinutes: number,
): number {
  return Math.min(maxMinutes, baseMinutes * 2 ** Math.max(0, attempts - 1));
}

/** 通知を作ってから、期限（分）を過ぎたか（ちょうどの時点から、期限切れ）。 */
export function isWebPushExpired(createdAt: string, now: Date, expiryMinutes: number): boolean {
  return now.getTime() - Date.parse(createdAt) >= expiryMinutes * MS_PER_MINUTE;
}

/** Web Push の有効期限（秒）。期限までの残りの時間（端数は切り捨て）。期限を過ぎていても、1 秒以上にする。 */
export function webPushTtlSeconds(createdAt: string, now: Date, expiryMinutes: number): number {
  const remainingMs = Date.parse(createdAt) + expiryMinutes * MS_PER_MINUTE - now.getTime();
  return Math.max(1, Math.floor(remainingMs / 1000));
}

export interface WebPushSummary {
  readonly result: 'PENDING' | 'SUCCESS' | 'FAILURE';
  /** 購読ごとの試行回数の合計。 */
  readonly attempts: number;
  /** 直近の失敗の内容。 */
  readonly errorMessage?: string;
}

/**
 * 購読ごとの配信の状態から、通知の Web Push の、まとめの状態を求める。
 * 未完了（未試行・再送待ち）があれば PENDING。なければ、断念があれば FAILURE（終了）、すべて成功か、配信する相手がなければ SUCCESS。
 */
export function summarizeWebPushDeliveries(deliveries: readonly WebPushDelivery[]): WebPushSummary {
  const attempts = deliveries.reduce((total, item) => total + item.attempts, 0);
  const failed = deliveries.filter((item) => item.errorMessage !== undefined);
  const latestError = failed
    .toSorted((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1)?.errorMessage;
  const withError = latestError === undefined ? {} : { errorMessage: latestError };
  if (deliveries.some((item) => item.result === 'PENDING' || item.result === 'FAILURE')) {
    return { result: 'PENDING', attempts, ...withError };
  }
  if (deliveries.some((item) => item.result === 'ABANDONED')) {
    return { result: 'FAILURE', attempts, ...withError };
  }
  return { result: 'SUCCESS', attempts };
}

/**
 * Web Push の配信が必要な通知か（配信が未完了の通知を引く索引・一覧の条件）。
 * まとめの状態が PENDING の通知。購読ごとの状態を持たない、以前の形式の失敗（FAILURE）も、購読ごとの形式で終了させるため、対象にする。
 */
export function needsWebPushDelivery(
  notification: Pick<Notification, 'deliveries' | 'webPushDeliveries'>,
): boolean {
  const webPush: Delivery | undefined = notification.deliveries.find(
    (delivery) => delivery.channel === 'WEB_PUSH',
  );
  if (webPush === undefined) {
    return false;
  }
  return (
    webPush.result === 'PENDING' ||
    (webPush.result === 'FAILURE' && notification.webPushDeliveries === undefined)
  );
}
