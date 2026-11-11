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
 * 設備ごとの、取り込みの最終の開始日時（取得間隔の判定。Issue #197。ADR-0016 の D-11）。設備ごとに 1 件（上書き）。
 * 取り込みのジョブが、設備ごとに、「最終の開始から、その設備の取得間隔が過ぎたか」を判定する。
 */
export const EquipmentIngestionStateSchema = z.object({
  equipmentId: EquipmentIdSchema,
  startedAt: IsoDateTimeSchema,
});
export type EquipmentIngestionState = z.infer<typeof EquipmentIngestionStateSchema>;

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
});
export type PushSubscriptionRecord = z.infer<typeof PushSubscriptionRecordSchema>;
