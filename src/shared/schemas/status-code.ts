/** ステータスコード定義のスキーマ。data-dictionary.md 7章、FR-3。 */

import { z } from 'zod';
import { JudgedStatusSchema } from './common.ts';

export const StatusCodeDefinitionSchema = z.object({
  code: z
    .string()
    .min(1, 'コード値は必須です')
    .max(100, 'コード値は100文字以内で指定してください')
    .regex(/^[A-Z][A-Z0-9_]*$/, 'コード値は英大文字・数字・アンダースコアで指定してください'),
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
