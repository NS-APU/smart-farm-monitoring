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
import {
  EquipmentIdSchema,
  EquipmentTypeSchema,
  EvaluationStatusSchema,
  EvaluationWriteStateSchema,
  IsoDateTimeSchema,
  UserIdSchema,
  ViewpointIdSchema,
} from './common.ts';
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
  /**
   * 最終変更者の表示名。読み取り時に、現在のユーザー名から付ける（保存しない。削除済みの利用者は、項目を出さない。
   * 画面は、「ユーザー名（ID）」で表示する。Issue #154 の SC-07-7）。
   */
  updatedByName: z.string().optional(),
});
export type CriteriaView = z.infer<typeof CriteriaViewSchema>;

/** PUT /viewpoints/{viewpointId}/criteria・POST .../reset の応答: 判断基準の編集の応答と、評価の状態（ADR-0014。項目がなければ、`DONE` とみなす）。 */
export const CriteriaSaveResponseSchema = CriteriaViewSchema.extend({
  evaluation: EvaluationWriteStateSchema.optional(),
});
export type CriteriaSaveResponse = z.infer<typeof CriteriaSaveResponseSchema>;

/** 影響のプレビューの、設備 1 件（名称は、画面に示すため）。 */
const PreviewEquipmentSchema = z.object({
  equipmentId: EquipmentIdSchema,
  equipmentName: z.string(),
  equipmentType: EquipmentTypeSchema,
});

/**
 * POST /viewpoints/{viewpointId}/criteria/preview の応答（SC-13-2。ADR-0017 の D-24）。入力途中の閾値を、保存済みの評価結果に当てて、
 * 再判定した結果（保存しない）。観点の状態（短期・長期の既定の期間のうち「不明」を除いた悪い方）が変わる設備だけを、`changes` に含める。
 */
export const CriteriaPreviewResponseSchema = z.object({
  viewpointId: ViewpointIdSchema,
  /** 再判定に使った保存済みの結果のうち、最も古い評価日時。使った結果がなければ null。 */
  evaluatedAt: IsoDateTimeSchema.nullable(),
  /** 対象の設備の数（閲覧できる、この観点の対象の設備。削除済みを除く）。 */
  targetCount: z.number().int().nonnegative(),
  /** 状態が変わる設備。「現在」は、現在の判断基準を保存済みの結果に当てた判定、「変更後」は、入力途中の判断基準を当てた判定。 */
  changes: z.array(
    PreviewEquipmentSchema.extend({
      current: EvaluationStatusSchema,
      after: EvaluationStatusSchema,
    }),
  ),
  /** 一度も評価されていない設備（保存済みの結果がない。再判定できない）。 */
  unevaluated: z.array(PreviewEquipmentSchema),
  /** 状態が「不明」の設備の数（判断基準によらない理由のため、変えても「不明」のまま。再判定の対象外）。 */
  unknownCount: z.number().int().nonnegative(),
});
export type CriteriaPreviewResponse = z.infer<typeof CriteriaPreviewResponseSchema>;

/** 判断基準の入力を検証し、項目ごとのエラーを返す（空配列なら有効）。 */
export function validateCriteriaInput(input: unknown): FieldError[] {
  const result = CriteriaUpdateRequestSchema.safeParse(input);
  if (result.success) {
    return [];
  }
  return toFieldErrors(result.error);
}
