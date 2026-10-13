/**
 * 判断基準のスキーマと検証（FR-5.7、data-dictionary.md 8.3）。
 * 検証は画面と API で共有する（architecture.md 7章）。
 *
 * 閾値の形:
 * - 上限型（UPPER）: 値が大きいほど悪い。注意開始値 < 異常開始値。値 >= 異常開始値 → 異常、>= 注意開始値 → 注意
 * - 下限型（LOWER）: 値が小さいほど悪い。異常下限 < 注意下限。値 < 異常下限 → 異常、< 注意下限 → 注意
 * - 範囲型（RANGE）: 異常下限 < 正常下限 < 正常上限 < 異常上限。正常は [正常下限, 正常上限) の範囲
 */

import { z } from 'zod';
import type { FieldError } from '../errors.ts';
import { getMetricMeta } from '../constants/metrics.ts';
import { IsoDateTimeSchema, UserIdSchema, ViewpointIdSchema } from './common.ts';
import { toFieldErrors } from './field-errors.ts';

/** 判断基準の条件の上限（FR-5.7）。 */
export const MAX_CRITERIA_COUNT = 20;
export const MAX_CRITERION_LABEL_LENGTH = 200;

const IndicatorSchema = z.string().min(1).max(100);
const LabelSchema = z
  .string()
  .trim()
  .min(1, '条件名は必須です')
  .max(
    MAX_CRITERION_LABEL_LENGTH,
    `条件名は${MAX_CRITERION_LABEL_LENGTH}文字以内で指定してください`,
  );
const ThresholdNumber = z.number('閾値は数値で指定してください');

export const UpperThresholdsSchema = z.object({
  cautionFrom: ThresholdNumber,
  errorFrom: ThresholdNumber,
});
export const LowerThresholdsSchema = z.object({
  errorBelow: ThresholdNumber,
  cautionBelow: ThresholdNumber,
});
export const RangeThresholdsSchema = z.object({
  errorLower: ThresholdNumber,
  normalLower: ThresholdNumber,
  normalUpper: ThresholdNumber,
  errorUpper: ThresholdNumber,
});

const UpperCriterionSchema = z.object({
  indicator: IndicatorSchema,
  kind: z.literal('UPPER'),
  thresholds: UpperThresholdsSchema,
  label: LabelSchema,
});
const LowerCriterionSchema = z.object({
  indicator: IndicatorSchema,
  kind: z.literal('LOWER'),
  thresholds: LowerThresholdsSchema,
  label: LabelSchema,
});
const RangeCriterionSchema = z.object({
  indicator: IndicatorSchema,
  kind: z.literal('RANGE'),
  thresholds: RangeThresholdsSchema,
  label: LabelSchema,
});

const BaseCriterionSchema = z.discriminatedUnion('kind', [
  UpperCriterionSchema,
  LowerCriterionSchema,
  RangeCriterionSchema,
]);
export type Criterion = z.infer<typeof BaseCriterionSchema>;

/** 閾値の大小関係が成り立たない場合の理由を返す。成り立つ場合は null。 */
export function findThresholdOrderViolation(criterion: Criterion): string | null {
  switch (criterion.kind) {
    case 'UPPER':
      return criterion.thresholds.cautionFrom < criterion.thresholds.errorFrom
        ? null
        : '注意開始値は異常開始値より小さくしてください';
    case 'LOWER':
      return criterion.thresholds.errorBelow < criterion.thresholds.cautionBelow
        ? null
        : '異常下限は注意下限より小さくしてください';
    case 'RANGE': {
      const { errorLower, normalLower, normalUpper, errorUpper } = criterion.thresholds;
      return errorLower < normalLower && normalLower < normalUpper && normalUpper < errorUpper
        ? null
        : '異常下限 < 正常下限 < 正常上限 < 異常上限 になるように指定してください';
    }
  }
}

/** 率（単位が %）の指標の閾値が取りうる範囲。 */
const PERCENT_MIN = 0;
const PERCENT_MAX = 100;

/** 閾値の値を、フラットに並べる（範囲の検証用）。 */
function thresholdValues(criterion: Criterion): number[] {
  return Object.values(criterion.thresholds);
}

/**
 * 閾値が、指標の取りうる範囲の外にある場合の理由を返す。範囲内なら null。
 * 率（%）の指標は 0〜100。範囲の外の閾値は、判定が発動しない（常に正常・常に異常になる）基準を、保存できてしまうため（V-028）。
 * 率以外の指標（時間・金額・頻度・環境の値など）は、物理的な範囲を定めていないため、検証しない。
 */
export function findThresholdRangeViolation(criterion: Criterion): string | null {
  if (getMetricMeta(criterion.indicator).unit !== '%') {
    return null;
  }
  return thresholdValues(criterion).every((value) => value >= PERCENT_MIN && value <= PERCENT_MAX)
    ? null
    : `この指標（%）の閾値は、${String(PERCENT_MIN)}〜${String(PERCENT_MAX)} の範囲で指定してください`;
}

export const CriterionSchema = BaseCriterionSchema.superRefine((criterion, context) => {
  const violation =
    findThresholdOrderViolation(criterion) ?? findThresholdRangeViolation(criterion);
  if (violation !== null) {
    context.addIssue({ code: 'custom', message: violation, path: ['thresholds'] });
  }
});

export const CriteriaListSchema = z
  .array(CriterionSchema)
  .min(1, '条件は1件以上必要です')
  .max(MAX_CRITERIA_COUNT, `条件は${MAX_CRITERIA_COUNT}件以内で指定してください`);

/** PUT /viewpoints/{viewpointId}/criteria の入力。 */
export const CriteriaUpdateRequestSchema = z.object({ criteria: CriteriaListSchema });
export type CriteriaUpdateRequest = z.infer<typeof CriteriaUpdateRequestSchema>;

/** 判断基準（観点ごと）。既定値か、変更後かを持つ。 */
export const ViewpointCriteriaSchema = z.object({
  viewpointId: ViewpointIdSchema,
  criteria: z.array(CriterionSchema),
  /** 判断基準の版。既定値は DEFAULT、変更後は変更ごとに更新する。 */
  version: z.string().min(1),
  isDefault: z.boolean(),
  updatedAt: IsoDateTimeSchema.optional(),
  updatedBy: UserIdSchema.optional(),
});
export type ViewpointCriteria = z.infer<typeof ViewpointCriteriaSchema>;

/** 判断基準の編集（SC-13）の応答: 判断基準と、ステータスコードでも判定する観点か（その指標は編集できない）。 */
export const CriteriaViewSchema = ViewpointCriteriaSchema.extend({
  usesStatusIndicator: z.boolean(),
});
export type CriteriaView = z.infer<typeof CriteriaViewSchema>;

/** 判断基準の入力を検証し、項目ごとのエラーを返す（空配列なら有効）。 */
export function validateCriteriaInput(input: unknown): FieldError[] {
  const result = CriteriaUpdateRequestSchema.safeParse(input);
  if (result.success) {
    return [];
  }
  return toFieldErrors(result.error);
}
