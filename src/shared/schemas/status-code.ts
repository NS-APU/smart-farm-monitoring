/** ステータスコード定義のスキーマ。data-dictionary.md 7章、FR-3。 */

import { z } from 'zod';
import { IsoDateTimeSchema, JudgedStatusSchema } from './common.ts';

/** コード値の最大の長さ（文字数）。未登録のコード値の記録も、この長さで切る。 */
export const STATUS_CODE_VALUE_MAX_LENGTH = 100;

/** コード値（登録できる形式: 英大文字で始まり、英大文字・数字・アンダースコア。100 文字以内）。 */
export const StatusCodeValueSchema = z
  .string()
  .min(1, 'コード値は必須です')
  .max(STATUS_CODE_VALUE_MAX_LENGTH, 'コード値は100文字以内で指定してください')
  .regex(/^[A-Z][A-Z0-9_]*$/, 'コード値は英大文字・数字・アンダースコアで指定してください');

export const StatusCodeDefinitionSchema = z.object({
  code: StatusCodeValueSchema,
  name: z.string().trim().min(1, '名称は必須です').max(100, '名称は100文字以内で指定してください'),
  description: z.string().max(500, '説明は500文字以内で指定してください').optional(),
  /** カテゴリ: 正常（NORMAL）／注意（CAUTION）／異常（ERROR）。 */
  category: JudgedStatusSchema,
  isDeleted: z.boolean(),
});
export type StatusCodeDefinition = z.infer<typeof StatusCodeDefinitionSchema>;

export const StatusCodeListResponseSchema = z.object({
  items: z.array(StatusCodeDefinitionSchema),
});
export type StatusCodeListResponse = z.infer<typeof StatusCodeListResponseSchema>;

/** POST /status-codes の入力（FR-3.2）。 */
export const StatusCodeCreateRequestSchema = StatusCodeDefinitionSchema.omit({ isDeleted: true });
export type StatusCodeCreateRequest = z.infer<typeof StatusCodeCreateRequestSchema>;

/** PUT /status-codes/{code} の入力。コード値は変更できない。 */
export const StatusCodeUpdateRequestSchema = StatusCodeCreateRequestSchema.omit({ code: true });
export type StatusCodeUpdateRequest = z.infer<typeof StatusCodeUpdateRequestSchema>;

/**
 * GET /status-codes/unregistered の 1 件（SC-12-5。ADR-0017 の D-23）。取り込みで、定義にないコード値として、不正の品質で保存した値。
 * 登録済み（論理削除でない）のコード値は、含めない。
 */
export const UnregisteredStatusCodeSchema = z.object({
  /** 取り込んだコード値（100 文字で切った値）。登録できない形式のこともある。 */
  code: z.string().min(1),
  /** 取り込んだ観測値の件数（記録を始めてからの合計）。 */
  count: z.number().int().positive(),
  /** 最後に取り込んだ日時。 */
  lastSeenAt: IsoDateTimeSchema,
  /** 登録できる形式か（コード値の形式 `StatusCodeValueSchema` に合うか）。 */
  isRegistrable: z.boolean(),
  /** 登録ダイアログの、コード値の初期値の案（大文字化などの正規化）。変換できないときは、ない。 */
  suggestedCode: z.string().optional(),
});
export type UnregisteredStatusCode = z.infer<typeof UnregisteredStatusCodeSchema>;

export const UnregisteredStatusCodeListResponseSchema = z.object({
  items: z.array(UnregisteredStatusCodeSchema),
});
export type UnregisteredStatusCodeListResponse = z.infer<
  typeof UnregisteredStatusCodeListResponseSchema
>;
