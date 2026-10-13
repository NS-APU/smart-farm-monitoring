/** 観測値（共通形式 Observation）のスキーマ。data-dictionary.md 3章、FR-1.10。 */

import { z } from 'zod';
import { MAX_NOTE_LENGTH } from '../constants/limits.ts';
import {
  CategorySchema,
  EquipmentIdSchema,
  IsoDateTimeSchema,
  ObservationQualitySchema,
  ObservationSourceSchema,
  UserIdSchema,
} from './common.ts';

export const ObservationSchema = z.object({
  equipmentId: EquipmentIdSchema,
  category: CategorySchema,
  itemKey: z.string().min(1),
  observedAt: IsoDateTimeSchema,
  /** 欠損は null（0 で代用しない）。ステータスコードは文字列。 */
  value: z.union([z.number(), z.string(), z.null()]),
  source: ObservationSourceSchema,
  quality: ObservationQualitySchema,
  receivedAt: IsoDateTimeSchema,
  sourceFileId: z.string().optional(),
  formatProfileVersion: z.string().optional(),
  enteredBy: UserIdSchema.optional(),
  note: z.string().max(MAX_NOTE_LENGTH).optional(),
  manualEntryId: z.string().optional(),
  isDeleted: z.boolean(),
});
export type Observation = z.infer<typeof ObservationSchema>;

/** 観測値の一意キー（設備ID、項目、計測日時、取得元）。data-dictionary.md 3章。 */
export function observationKey(
  observation: Pick<Observation, 'equipmentId' | 'itemKey' | 'observedAt' | 'source'>,
): string {
  return `${observation.equipmentId}#${observation.itemKey}#${observation.observedAt}#${observation.source}`;
}

/** GET /observations の応答（元データ・取り込み済みデータの一覧。FR-6.4、FR-6.8）。 */
export const ObservationListResponseSchema = z.object({
  items: z.array(ObservationSchema),
  nextCursor: z.string().nullable(),
});
export type ObservationListResponse = z.infer<typeof ObservationListResponseSchema>;
