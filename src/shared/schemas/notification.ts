/** 通知のスキーマ。data-dictionary.md 9.1、FR-7。 */

import { z } from 'zod';
import {
  EquipmentIdSchema,
  EvaluationStatusSchema,
  IsoDateTimeSchema,
  NotificationIdSchema,
  NotificationKindSchema,
  ReadStateSchema,
  ViewpointIdSchema,
} from './common.ts';

export const DELIVERY_CHANNELS = ['IN_APP', 'WEB_PUSH'] as const;
export const DELIVERY_RESULTS = ['PENDING', 'SUCCESS', 'FAILURE'] as const;

export const DeliverySchema = z.object({
  channel: z.enum(DELIVERY_CHANNELS),
  result: z.enum(DELIVERY_RESULTS),
  attempts: z.number().int().nonnegative(),
  updatedAt: IsoDateTimeSchema,
  /** 失敗の内容。秘密情報・内部情報を含めない。 */
  errorMessage: z.string().optional(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const NotificationSchema = z.object({
  notificationId: NotificationIdSchema,
  kind: NotificationKindSchema,
  viewpointId: ViewpointIdSchema.optional(),
  /** 対象の設備。取り込み失敗の通知では、取り込み元（sourceId）を示すため省略できる。 */
  equipmentId: EquipmentIdSchema.optional(),
  sourceId: z.string().optional(),
  /** 異常検知の場合のステータス（注意・異常）。 */
  status: EvaluationStatusSchema.optional(),
  message: z.string(),
  createdAt: IsoDateTimeSchema,
  /** 重複抑制のキー（観点・対象・ステータス。FR-7.3）。 */
  dedupKey: z.string(),
  deliveries: z.array(DeliverySchema),
});
export type Notification = z.infer<typeof NotificationSchema>;

/** API の応答の1件。既読状態は、ログイン中の利用者ごと（暫定。dev_spec.md 4章）。 */
export const NotificationItemSchema = NotificationSchema.omit({
  dedupKey: true,
  deliveries: true,
}).extend({
  readState: ReadStateSchema,
});
export type NotificationItem = z.infer<typeof NotificationItemSchema>;

export const NotificationListResponseSchema = z.object({
  items: z.array(NotificationItemSchema),
  nextCursor: z.string().nullable(),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

export const UnreadCountResponseSchema = z.object({ unreadCount: z.number().int().nonnegative() });
export type UnreadCountResponse = z.infer<typeof UnreadCountResponseSchema>;

/** PUT /push-subscription の入力（端末ごとの購読。FR-7.2）。 */
/** Web Push の購読の宛先。https のみ（サーバーが宛先へ送信する実装では、内部のアドレスへの接続の経路になるため、制限する。V-016）。 */
export const PushEndpointSchema = z
  .url({
    protocol: /^https$/,
    // 内部の名前・IP アドレスの直接指定は不可（プッシュサービスは、ドメイン名で提供される）
    hostname: /^(?!localhost$)(?!\d+(?:\.\d+){3}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i,
    message: '購読の宛先（endpoint）が正しくありません',
  })
  .max(2000);

export const PushSubscriptionRequestSchema = z.object({
  endpoint: PushEndpointSchema,
});
export type PushSubscriptionRequest = z.infer<typeof PushSubscriptionRequestSchema>;

/** GET /push-subscription の応答。 */
export const PushStatusResponseSchema = z.object({
  /** サーバーが Web Push の配信を使える（公開鍵の設定がある）か。 */
  isAvailable: z.boolean(),
  /** 購読の登録に使う公開鍵（VAPID）。未設定は null。 */
  publicKey: z.string().nullable(),
  /** ログイン中の利用者が、有効な購読を持つか。 */
  isSubscribed: z.boolean(),
});
export type PushStatusResponse = z.infer<typeof PushStatusResponseSchema>;

/**
 * Web Push の本文（サーバーが送り、サービスワーカー（frontend/public/sw.js）が読む）の契約。
 * 機密を含めず、通知の見出し・本文・識別子のみ。キーを変えるときは、サーバーの送信と sw.js の双方を更新する（V-127）。
 */
export const PushPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(1000),
  notificationId: z.string().min(1).max(100),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;
