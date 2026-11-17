/**
 * データ入力（SC-06。Issue #361）の、スライダーの範囲の目安（項目ごと）。
 * 入力を助ける目安で、保存できる値の範囲ではない（保存の検証は、`items.ts` の最小・最大〔手動入力の上限〕）。
 * 目安を超える値は、数値の欄に入力でき、スライダーの範囲は、その値を含むように広がる（ただし、保存できる上限は超えない）。
 * 数値は、運用の様子から決めた**仮の値**（1 回の入力の、ふつうの大きさ）。根拠は未確認で、評価関係者に確認する（#516）。
 * 手動入力できる数値の項目は、すべて、ここに定義する（`entry-ranges.test.ts` が、漏れ・保存できる範囲との食い違いを確認する）。
 */

import type { ThresholdSliderRange } from './criteria-ranges.ts';

const SLIDER_RANGES: Readonly<Record<string, ThresholdSliderRange>> = {
  // 操作情報
  operationMinutes: { min: 0, max: 120, step: 1 },
  operationStepCount: { min: 0, max: 30, step: 1 },
  operationErrorCount: { min: 0, max: 20, step: 1 },
  // 収穫情報
  harvestCount: { min: 0, max: 1000, step: 10 },
  harvestSecondsPerFruit: { min: 0, max: 300, step: 1 },
  harvestAttemptCount: { min: 0, max: 1000, step: 10 },
  harvestSuccessCount: { min: 0, max: 1000, step: 10 },
  misrecognitionCount: { min: 0, max: 100, step: 1 },
  damagedFruitCount: { min: 0, max: 100, step: 1 },
  wrongHarvestCount: { min: 0, max: 100, step: 1 },
  missedFruitCount: { min: 0, max: 100, step: 1 },
  // 稼働情報（時間。1 日の範囲）
  operatingHours: { min: 0, max: 24, step: 0.5 },
  standbyHours: { min: 0, max: 24, step: 0.5 },
  harvestOperatingHours: { min: 0, max: 24, step: 0.5 },
  travelStoppedHours: { min: 0, max: 24, step: 0.5 },
  // 安全情報
  emergencyStopCount: { min: 0, max: 20, step: 1 },
  nearMissCount: { min: 0, max: 20, step: 1 },
  // コスト情報
  robotCostYenPerHour: { min: 0, max: 10000, step: 100 },
  laborCostYenPerHour: { min: 0, max: 5000, step: 100 },
  maintenanceCostYen: { min: 0, max: 100000, step: 1000 },
  electricityCostYen: { min: 0, max: 10000, step: 100 },
  // 故障情報
  failureCount: { min: 0, max: 20, step: 1 },
  recoveryMinutes: { min: 0, max: 480, step: 5 },
  // 環境情報
  temperatureCelsius: { min: -10, max: 50, step: 0.5 },
  humidityPercent: { min: 0, max: 100, step: 1 },
  illuminanceLux: { min: 0, max: 100000, step: 1000 },
  co2Ppm: { min: 0, max: 5000, step: 50 },
};

/** 項目のスライダーの範囲の目安。定めていない項目（ステータスコード・満足度など、数値でないもの）は undefined。 */
export function findEntrySliderRange(itemKey: string): ThresholdSliderRange | undefined {
  return SLIDER_RANGES[itemKey];
}
