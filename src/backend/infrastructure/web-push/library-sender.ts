/**
 * Web Push の送信（`web-push` ライブラリ 3.6.7 の呼び出し。Issue #241）。
 * 本文の暗号化（RFC 8291）と VAPID の署名は、ライブラリが行う。ライブラリは、MPL-2.0 で、改変せずに使う
 * （`.license-check/license-report.md`・dev_spec.md の記録）。ここは、送信の関数（WebPushSender）の形に合わせる薄い層。
 * プッシュサービスが 2xx 以外を返したときは、例外ではなく、状態コードを返す（結果の扱いは、web-push-notifier.ts）。
 */

import webPush from 'web-push';
import type { WebPushSender } from './web-push-notifier.ts';

/** プッシュサービスへの送信の待ち時間の上限（ミリ秒）。通知サービスの配信全体の上限（タイムアウト）より、短くする。 */
export const WEB_PUSH_REQUEST_TIMEOUT_MS = 8000;

/** 使うライブラリの範囲（テストでは、偽物を渡す）。 */
export interface WebPushLibrary {
  readonly sendNotification: typeof webPush.sendNotification;
  readonly WebPushError: new (...args: never[]) => Error & { readonly statusCode: number };
}

export function createLibrarySender(library: WebPushLibrary = webPush): WebPushSender {
  return async (request) => {
    try {
      const result = await library.sendNotification(
        {
          endpoint: request.endpoint,
          ...(request.keys === undefined ? {} : { keys: request.keys }),
        },
        request.payload,
        {
          TTL: request.ttlSeconds,
          urgency: request.urgency,
          timeout: WEB_PUSH_REQUEST_TIMEOUT_MS,
          vapidDetails: request.vapid,
        },
      );
      return { statusCode: result.statusCode };
    } catch (error) {
      if (error instanceof library.WebPushError) {
        return { statusCode: error.statusCode };
      }
      throw error;
    }
  };
}
