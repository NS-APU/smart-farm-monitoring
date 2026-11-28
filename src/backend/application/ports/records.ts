/**
 * ポートの入出力に使う、バックエンド内部の記録の型（スキーマから導出）。
 * 永続化の読み込み時に検証できるよう、Zod のスキーマで定義する。
 */

import { z } from 'zod';
import {
  EvaluationStatusSchema,
  IsoDateTimeSchema,
  UserIdSchema,
  ViewpointIdSchema,
  EquipmentIdSchema,
} from '@smart-farm/shared/schemas/common';
import { PushKeysSchema } from '@smart-farm/shared/schemas/notification';

/** ユーザー（パスワードのハッシュを含む。API には出さない）。 */
export const UserRecordSchema = z.object({
  userId: UserIdSchema,
  userName: z.string().min(1).max(200),
  role: z.string().min(1),
  /**
   * パスワードのハッシュ（形式: scrypt$<salt>$<hash>）。平文は保持しない。
   * パスワードを Cognito が持つ構成（ADR-0008）では、持たない。
   */
  passwordHash: z.string().min(1).optional(),
  lastLoginAt: IsoDateTimeSchema.optional(),
  /**
   * 管理者が決めた（登録・再設定の）パスワードを、本人が、まだ変更していない（D-45）。登録時と、管理者が他の利用者の
   * パスワードを再設定したときに true。本人が変更すると false。記録にない（既存のユーザー・初期ユーザー）は、false と同じ。
   */
  mustChangePassword: z.boolean().optional(),
  createdAt: IsoDateTimeSchema,
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

/**
 * 閲覧の割り当て（ハウスごと。Issue #330。ADR-0013）。このハウス（配下のロボット・センサーを含む）を、閲覧できる一般ユーザー。
 * 設備の記録には持たない（設備の階層は、全員に返すため、ほかのユーザーの ID が漏れる）。管理者は、全ハウスを閲覧できる（記録の対象外）。
 */
export const FacilityAccessRecordSchema = z.object({
  facilityId: EquipmentIdSchema,
  userIds: z.array(UserIdSchema),
});
export type FacilityAccessRecord = z.infer<typeof FacilityAccessRecordSchema>;

/** 取り込み済みファイルの記録（再取り込みの防止。FR-1.6）。 */
export const IngestedFileRecordSchema = z.object({
  sourceId: z.string(),
  fileId: z.string(),
  contentHash: z.string(),
  fetchedAt: IsoDateTimeSchema,
  result: z.enum(['SUCCESS', 'FAILURE']),
  recordCount: z.number().int().nonnegative(),
  errorMessage: z.string().optional(),
});
export type IngestedFileRecord = z.infer<typeof IngestedFileRecordSchema>;

/**
 * 設備ごとの、取り込みの最終の実行（Issue #197・#201。ADR-0016 の D-11・D-48）。設備ごとに 1 件（上書き）。
 * 取り込みのジョブが、「最終の開始から、その設備の取得間隔が過ぎたか」を判定する。空振りは、ログに残さないため、
 * 実行したこと（生存の確認）は、ここで分かる。
 */
export const EquipmentIngestionStateSchema = z.object({
  equipmentId: EquipmentIdSchema,
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema,
  result: z.enum(['SUCCESS', 'PARTIAL', 'FAILURE']),
  /** 最後に成功（SUCCESS）した実行の終了日時。 */
  succeededAt: IsoDateTimeSchema.optional(),
  /** 最後に新しいデータ（1 件以上の記録）を取り込んだ実行の終了日時。 */
  dataAt: IsoDateTimeSchema.optional(),
});
export type EquipmentIngestionState = z.infer<typeof EquipmentIngestionStateSchema>;

/** 取り込み元ごとの、取り込みの最終の開始日時（設備が 1 つもない取り込み元の、取得間隔の判定。Issue #201）。 */
export const SourceIngestionStateSchema = z.object({
  sourceId: z.string(),
  startedAt: IsoDateTimeSchema,
});
export type SourceIngestionState = z.infer<typeof SourceIngestionStateSchema>;

/**
 * 設備の削除の要求（D-28。Issue #229）。設備を削除すると、設備のデータを、ジョブ（JB-05）が削除する。削除が終わるまで、設備の記録は
 * 削除済み（isDeleted）で残り、この記録が、進行の状態（画面の「削除中」・失敗の表示・やり直し）を持つ。
 * 設備ごとではなく、削除の操作ごとに 1 件（ハウスは、配下のロボット・センサーを含む）。
 */
export const EquipmentDeletionTargetSchema = z.object({
  equipmentId: EquipmentIdSchema,
  name: z.string(),
  equipmentType: z.string(),
  /** 設備のファイルのパス（取り込み済みファイルの記録を、削除するために持つ）。 */
  sourceFilePath: z.string().optional(),
  /** 削除する設備が、ハウスに属するときの、ハウス。 */
  facilityId: EquipmentIdSchema.optional(),
});
export type EquipmentDeletionTarget = z.infer<typeof EquipmentDeletionTargetSchema>;

export const EquipmentDeletionSchema = z.object({
  /** 削除を指示した設備（ハウスなら、ハウス）。記録のキー。 */
  equipmentId: EquipmentIdSchema,
  /** 削除する設備（指示した設備と、ハウスなら配下）。 */
  targets: z.array(EquipmentDeletionTargetSchema).min(1),
  requestedBy: UserIdSchema,
  requestedAt: IsoDateTimeSchema,
  /**
   * データの削除中（PURGING）か、削除が終わり、実行中の取り込み・評価の書き込みを掃除するために待っている状態（SWEEPING。
   * `sweepAfter` を過ぎたら、もう一度削除して、設備の記録を消す）。
   */
  phase: z.enum(['PURGING', 'SWEEPING']),
  sweepAfter: IsoDateTimeSchema.optional(),
  /** 実行した回数と、直近の失敗（エラーの種類の名前だけ。値・メッセージは持たない）。 */
  attempts: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  lastAttemptAt: IsoDateTimeSchema.optional(),
  /** ここまでに削除した件数（変更履歴に残す）。 */
  deleted: z.object({
    observations: z.number().int().nonnegative(),
    manualEntries: z.number().int().nonnegative(),
    unsentFederationItems: z.number().int().nonnegative(),
  }),
});
export type EquipmentDeletion = z.infer<typeof EquipmentDeletionSchema>;

/** 観点の最終ステータスの変化の記録（通知の判定と、ステータスの推移。FR-6.10）。 */
export const StatusChangeEntrySchema = z.object({
  equipmentId: EquipmentIdSchema,
  viewpointId: ViewpointIdSchema,
  status: EvaluationStatusSchema,
  changedAt: IsoDateTimeSchema,
});
export type StatusChangeEntry = z.infer<typeof StatusChangeEntrySchema>;

/** Web Push の購読（利用者・端末ごと。単位は暫定。dev_spec.md 4章）。 */
export const PushSubscriptionRecordSchema = z.object({
  subscriptionId: z.string(),
  userId: UserIdSchema,
  endpoint: z.string().min(1),
  /** 本文つきの配信に使う暗号鍵（#241）。鍵の保存より前に登録した購読は、持たない（本文なしで送る）。 */
  keys: PushKeysSchema.optional(),
  isActive: z.boolean(),
  createdAt: IsoDateTimeSchema,
  /** 直近のテスト通知を送った日時（1 分に 1 回までの制限に使う。#159 SC-15-2）。送ったことがなければ、持たない。 */
  testSentAt: IsoDateTimeSchema.optional(),
});
export type PushSubscriptionRecord = z.infer<typeof PushSubscriptionRecordSchema>;

/**
 * 未登録のコード値（SC-12-5。ADR-0017 の D-23。Issue #158）。取り込みで、定義にないステータスコードとして、不正の品質で保存した値の、
 * コード値ごとの集計。コード値ごとに 1 件。登録済みかどうかは持たない（読むときに、ステータスコードの定義と照らす）。
 */
export const UnregisteredStatusCodeRecordSchema = z.object({
  /** 取り込んだコード値（100 文字で切った値）。 */
  code: z.string().min(1),
  /** 取り込んだ観測値の件数（記録を始めてからの合計）。 */
  count: z.number().int().positive(),
  /** 最後に取り込んだ日時。 */
  lastSeenAt: IsoDateTimeSchema,
});
export type UnregisteredStatusCodeRecord = z.infer<typeof UnregisteredStatusCodeRecordSchema>;
