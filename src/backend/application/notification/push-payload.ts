/**
 * Web Push の本文（通知の見出し・本文・識別子）を組み立てる（Issue #241。形式は PushPayloadSchema・sw.js と同じ）。
 * 機密を含めない。メッセージは、送信の上限に収まるよう切り詰める。
 */

import type { Notification, PushPayload } from '@smart-farm/shared/schemas/notification';

/** 本文（メッセージ）の最大の文字数。日本語（UTF-8 で 3 バイト）でも、暗号化したあとの送信の上限（約 4 KB）に収まる。 */
export const PUSH_MESSAGE_MAX_LENGTH = 300;

/** 通知の種別ごとの見出し（画面の種別の表示名と同じ）。 */
const TITLES: Readonly<Record<Notification['kind'], string>> = {
  STATUS_CHANGE: '異常検知',
  INGESTION_FAILURE: 'データ取得失敗',
  FEDERATION_EXPIRED: '連携の期限切れ',
};

export function buildPushPayload(notification: Notification): PushPayload {
  const { message } = notification;
  return {
    title: TITLES[notification.kind],
    message:
      message.length > PUSH_MESSAGE_MAX_LENGTH
        ? `${message.slice(0, PUSH_MESSAGE_MAX_LENGTH - 1)}…`
        : message,
    notificationId: notification.notificationId,
  };
}
