/**
 * Web Push の実配信（NotifierPort の実装。Issue #241。ADR-0019 の D-36・D-38）。
 * 購読（端末）ごとに、プッシュサービスへ送る。VAPID の秘密鍵は、秘密情報のポート（SecretPort）から、配信のたびに読む
 * （保管先が、短時間キャッシュする）。値を、ログ・エラーのメッセージに出さない。
 * 送信そのもの（ライブラリの呼び出し）は、`send` として受け取る（本番: library-sender.ts。テスト: 偽物）。
 *
 * 結果の扱い:
 * - 2xx: 配信できた。
 * - 404・410: 購読が無効（解除・期限切れ）。呼び出し側が、購読を無効にする。
 * - ほか（429・5xx・400 台の設定の問題・接続できない）: 一時的な失敗として、NotificationDeliveryError を投げる（再送の対象。D-38）。
 */

import { buildPushPayload } from '../../application/notification/push-payload.ts';
import { NULL_LOGGER, type Logger } from '../../application/ports/logger-port.ts';
import {
  NotificationDeliveryError,
  type DeliveryOutcome,
  type NotifierPort,
} from '../../application/ports/notifier-port.ts';
import type { SecretPort } from '../../application/ports/secret-port.ts';

/** VAPID の秘密鍵の、秘密情報の参照名（パラメータストアの `<接頭辞>web-push/vapid-private-key`）。 */
export const VAPID_PRIVATE_KEY_REFERENCE = 'web-push/vapid-private-key';

/** プッシュサービスへの 1 回の送信。 */
export interface WebPushRequest {
  readonly endpoint: string;
  /** 購読の暗号鍵。なければ（鍵の保存より前の購読）、本文なし。 */
  readonly keys?: { readonly p256dh: string; readonly auth: string } | undefined;
  /** 本文（JSON の文字列）。なければ null（端末は、既定の文言で表示する）。 */
  readonly payload: string | null;
  /** 有効期限（秒）。過ぎると、プッシュサービスは、端末へ届けずに破棄する。 */
  readonly ttlSeconds: number;
  readonly urgency: 'high';
  readonly vapid: {
    readonly subject: string;
    readonly publicKey: string;
    readonly privateKey: string;
  };
}

/** 送信の関数。プッシュサービスが返した HTTP の状態コードを返す（2xx 以外も、返す）。接続できない場合などは、例外を投げる。 */
export type WebPushSender = (request: WebPushRequest) => Promise<{ readonly statusCode: number }>;

export interface WebPushNotifierDeps {
  readonly secrets: SecretPort;
  /** VAPID の公開鍵（設定 WEB_PUSH_PUBLIC_KEY。購読に使う鍵と同じ）。 */
  readonly publicKey: string;
  /** VAPID の連絡先（アプリの https の URL。設定 WEB_PUSH_SUBJECT）。 */
  readonly subject: string;
  readonly send: WebPushSender;
  readonly logger?: Logger;
}

/** 設定（鍵・連絡先）の問題で、プッシュサービスが拒否したときの状態コード。メッセージで、設定の確認を促す。 */
const CONFIGURATION_STATUS_CODES: ReadonlySet<number> = new Set([400, 401, 403]);

function outcomeOf(statusCode: number): DeliveryOutcome {
  if (statusCode >= 200 && statusCode < 300) {
    return 'DELIVERED';
  }
  if (statusCode === 404 || statusCode === 410) {
    return 'SUBSCRIPTION_GONE';
  }
  throw new NotificationDeliveryError(
    CONFIGURATION_STATUS_CODES.has(statusCode)
      ? `Web Push の配信サービスが、送信を拒否しました（HTTP ${String(statusCode)}）。VAPID の鍵・連絡先の設定を確認してください`
      : `Web Push の配信サービスがエラー（HTTP ${String(statusCode)}）を返しました`,
  );
}

export function createWebPushNotifier(deps: WebPushNotifierDeps): NotifierPort {
  const { secrets, publicKey, subject, send } = deps;
  const logger = deps.logger ?? NULL_LOGGER;

  async function readPrivateKey(): Promise<string> {
    let privateKey: string | undefined;
    try {
      privateKey = await secrets.get(VAPID_PRIVATE_KEY_REFERENCE);
    } catch {
      // 読み取りの例外の内容（権限・パラメータの名前など）は、メッセージに含めない
      throw new NotificationDeliveryError('Web Push の秘密鍵を読み取れません');
    }
    if (privateKey === undefined) {
      throw new NotificationDeliveryError(
        `Web Push の秘密鍵が設定されていません（秘密情報の ${VAPID_PRIVATE_KEY_REFERENCE}）`,
      );
    }
    return privateKey;
  }

  return {
    async deliver(notification, subscription, options) {
      const privateKey = await readPrivateKey();
      const request: WebPushRequest = {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        payload:
          subscription.keys === undefined ? null : JSON.stringify(buildPushPayload(notification)),
        ttlSeconds: Math.max(0, options.ttlSeconds),
        urgency: 'high',
        vapid: { subject, publicKey, privateKey },
      };
      let statusCode: number;
      try {
        ({ statusCode } = await send(request));
      } catch (error) {
        // 例外の内容（宛先・内部の情報を含みうる）は、メッセージに含めない。種類だけを記録する
        logger.warn('Web Push の送信で例外が起きました', {
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        throw new NotificationDeliveryError('Web Push の配信サービスに接続できません');
      }
      return outcomeOf(statusCode);
    },
  };
}
