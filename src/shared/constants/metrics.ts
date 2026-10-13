/**
 * メトリクス（算出値）と、判断基準の指標に使う値の表示情報（data-dictionary.md 6章）。
 * 算出式・判断基準は docs/10_design/viewpoint/ にあり、ここでは名前・単位・桁数のみ持つ。
 */

import { findItemDefinition } from './items.ts';

export interface MetricMeta {
  readonly label: string;
  readonly unit: string;
  /** 画面に表示する小数の桁数。 */
  readonly fractionDigits: number;
}

/** 総合満足度のメトリクスの識別子。 */
export const OVERALL_SATISFACTION_METRIC_ID = 'overallSatisfaction';
/** 状態（ステータスコードのカテゴリ）を指標として扱うときの識別子。 */
export const STATUS_INDICATOR_ID = 'status';

const METRIC_META: Readonly<Record<string, MetricMeta>> = {
  marketableFruitRatePercent: { label: '可販果率', unit: '%', fractionDigits: 1 },
  missedFruitRatePercent: { label: '取り残し率', unit: '%', fractionDigits: 1 },
  recognitionAccuracyPercent: { label: '認識精度', unit: '%', fractionDigits: 1 },
  damagedFruitRatePercent: { label: '果実損傷率', unit: '%', fractionDigits: 1 },
  averageSecondsPerFruit: { label: '平均処理時間', unit: '秒/果実', fractionDigits: 1 },
  travelStoppedRatePercent: { label: '走行停止率', unit: '%', fractionDigits: 1 },
  operationErrorRatePercent: { label: '操作エラー率', unit: '%', fractionDigits: 1 },
  mttrHours: { label: '平均修復時間（MTTR）', unit: '時間', fractionDigits: 2 },
  mtbfHours: { label: '平均故障間隔（MTBF）', unit: '時間', fractionDigits: 1 },
  availabilityPercent: { label: '稼働率', unit: '%', fractionDigits: 1 },
  harvestRatePerHour: { label: '収穫速度', unit: '個/時間', fractionDigits: 1 },
  economicProductivity: { label: 'EconomicProductivity', unit: '', fractionDigits: 2 },
  operatingCostYen: { label: '運用コスト', unit: '円', fractionDigits: 0 },
  emergencyStopPerHour: { label: '緊急停止頻度', unit: '回/時間', fractionDigits: 3 },
  nearMissPerHour: { label: 'ヒヤリハット頻度', unit: '回/時間', fractionDigits: 3 },
  dataCoveragePercent: { label: 'データ連携率', unit: '%', fractionDigits: 1 },
  robotDataCount: { label: 'ロボットデータ取得数', unit: '件', fractionDigits: 0 },
  sensorDataCount: { label: '環境センサーデータ取得数', unit: '件', fractionDigits: 0 },
  manualDataCount: { label: '手動入力データ取得数', unit: '件', fractionDigits: 0 },
  totalDataCount: { label: '全データ数', unit: '件', fractionDigits: 0 },
  [OVERALL_SATISFACTION_METRIC_ID]: { label: '総合満足度', unit: '', fractionDigits: 1 },
  // 環境の項目: 照度・CO2濃度は、整数で表示する（項目カタログの既定は小数第1位）
  temperatureCelsius: { label: '温度', unit: '℃', fractionDigits: 1 },
  humidityPercent: { label: '湿度', unit: '%', fractionDigits: 1 },
  illuminanceLux: { label: '照度', unit: 'lx', fractionDigits: 0 },
  co2Ppm: { label: 'CO2濃度', unit: 'ppm', fractionDigits: 0 },
  [STATUS_INDICATOR_ID]: { label: 'ステータス', unit: '', fractionDigits: 0 },
};

/** メトリクス・項目の識別子から、表示情報を返す。未定義の識別子は、項目カタログから補う。 */
export function getMetricMeta(metricId: string): MetricMeta {
  const meta = METRIC_META[metricId];
  if (meta !== undefined) {
    return meta;
  }
  const item = findItemDefinition(metricId);
  if (item !== undefined) {
    return {
      label: item.label,
      unit: item.unit,
      fractionDigits: item.valueType === 'integer' ? 0 : 1,
    };
  }
  return { label: metricId, unit: '', fractionDigits: 1 };
}

/** 欠損は「—」（ダッシュ）で表示する（functional-specification.md 1.2）。 */
export const MISSING_VALUE_TEXT = '—';

export function formatMetricValue(metricId: string, value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return MISSING_VALUE_TEXT;
  }
  const meta = getMetricMeta(metricId);
  const text = value.toFixed(meta.fractionDigits);
  return meta.unit === '' ? text : `${text}${meta.unit}`;
}
