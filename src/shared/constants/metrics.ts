/**
 * メトリクス（算出値）と、判断基準の指標に使う値の表示情報（data-dictionary.md 6章）。
 * 算出式・判断基準は docs/10_design/viewpoint/ にあり、ここでは名前・単位・桁数・画面の説明（用語辞書。Issue #154）を持つ。
 */

import { findItemDefinition } from './items.ts';

export interface MetricMeta {
  readonly label: string;
  readonly unit: string;
  /** 画面に表示する小数の桁数。 */
  readonly fractionDigits: number;
  /** 指標の説明（ヘルプヒントに表示する。設計の定義から書く。定義のない指標は、持たない）。 */
  readonly help?: string;
}

/** 総合満足度のメトリクスの識別子。 */
export const OVERALL_SATISFACTION_METRIC_ID = 'overallSatisfaction';
/** 状態（ステータスコードのカテゴリ）を指標として扱うときの識別子。 */
export const STATUS_INDICATOR_ID = 'status';

const METRIC_META: Readonly<Record<string, MetricMeta>> = {
  marketableFruitRatePercent: {
    label: '可販果率',
    unit: '%',
    fractionDigits: 1,
    help: '収穫数のうち、誤収穫と果実の損傷を除いた、売れる状態の果実の割合です',
  },
  missedFruitRatePercent: {
    label: '取り残し率',
    unit: '%',
    fractionDigits: 1,
    help: '収穫できた果実と取り残した果実の合計のうち、取り残した果実の割合です',
  },
  recognitionAccuracyPercent: {
    label: '認識精度',
    unit: '%',
    fractionDigits: 1,
    help: '取り残さずに収穫できた割合です（100% から取り残し率を引いた値）',
  },
  damagedFruitRatePercent: {
    label: '果実損傷率',
    unit: '%',
    fractionDigits: 1,
    help: '収穫数のうち、損傷した果実の割合です',
  },
  averageSecondsPerFruit: {
    label: '平均処理時間',
    unit: '秒/果実',
    fractionDigits: 1,
    help: '1果実の収穫にかかった平均の時間です（収穫稼働時間 ÷ 収穫数）',
  },
  travelStoppedRatePercent: {
    label: '走行停止率',
    unit: '%',
    fractionDigits: 1,
    help: '収穫稼働時間のうち、走行が止まっていた時間の割合です',
  },
  operationErrorRatePercent: {
    label: '操作エラー率',
    unit: '%',
    fractionDigits: 1,
    help: '操作ステップ数のうち、操作エラーの割合です',
  },
  mttrHours: {
    label: '平均修復時間（MTTR）',
    unit: '時間',
    fractionDigits: 2,
    help: '故障から復旧までにかかる平均時間です。復旧のしやすさを示します',
  },
  mtbfHours: {
    label: '平均故障間隔（MTBF）',
    unit: '時間',
    fractionDigits: 1,
    help: '故障から次の故障までの平均時間です。ロボット運用の信頼性を示します',
  },
  availabilityPercent: {
    label: '稼働率',
    unit: '%',
    fractionDigits: 1,
    help: '平均故障間隔（MTBF）と平均修復時間（MTTR）から求める、稼働できている時間の割合です（MTBF ÷ (MTBF + MTTR)）',
  },
  harvestRatePerHour: {
    label: '収穫速度',
    unit: '個/時間',
    fractionDigits: 1,
    help: '収穫稼働時間1時間あたりに収穫した果実の数です',
  },
  // 設計上の名称は EconomicProductivity（data-dictionary.md 6章）。画面には、日本語の表示名を使う
  economicProductivity: {
    label: '経済生産性',
    unit: '',
    fractionDigits: 2,
    help: '運用コストに対する、収穫の成果の比です',
  },
  operatingCostYen: { label: '運用コスト', unit: '円', fractionDigits: 0 },
  emergencyStopPerHour: {
    label: '緊急停止頻度',
    unit: '回/時間',
    fractionDigits: 3,
    help: '稼働時間1時間あたりの、緊急停止の回数です',
  },
  nearMissPerHour: {
    label: 'ヒヤリハット頻度',
    unit: '回/時間',
    fractionDigits: 3,
    help: '稼働時間1時間あたりの、ヒヤリハット（事故や損傷にはならなかったが、ロボットの動作で、人・作物・設備に、危害や損傷を与えかけた出来事）の件数です',
  },
  dataCoveragePercent: {
    label: 'データ連携率',
    unit: '%',
    fractionDigits: 1,
    help: '評価に必要なデータが、どれだけ取得・連携できているかを示す割合です（取得できたデータ数 ÷ 全データ数）',
  },
  robotDataCount: { label: 'ロボットデータ取得数', unit: '件', fractionDigits: 0 },
  sensorDataCount: { label: '環境センサーデータ取得数', unit: '件', fractionDigits: 0 },
  manualDataCount: { label: '手動入力データ取得数', unit: '件', fractionDigits: 0 },
  totalDataCount: { label: '全データ数', unit: '件', fractionDigits: 0 },
  [OVERALL_SATISFACTION_METRIC_ID]: {
    label: '総合満足度',
    unit: '',
    fractionDigits: 1,
    help: '満足度以外の9つの観点について、利用者が入力した満足度（1〜5 スター）の平均です',
  },
  // 環境の項目: 照度・CO2濃度は、整数で表示する（項目カタログの既定は小数第1位）
  temperatureCelsius: { label: '温度', unit: '℃', fractionDigits: 1 },
  humidityPercent: { label: '湿度', unit: '%', fractionDigits: 1 },
  illuminanceLux: { label: '照度', unit: 'lx', fractionDigits: 0 },
  co2Ppm: { label: 'CO2濃度', unit: 'ppm', fractionDigits: 0 },
  [STATUS_INDICATOR_ID]: {
    label: 'ステータス',
    unit: '',
    fractionDigits: 0,
    help: 'ロボットの状態を表すステータスコードの名称です。コードのカテゴリ（正常・注意・異常）が、判定に使われます',
  },
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
