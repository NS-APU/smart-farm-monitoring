/**
 * 判断基準の既定値（docs/10_design/viewpoint/ の既定値）。
 * 数値は構想時の既定値を仮に採用したもの（Q-007）。運用で変更できる（FR-5.7）ため、
 * 判定のコードには書かず、ここに1か所だけ定義する（coding-standards.md）。
 * ステータス（ステータスコードのカテゴリ）で判定する指標は、判断基準の対象外。
 */

import { getMetricMeta } from '@smart-farm/shared/constants/metrics';
import type { ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import type { Criterion, ViewpointCriteria } from '@smart-farm/shared/schemas/criteria';

/** 既定値の版。判断基準を変更すると、版が変わる。 */
export const DEFAULT_CRITERIA_VERSION = 'DEFAULT';

/** 条件名（label）を除いた判断基準（型ごとの閾値）。 */
type CriterionWithoutLabel = Criterion extends infer Variant
  ? Variant extends unknown
    ? Omit<Variant, 'label'>
    : never
  : never;

/** 条件名は、指標の表示名（メトリクスの表示情報）を使う。 */
function withLabel(criterion: CriterionWithoutLabel): Criterion {
  return { ...criterion, label: getMetricMeta(criterion.indicator).label };
}

function upper(indicator: string, cautionFrom: number, errorFrom: number): Criterion {
  return withLabel({ indicator, kind: 'UPPER', thresholds: { cautionFrom, errorFrom } });
}

function lower(indicator: string, cautionBelow: number, errorBelow: number): Criterion {
  return withLabel({ indicator, kind: 'LOWER', thresholds: { errorBelow, cautionBelow } });
}

function range(
  indicator: string,
  errorLower: number,
  normalLower: number,
  normalUpper: number,
  errorUpper: number,
): Criterion {
  return withLabel({
    indicator,
    kind: 'RANGE',
    thresholds: { errorLower, normalLower, normalUpper, errorUpper },
  });
}

const CRITERIA_BY_VIEWPOINT: Readonly<Record<ViewpointId, readonly Criterion[]>> = {
  harvestAccuracy: [
    lower('marketableFruitRatePercent', 90, 80),
    lower('recognitionAccuracyPercent', 90, 80),
  ],
  harvestSpeed: [
    upper('travelStoppedRatePercent', 5, 10),
    upper('averageSecondsPerFruit', 60, 120),
  ],
  environmentalAdaptability: [
    range('temperatureCelsius', 0, 10, 25, 35),
    range('humidityPercent', 30, 40, 80, 90),
    range('illuminanceLux', 10000, 20000, 40000, 50000),
    range('co2Ppm', 200, 800, 1000, 3000),
  ],
  operability: [
    upper('operationStepCount', 5, 10),
    upper('operationMinutes', 10, 30),
    upper('operationErrorRatePercent', 10, 30),
  ],
  maintainability: [upper('mttrHours', 4, 8)],
  costEfficiency: [
    lower('marketableFruitRatePercent', 90, 80),
    upper('averageSecondsPerFruit', 60, 120),
    lower('availabilityPercent', 95, 90),
    lower('economicProductivity', 1.2, 1.0),
  ],
  safety: [upper('emergencyStopPerHour', 0.01, 0.05), upper('nearMissPerHour', 0.05, 0.2)],
  dataUtilization: [lower('dataCoveragePercent', 90, 70)],
  durability: [lower('mtbfHours', 500, 100), lower('availabilityPercent', 95, 90)],
  satisfaction: [lower('overallSatisfaction', 4, 3)],
};

/** 観点の既定の判断基準。 */
export function getDefaultCriteria(viewpointId: ViewpointId): ViewpointCriteria {
  return {
    viewpointId,
    criteria: CRITERIA_BY_VIEWPOINT[viewpointId].map((criterion) => structuredClone(criterion)),
    version: DEFAULT_CRITERIA_VERSION,
    isDefault: true,
  };
}
