/** 評価結果・ダッシュボードのスキーマ。data-dictionary.md 8.2、functional-specification.md 4.2。 */

import { z } from 'zod';
import {
  EquipmentIdSchema,
  EvaluationStatusSchema,
  HorizonSchema,
  IsoDateTimeSchema,
  JudgedStatusSchema,
  PeriodDaysSchema,
  ViewpointIdSchema,
} from './common.ts';
import { ViewpointCriteriaSchema } from './criteria.ts';

export const MetricValuesSchema = z.record(z.string(), z.number().nullable());
export type MetricValues = z.infer<typeof MetricValuesSchema>;

/** 判定に使ったステータスコード（ステータス指標がある観点。名称で表示する）。 */
export const StatusDetailSchema = z.object({
  code: z.string(),
  name: z.string(),
  category: JudgedStatusSchema,
});
export type StatusDetail = z.infer<typeof StatusDetailSchema>;

export const EvaluationResultSchema = z.object({
  equipmentId: EquipmentIdSchema,
  viewpointId: ViewpointIdSchema,
  horizon: HorizonSchema,
  /** 長期視点のみ。短期視点は null。 */
  periodDays: PeriodDaysSchema.nullable(),
  status: EvaluationStatusSchema,
  metrics: MetricValuesSchema,
  indicatorStatuses: z.record(z.string(), EvaluationStatusSchema),
  statusDetail: StatusDetailSchema.nullable(),
  diagnosticMessage: z.string(),
  recommendedAction: z.string(),
  criteriaVersion: z.string(),
  isCustomCriteria: z.boolean(),
  evaluatedFrom: IsoDateTimeSchema,
  evaluatedTo: IsoDateTimeSchema,
  evaluatedAt: IsoDateTimeSchema,
});
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

export const DATA_FRESHNESS_VALUES = ['FRESH', 'STALE', 'NONE'] as const;
export type DataFreshness = (typeof DATA_FRESHNESS_VALUES)[number];

/** ダッシュボードの観点のカード。 */
export const ViewpointCardSchema = z.object({
  viewpointId: ViewpointIdSchema,
  name: z.string(),
  /** 短期・長期のうち「不明」を除いた悪い方（evaluation.md 5章）。 */
  status: EvaluationStatusSchema,
  statuses: z.object({
    short: EvaluationStatusSchema.nullable(),
    long: EvaluationStatusSchema,
  }),
  /** 主要メトリクス（名前 → 値。欠損は null）。 */
  metrics: MetricValuesSchema,
  /** 主要メトリクスごとの判定（メトリクスの良否を直感的に示す。FR-6.2）。判定していないメトリクスは含まない。 */
  metricStatuses: z.record(z.string(), EvaluationStatusSchema),
  statusDetail: StatusDetailSchema.nullable(),
  diagnosticMessage: z.string(),
  recommendedAction: z.string(),
  evaluatedFrom: IsoDateTimeSchema.nullable(),
  evaluatedTo: IsoDateTimeSchema.nullable(),
  isCustomCriteria: z.boolean(),
  /** 実際に表示に使った視点（短期評価を持たない観点で SHORT を指定された場合は LONG）。 */
  horizonUsed: HorizonSchema,
});
export type ViewpointCard = z.infer<typeof ViewpointCardSchema>;

export const DashboardResponseSchema = z.object({
  equipmentId: EquipmentIdSchema,
  horizon: HorizonSchema,
  periodDays: PeriodDaysSchema,
  /** 保存済みの評価結果のうち、最も新しい評価日時。評価がまだない場合は null。 */
  evaluatedAt: IsoDateTimeSchema.nullable(),
  /** 最終のデータ取得日時（FR-6.3）。 */
  lastReceivedAt: IsoDateTimeSchema.nullable(),
  /** データの新しさ: FRESH（新しい）／STALE（古い）／NONE（未取得）。 */
  dataFreshness: z.enum(DATA_FRESHNESS_VALUES),
  /** 「古い」とみなす基準（分）。 */
  staleThresholdMinutes: z.number(),
  summary: z.object({
    NORMAL: z.number(),
    CAUTION: z.number(),
    ERROR: z.number(),
    UNKNOWN: z.number(),
  }),
  viewpoints: z.array(ViewpointCardSchema),
});
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;

/** 観点の詳細（SC-03・SC-04）・推移（SC-03）のスキーマ。functional-specification.md 3.2・3.3、dev_spec.md 7章。 */

/** 視点（短期・長期）ごとの診断結果。 */
export const HorizonDiagnosisSchema = z.object({
  horizon: HorizonSchema,
  /** 長期視点のみ。短期視点は null。 */
  periodDays: PeriodDaysSchema.nullable(),
  status: EvaluationStatusSchema,
  diagnosticMessage: z.string(),
  recommendedAction: z.string(),
  /** 判定に使ったステータスコード（ステータス指標がある観点。名称で表示する）。 */
  statusDetail: StatusDetailSchema.nullable(),
  isCustomCriteria: z.boolean(),
  criteriaVersion: z.string(),
  /** 判定の対象期間。 */
  evaluatedFrom: IsoDateTimeSchema,
  evaluatedTo: IsoDateTimeSchema,
  evaluatedAt: IsoDateTimeSchema,
});
export type HorizonDiagnosis = z.infer<typeof HorizonDiagnosisSchema>;

/** 根拠のメトリクス（ダッシュボードに出さないものを含む全メトリクスの1行）。 */
export const MetricRowSchema = z.object({
  metricId: z.string(),
  /** 欠損・算出不能は null。 */
  value: z.number().nullable(),
  /** この指標の判定。判断基準で判定しない指標、評価できなかった指標は null。 */
  indicatorStatus: EvaluationStatusSchema.nullable(),
  /** ダッシュボードの主要メトリクスか。 */
  isPrimary: z.boolean(),
});
export type MetricRow = z.infer<typeof MetricRowSchema>;

/** 満足度のレーダーチャートの1軸（満足度以外の9観点。未入力は null）。 */
export const RadarPointSchema = z.object({
  viewpointId: ViewpointIdSchema,
  name: z.string(),
  score: z.number().nullable(),
});
export type RadarPoint = z.infer<typeof RadarPointSchema>;

export const ViewpointDetailResponseSchema = z.object({
  equipmentId: EquipmentIdSchema,
  viewpointId: ViewpointIdSchema,
  name: z.string(),
  /** 要求された視点と期間。 */
  horizon: HorizonSchema,
  periodDays: PeriodDaysSchema,
  /** 実際に表示に使った視点（短期評価を持たない観点で SHORT を指定された場合は LONG）。 */
  horizonUsed: HorizonSchema,
  hasShortHorizon: z.boolean(),
  /** 短期・長期のうち「不明」を除いた悪い方（evaluation.md 5章）。評価がまだなければ「不明」。 */
  status: EvaluationStatusSchema,
  /** 評価結果が保存されているか。 */
  isEvaluated: z.boolean(),
  short: HorizonDiagnosisSchema.nullable(),
  long: HorizonDiagnosisSchema.nullable(),
  /** 表示に使った視点の診断結果。 */
  selected: HorizonDiagnosisSchema.nullable(),
  /** 表示に使った視点の、全メトリクス（定義の順）。 */
  metrics: z.array(MetricRowSchema),
  /** 判定に使う判断基準（既定値、または変更後）。 */
  criteria: ViewpointCriteriaSchema,
  /** ステータスコードのカテゴリでも判定するか（判断基準は編集できない。FR-5.7）。 */
  usesStatusIndicator: z.boolean(),
  /** 満足度のみ: 9観点それぞれの満足度。 */
  radar: z.array(RadarPointSchema).nullable(),
});
export type ViewpointDetailResponse = z.infer<typeof ViewpointDetailResponseSchema>;

export const SERIES_BUCKETS = ['HOUR', 'DAY'] as const;

export const SeriesPointSchema = z.object({
  /** 区間の開始（UTC）。 */
  at: IsoDateTimeSchema,
  /** 欠損（区間にデータがない・算出できない）は null。 */
  value: z.number().nullable(),
});
export type SeriesPoint = z.infer<typeof SeriesPointSchema>;

export const SeriesMetricSchema = z.object({
  metricId: z.string(),
  isPrimary: z.boolean(),
  points: z.array(SeriesPointSchema),
  /** 期間の平均値（値がある区間の平均）。値がある区間がなければ null。 */
  average: z.number().nullable(),
});
export type SeriesMetric = z.infer<typeof SeriesMetricSchema>;

export const StatusChangePointSchema = z.object({
  changedAt: IsoDateTimeSchema,
  status: EvaluationStatusSchema,
});
export type StatusChangePoint = z.infer<typeof StatusChangePointSchema>;

export const SeriesResponseSchema = z.object({
  equipmentId: EquipmentIdSchema,
  viewpointId: ViewpointIdSchema,
  horizon: HorizonSchema,
  horizonUsed: HorizonSchema,
  periodDays: PeriodDaysSchema.nullable(),
  hasShortHorizon: z.boolean(),
  /** 区間の単位: HOUR（短期、当日）／DAY（直近7日以上）。 */
  bucket: z.enum(SERIES_BUCKETS),
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  metrics: z.array(SeriesMetricSchema),
  /** 観点の最終ステータスの推移（FR-6.10）。期間の開始時点のステータスと、期間内の変化。 */
  statusHistory: z.object({
    initial: EvaluationStatusSchema.nullable(),
    changes: z.array(StatusChangePointSchema),
  }),
  /** 視点ごとのフィードバック（最新の診断メッセージ・推奨アクション）。短期評価がなければ short は null。 */
  feedback: z.object({
    short: HorizonDiagnosisSchema.nullable(),
    long: HorizonDiagnosisSchema.nullable(),
  }),
});
export type SeriesResponse = z.infer<typeof SeriesResponseSchema>;
