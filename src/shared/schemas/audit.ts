/** 変更履歴・操作履歴のスキーマ。FR-4.2.3、NFR-5.7、data-dictionary.md 9.3。 */

import { z } from 'zod';
import { IsoDateTimeSchema, UserIdSchema } from './common.ts';

export const AUDIT_OPERATIONS = ['CREATE', 'UPDATE', 'DELETE'] as const;
export type AuditOperation = (typeof AUDIT_OPERATIONS)[number];

/** 変更履歴を記録する対象の種類。 */
export const AUDIT_TARGET_TYPES = [
  'manual-entry',
  'criteria',
  'equipment',
  'status-code',
  'user',
  'facility-access',
  'ingestion-settings',
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export const AuditLogEntrySchema = z.object({
  auditId: z.string(),
  occurredAt: IsoDateTimeSchema,
  operation: z.enum(AUDIT_OPERATIONS),
  /**
   * 対象の種類（AUDIT_TARGET_TYPES）。応答の読み取りでは、将来の新しい種類にも対応できるよう、文字列で受ける
   * （画面は、未知の種類も表示する）。入力（クエリ）は、定義にある値だけを受け付ける（V-117）。
   */
  targetType: z.string(),
  targetId: z.string(),
  actor: UserIdSchema,
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

/**
 * 変更履歴の一覧の 1 件（API の応答）。変更者の表示名（`actorName`）を、読み取り時に、現在のユーザー名から付ける
 * （保存しない。削除済みの利用者は、項目を出さない。画面は、「ユーザー名（ID）」で表示する。Issue #154 の SC-07-7）。
 */
export const AuditLogListItemSchema = AuditLogEntrySchema.extend({
  actorName: z.string().optional(),
});
export type AuditLogListItem = z.infer<typeof AuditLogListItemSchema>;

export const AuditLogListResponseSchema = z.object({
  items: z.array(AuditLogListItemSchema),
  nextCursor: z.string().nullable(),
});
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;
