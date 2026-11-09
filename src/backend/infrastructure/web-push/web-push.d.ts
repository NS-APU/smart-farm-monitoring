/**
 * `web-push`（3.6.7）の型の宣言（配布物に型定義がないため、使う範囲だけを宣言する。Issue #241）。
 * 使うのは、`sendNotification` と、HTTP のエラー（`WebPushError`）だけ。
 */

declare module 'web-push' {
  export interface PushSubscription {
    readonly endpoint: string;
    readonly keys?: { readonly p256dh: string; readonly auth: string };
  }

  export interface RequestOptions {
    readonly TTL?: number;
    readonly urgency?: 'very-low' | 'low' | 'normal' | 'high';
    /** 送信の待ち時間の上限（ミリ秒）。 */
    readonly timeout?: number;
    readonly vapidDetails?: {
      readonly subject: string;
      readonly publicKey: string;
      readonly privateKey: string;
    };
  }

  export interface SendResult {
    readonly statusCode: number;
  }

  /** プッシュサービスが、2xx 以外を返したときのエラー。 */
  export class WebPushError extends Error {
    readonly statusCode: number;
  }

  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | null,
    options?: RequestOptions,
  ): Promise<SendResult>;

  /** 送信せずに、リクエスト（ヘッダー・暗号化した本文）を組み立てる（テストで、鍵の形式・オプションを確かめるために使う）。 */
  export function generateRequestDetails(
    subscription: PushSubscription,
    payload?: string | null,
    options?: RequestOptions,
  ): {
    readonly method: string;
    readonly headers: Readonly<Record<string, string | number>>;
    readonly body: Uint8Array | null;
    readonly endpoint: string;
  };

  export function generateVAPIDKeys(): { readonly publicKey: string; readonly privateKey: string };

  const webPush: {
    sendNotification: typeof sendNotification;
    generateRequestDetails: typeof generateRequestDetails;
    generateVAPIDKeys: typeof generateVAPIDKeys;
    WebPushError: typeof WebPushError;
  };
  export default webPush;
}
