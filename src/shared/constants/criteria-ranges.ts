/**
 * 判断基準の編集（SC-13）の、スライダーの範囲の目安（指標ごと。Issue #358）。
 * 閾値の入力を助ける目安で、保存できる値の範囲ではない（保存の検証は、`schemas/criteria.ts`。率〔%〕だけ 0〜100）。
 * 範囲外の値は、数値の欄に入力でき、スライダーの範囲は、その値を含むように広げる。
 * 数値は、運用の様子から決めた仮の値（既定の閾値の 2〜3 倍を目安）。評価関係者に確認する（Q-007）。
 */

export interface ThresholdSliderRange {
  readonly min: number;
  readonly max: number;
  /** スライダーの 1 目盛り。 */
  readonly step: number;
}

const PERCENT: ThresholdSliderRange = { min: 0, max: 100, step: 1 };

const SLIDER_RANGES: Readonly<Record<string, ThresholdSliderRange>> = {
  // 率（%）: 0〜100（保存の検証と同じ）
  marketableFruitRatePercent: PERCENT,
  missedFruitRatePercent: PERCENT,
  recognitionAccuracyPercent: PERCENT,
  damagedFruitRatePercent: PERCENT,
  travelStoppedRatePercent: PERCENT,
  operationErrorRatePercent: PERCENT,
  availabilityPercent: PERCENT,
  dataCoveragePercent: PERCENT,
  humidityPercent: PERCENT,
  // 時間・回数・頻度
  averageSecondsPerFruit: { min: 0, max: 300, step: 1 },
  mttrHours: { min: 0, max: 48, step: 0.5 },
  mtbfHours: { min: 0, max: 2000, step: 10 },
  operationStepCount: { min: 0, max: 30, step: 1 },
  operationMinutes: { min: 0, max: 120, step: 1 },
  emergencyStopPerHour: { min: 0, max: 0.2, step: 0.001 },
  nearMissPerHour: { min: 0, max: 1, step: 0.01 },
  // 経済生産性・満足度
  economicProductivity: { min: 0, max: 3, step: 0.1 },
  overallSatisfaction: { min: 1, max: 5, step: 0.1 },
  // 環境の値
  temperatureCelsius: { min: -10, max: 50, step: 0.5 },
  illuminanceLux: { min: 0, max: 100000, step: 1000 },
  co2Ppm: { min: 0, max: 5000, step: 50 },
};

/** 指標のスライダーの範囲の目安。定めていない指標は undefined（画面は、現在の閾値から決める）。 */
export function findThresholdSliderRange(indicator: string): ThresholdSliderRange | undefined {
  return SLIDER_RANGES[indicator];
}
