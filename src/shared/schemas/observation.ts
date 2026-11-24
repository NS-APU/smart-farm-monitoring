/** 観測値（共通形式 Observation）のスキーマ。data-dictionary.md 3章、FR-1.10。 */

import { z } from 'zod';
import { MAX_NOTE_LENGTH } from '../constants/limits.ts';
import {
  CategorySchema,
  EquipmentIdSchema,
  HorizonSchema,
  IsoDateTimeSchema,
  ObservationQualitySchema,
  ObservationSourceSchema,
  PeriodDaysSchema,
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

/**
 * 手動入力の「評価に使われるか」（D-26。Issue #162）。合計（累積）の項目は、評価の期間に、同じ設備・項目の自動取り込みの値があれば、
 * 自動だけを使い、手動入力は使われない。保存・修正の応答（項目ごと）と、計測データの一覧（行ごと。SC-09-4）が使う。
 * - `used`: いずれかの評価の期間（短期視点・長期視点の各期間）で、評価に使われるか
 * - `autoPriorityPeriods`: 自動取り込みの値を使うため、この入力が使われない評価の期間（短期は `periodDays` が null）。なければ空
 */
export const EvaluationUsageSchema = z.object({
  used: z.boolean(),
  autoPriorityPeriods: z.array(
    z.object({ horizon: HorizonSchema, periodDays: PeriodDaysSchema.nullable() }),
  ),
});
export type EvaluationUsage = z.infer<typeof EvaluationUsageSchema>;

/**
 * 一覧の応答の、観測値の行。`usage` は、クエリ `includeUsage=true` のときだけ、合計の項目の手動入力の行に付く
 * （計測の日時が、評価の期間〔最長 90 日〕の外の行・自動取り込みの行・合計でない項目の行には付かない）。
 */
export const ObservationRowSchema = ObservationSchema.extend({
  usage: EvaluationUsageSchema.optional(),
});
export type ObservationRow = z.infer<typeof ObservationRowSchema>;

/** 観測値の一意キー（設備ID、項目、計測日時、取得元）。data-dictionary.md 3章。 */
export function observationKey(
  observation: Pick<Observation, 'equipmentId' | 'itemKey' | 'observedAt' | 'source'>,
): string {
  return `${observation.equipmentId}#${observation.itemKey}#${observation.observedAt}#${observation.source}`;
}

/** GET /observations の応答（元データ・取り込み済みデータの一覧。FR-6.4、FR-6.8）。 */
export const ObservationListResponseSchema = z.object({
  items: z.array(ObservationRowSchema),
  nextCursor: z.string().nullable(),
});
export type ObservationListResponse = z.infer<typeof ObservationListResponseSchema>;

/**
 * 1 回の計測（設備・計測日時・取得元〔手動入力は、1 回の入力〕）の観測値のまとまり（Issue #363）。
 * 取り込みの 1 レコード・手動入力の 1 回の入力は、項目ごとの観測値に展開されて保存される。一覧では、その 1 回の計測を 1 行にまとめる。
 */
export const MeasurementSchema = z.object({
  equipmentId: EquipmentIdSchema,
  observedAt: IsoDateTimeSchema,
  source: ObservationSourceSchema,
  /** 手動入力の 1 回の入力の識別子（自動取り込みは、なし）。 */
  manualEntryId: z.string().optional(),
  /** 最も新しい受信日時。 */
  receivedAt: IsoDateTimeSchema,
  /** この計測の項目ごとの観測値（項目の定義の順）。 */
  items: z.array(ObservationRowSchema).min(1),
});
export type Measurement = z.infer<typeof MeasurementSchema>;

/** GET /observations/measurements の応答（計測単位の一覧。日時順だけ。FR-6.8。Issue #363）。 */
export const MeasurementListResponseSchema = z.object({
  items: z.array(MeasurementSchema),
  /** 次のページの開始位置（このページの最後の計測の日時）。最後のページは null。 */
  nextCursor: z.string().nullable(),
});
export type MeasurementListResponse = z.infer<typeof MeasurementListResponseSchema>;
