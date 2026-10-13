/** API の共通スキーマ（エラー応答・ページ分割）。functional-specification.md 1.3。 */

import { z } from 'zod';
import { ERROR_CODES } from '../errors.ts';

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    fields: z.array(z.object({ name: z.string(), message: z.string() })).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** 一覧の既定の件数（functional-specification.md 1.2）。 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export const API_BASE_PATH = '/api/v1';
