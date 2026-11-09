/** Web Push の本文（通知の見出し・本文・識別子。Issue #241）の単体テスト。形式は、共有のスキーマ（PushPayloadSchema）に合わせる。 */

import { describe, expect, it } from 'vitest';
import { PushPayloadSchema, type Notification } from '@smart-farm/shared/schemas/notification';
import {
  buildPushPayload,
  PUSH_MESSAGE_MAX_LENGTH,
} from '../../../../src/backend/application/notification/push-payload.ts';

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    notificationId: 'n-1' as Notification['notificationId'],
    kind: 'STATUS_CHANGE',
    message: '【異常】安全性（ハウス1）: 転倒を検知しました',
    createdAt: '2026-11-09T01:00:00.000Z',
    dedupKey: 'key-1',
    deliveries: [],
    ...overrides,
  };
}

describe('buildPushPayload', () => {
  it('種別の表示名を見出しに、メッセージを本文に、通知の識別子を付ける。共有のスキーマ（PushPayloadSchema）に適合する', () => {
    const payload = buildPushPayload(notification());

    expect(payload).toEqual({
      title: '異常検知',
      message: '【異常】安全性（ハウス1）: 転倒を検知しました',
      notificationId: 'n-1',
    });
    expect(PushPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('上限（300 文字）ちょうどは、そのまま。超えると、末尾を「…」にして、上限に収める', () => {
    const exact = buildPushPayload(notification({ message: 'あ'.repeat(PUSH_MESSAGE_MAX_LENGTH) }));
    const over = buildPushPayload(
      notification({ message: 'あ'.repeat(PUSH_MESSAGE_MAX_LENGTH + 1) }),
    );

    expect(exact.message).toBe('あ'.repeat(PUSH_MESSAGE_MAX_LENGTH));
    expect(over.message).toBe(`${'あ'.repeat(PUSH_MESSAGE_MAX_LENGTH - 1)}…`);
    expect(over.message).toHaveLength(PUSH_MESSAGE_MAX_LENGTH);
  });
});
