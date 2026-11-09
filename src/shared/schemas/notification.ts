/** 通知のスキーマ。data-dictionary.md 9.1、FR-7。 */

import { z } from 'zod';
import { MAX_NOTE_LENGTH } from '../constants/limits.ts';
import {
  EquipmentIdSchema,
  EvaluationStatusSchema,
  IsoDateTimeSchema,
  NotificationIdSchema,
  NotificationKindSchema,
  ReadStateSchema,
  UserIdSchema,
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

/**
 * Web Push の、購読ごとの配信の状態（Issue #237。ADR-0019 の D-38）。
 * PENDING（未試行）・FAILURE（失敗。次の試行の日時に再送）・SUCCESS・ABANDONED（断念: 通知を作ってから 1 時間を過ぎた、または、購読が無効になった）。
 */
export const WEB_PUSH_DELIVERY_RESULTS = ['PENDING', 'SUCCESS', 'FAILURE', 'ABANDONED'] as const;

export const WebPushDeliverySchema = z.object({
  subscriptionId: z.string(),
  result: z.enum(WEB_PUSH_DELIVERY_RESULTS),
  attempts: z.number().int().nonnegative(),
  /** 次の試行の日時（失敗のあと、再送する日時）。 */
  nextAttemptAt: IsoDateTimeSchema.optional(),
  updatedAt: IsoDateTimeSchema,
  /** 失敗の内容。秘密情報・内部情報を含めない。 */
  errorMessage: z.string().optional(),
});
export type WebPushDelivery = z.infer<typeof WebPushDeliverySchema>;

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
  /**
   * Web Push の、購読ごとの配信の状態。最初の配信の実行時点の、有効な購読ごとに持つ。
   * ない通知は、まだ配信の対象を決めていない（または、以前の形式）。`deliveries` の WEB_PUSH は、そのまとめの状態。
   */
  webPushDeliveries: z.array(WebPushDeliverySchema).optional(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/**
 * 通知の経過・回復日時（状態変化の通知だけ。ADR-0019 の D-42）。状態の変化の履歴から導出する（新しい保存はない）。
 * - `changes`（経過）: 通知の時点から、同じ観点・設備の次の通知（なければ現在）までの、状態の変化（古い順）。
 *   「不明」は含めず、同じ状態が続くものは 1 件にまとめる。次の通知の時点の状態も含む
 * - `recovery`（回復日時）: 経過の中で、最初に「正常」に戻った日時と、通知の時点からの経過時間（秒）。正常がなければ null（未回復）
 */
export const NotificationProgressSchema = z.object({
  changes: z.array(z.object({ status: EvaluationStatusSchema, changedAt: IsoDateTimeSchema })),
  recovery: z
    .object({ recoveredAt: IsoDateTimeSchema, elapsedSeconds: z.number().int().nonnegative() })
    .nullable(),
});
export type NotificationProgress = z.infer<typeof NotificationProgressSchema>;

/**
 * 通知のメモ（利用者が入力する自由記述。ADR-0019 の D-42。#239）。共有（全員が読める）・追記のみ（編集・削除はない）。
 * 入力者（ユーザー ID）と日時を持つ。農業情報基盤には送らない。
 */
export const NotificationMemoSchema = z.object({
  memoId: z.string().min(1),
  notificationId: NotificationIdSchema,
  enteredBy: UserIdSchema,
  body: z.string().min(1).max(MAX_NOTE_LENGTH),
  createdAt: IsoDateTimeSchema,
});
export type NotificationMemo = z.infer<typeof NotificationMemoSchema>;

/** POST /notifications/:id/memos の入力。前後の空白を除き、1〜2000 文字（手動入力のメモと同じ上限）。 */
export const NotificationMemoInputSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'メモを入力してください')
    .max(MAX_NOTE_LENGTH, `メモは${String(MAX_NOTE_LENGTH)}文字以内で入力してください`),
});
export type NotificationMemoInput = z.infer<typeof NotificationMemoInputSchema>;

/** GET /notifications/:id/memos の応答（入力の古い順。全件）。 */
export const NotificationMemoListResponseSchema = z.object({
  items: z.array(NotificationMemoSchema),
});
export type NotificationMemoListResponse = z.infer<typeof NotificationMemoListResponseSchema>;

/**
 * API の応答の1件。既読状態は、ログイン中の利用者ごと（暫定。dev_spec.md 4章）。
 * `progress` は、状態変化の通知だけ。経過を示せない（設備を削除した、など）ときは null（「不明」）。
 */
export const NotificationItemSchema = NotificationSchema.omit({
  dedupKey: true,
  deliveries: true,
  webPushDeliveries: true,
}).extend({
  readState: ReadStateSchema,
  /** 通知に付いたメモの件数（#239）。 */
  memoCount: z.number().int().nonnegative(),
  progress: NotificationProgressSchema.nullable().optional(),
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
