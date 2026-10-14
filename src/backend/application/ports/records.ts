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

/** ユーザー（パスワードのハッシュを含む。API には出さない）。 */
export const UserRecordSchema = z.object({
  userId: UserIdSchema,
  userName: z.string().min(1).max(200),
  role: z.string().min(1),
  /** パスワードのハッシュ（形式: scrypt$<salt>$<hash>）。平文は保持しない。 */
  passwordHash: z.string().min(1),
  lastLoginAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

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
  isActive: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type PushSubscriptionRecord = z.infer<typeof PushSubscriptionRecordSchema>;
