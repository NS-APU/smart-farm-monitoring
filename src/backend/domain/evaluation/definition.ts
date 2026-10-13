/**
 * 観点の定義と、評価の入出力の型（ドメイン層）。
 * 観点の追加は、定義の追加（viewpoints/）と判断基準の既定値（default-criteria.ts）の追加で行う
 * （NFR-2.7, NFR-8.2、architecture.md 7章）。
 */

import type { ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import type { StatusDetail } from '@smart-farm/shared/schemas/evaluation';

/** 期間で集計した入力値。取得できていない項目は、キーを持たない（0 で代用しない）。 */
export type MeasureValues = Readonly<Record<string, number>>;

/** 集計済みの入力（観測値 → 評価の入力）。 */
export interface Measures {
  readonly values: MeasureValues;
  /** ステータスコード（短期は最新、長期は期間内で最も悪いカテゴリ）。未取得は null。 */
  readonly status: StatusDetail | null;
}

export type MetricValueMap = Readonly<Record<string, number | null>>;

export interface ViewpointDefinition {
  readonly id: ViewpointId;
  /** 短期評価を持つか（Q-009。暫定の決め方は dev_spec.md 4章）。 */
  readonly hasShortHorizon: boolean;
  /** 判断基準（criteria の indicator）で判定する指標。 */
  readonly judgedIndicators: readonly string[];
  /** ステータスコードのカテゴリを判定に使うか（判断基準は編集できない。FR-5.7）。 */
  readonly usesStatusIndicator: boolean;
  /** 一部の指標だけ取得できていれば、取得できた指標だけで判定するか（環境適応性）。 */
  readonly allowsPartialJudgement: boolean;
  /** 未取得ならば「不明」とする入力項目（項目の識別子。ステータスコードは statusCode）。 */
  readonly requiredInputs: readonly string[];
  /** ダッシュボードに出す主要メトリクス。 */
  readonly dashboardMetrics: readonly string[];
  /** 詳細画面に出す全メトリクス。 */
  readonly detailMetrics: readonly string[];
  /** 注意・異常のときの推奨アクション（文言は暫定。Q-010）。 */
  readonly attentionAction: string;
  /** メトリクスを算出する純粋関数。算出できない（分母が 0 など）メトリクスは null。 */
  computeMetrics(values: MeasureValues): MetricValueMap;
}

/** 観点の定義の記述。主要メトリクスを省略すると、判定する指標と同じになる（多くの観点で同じ）。 */
export type ViewpointSpec = Omit<ViewpointDefinition, 'dashboardMetrics'> & {
  readonly dashboardMetrics?: readonly string[];
};

export function defineViewpoint(spec: ViewpointSpec): ViewpointDefinition {
  return { ...spec, dashboardMetrics: spec.dashboardMetrics ?? spec.judgedIndicators };
}
