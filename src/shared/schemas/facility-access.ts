/** 閲覧の割り当て（ハウスごと）のスキーマ（Issue #330。ADR-0013。FR-9.8）。 */

import { z } from 'zod';
import { EquipmentIdSchema, UserIdSchema } from './common.ts';

/** 表の 1 行: ハウスと、そのハウスを閲覧できる一般ユーザー。 */
export const FacilityAccessEntrySchema = z.object({
  facilityId: EquipmentIdSchema,
  name: z.string(),
  userIds: z.array(UserIdSchema),
});
export type FacilityAccessEntry = z.infer<typeof FacilityAccessEntrySchema>;

/** 表の列: 割り当ての対象になる利用者（全設備を閲覧できる権限をもたない利用者。既定では、一般ユーザー）。 */
export const FacilityAccessUserSchema = z.object({
  userId: UserIdSchema,
  userName: z.string(),
});
export type FacilityAccessUser = z.infer<typeof FacilityAccessUserSchema>;

/** GET /facility-access: 行がハウス、列が一般ユーザーの表。 */
export const FacilityAccessResponseSchema = z.object({
  facilities: z.array(FacilityAccessEntrySchema),
  users: z.array(FacilityAccessUserSchema),
});
export type FacilityAccessResponse = z.infer<typeof FacilityAccessResponseSchema>;

/** PUT /facility-access/{facilityId}: そのハウスを閲覧できるユーザーの置き換え。 */
export const FacilityAccessUpdateRequestSchema = z.object({
  userIds: z.array(UserIdSchema).max(1000, 'ユーザーが多すぎます'),
});
export type FacilityAccessUpdateRequest = z.infer<typeof FacilityAccessUpdateRequestSchema>;
