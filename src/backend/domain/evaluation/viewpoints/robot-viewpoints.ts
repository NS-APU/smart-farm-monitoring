/**
 * ロボットの健全性の観点（収穫精度・収穫速度・操作性・メンテナンス性・コスト効率・安全性・耐久性）。
 * メトリクスの算出式は docs/10_design/viewpoint/robot-health.md に従う。
 * 数値・式は構想時の既定値を仮に採用したもの（Q-007）。
 */

import { defineViewpoint } from '../definition.ts';
import { divideOrNull, normalizeMetric, percentOrNull } from '../numbers.ts';
import {
  availabilityPercent,
  averageSecondsPerFruit,
  marketableFruitRatePercent,
  mtbfHours,
  mttrHours,
  optionalValue,
  passThrough,
  pickAll,
} from './helpers.ts';

export const harvestAccuracy = defineViewpoint({
  id: 'harvestAccuracy',
  hasShortHorizon: true,
  judgedIndicators: ['marketableFruitRatePercent', 'recognitionAccuracyPercent'],
  usesStatusIndicator: false,
  allowsPartialJudgement: false,
  requiredInputs: ['harvestCount', 'damagedFruitCount', 'wrongHarvestCount', 'missedFruitCount'],
  detailMetrics: [
    'marketableFruitRatePercent',
    'recognitionAccuracyPercent',
    'missedFruitRatePercent',
    'damagedFruitRatePercent',
  ],
  attentionAction: '傷つけや取り残しの原因を現場で確認し、収穫の条件を調整してください',
  computeMetrics(values) {
    const missed = pickAll(values, ['harvestCount', 'missedFruitCount']);
    const damaged = pickAll(values, ['harvestCount', 'damagedFruitCount']);
    const missedRate =
      missed === null
        ? null
        : percentOrNull(missed.missedFruitCount, missed.harvestCount + missed.missedFruitCount);
    return {
      marketableFruitRatePercent: marketableFruitRatePercent(values),
      recognitionAccuracyPercent: missedRate === null ? null : normalizeMetric(100 - missedRate),
      missedFruitRatePercent: missedRate,
      damagedFruitRatePercent:
        damaged === null ? null : percentOrNull(damaged.damagedFruitCount, damaged.harvestCount),
    };
  },
});

export const harvestSpeed = defineViewpoint({
  id: 'harvestSpeed',
  hasShortHorizon: true,
  judgedIndicators: ['travelStoppedRatePercent', 'averageSecondsPerFruit'],
  usesStatusIndicator: true,
  allowsPartialJudgement: false,
  requiredInputs: ['harvestOperatingHours', 'travelStoppedHours', 'harvestCount', 'statusCode'],
  dashboardMetrics: ['averageSecondsPerFruit', 'travelStoppedRatePercent'],
  detailMetrics: [
    'averageSecondsPerFruit',
    'travelStoppedRatePercent',
    'harvestOperatingHours',
    'travelStoppedHours',
  ],
  attentionAction: '走行・収穫が滞っている原因を確認し、復旧・調整してください',
  computeMetrics(values) {
    const stopped = pickAll(values, ['travelStoppedHours', 'harvestOperatingHours']);
    return {
      averageSecondsPerFruit: averageSecondsPerFruit(values),
      travelStoppedRatePercent:
        stopped === null
          ? null
          : percentOrNull(stopped.travelStoppedHours, stopped.harvestOperatingHours),
      ...passThrough(values, ['harvestOperatingHours', 'travelStoppedHours']),
    };
  },
});

export const operability = defineViewpoint({
  id: 'operability',
  hasShortHorizon: true,
  judgedIndicators: ['operationStepCount', 'operationMinutes', 'operationErrorRatePercent'],
  usesStatusIndicator: false,
  allowsPartialJudgement: false,
  requiredInputs: ['operationMinutes', 'operationStepCount', 'operationErrorCount'],
  detailMetrics: [
    'operationStepCount',
    'operationMinutes',
    'operationErrorRatePercent',
    'operationErrorCount',
  ],
  attentionAction: '操作の手順や設定を見直し、ミスしやすい操作がないか確認してください',
  computeMetrics(values) {
    const operation = pickAll(values, ['operationStepCount', 'operationErrorCount']);
    let errorRate: number | null = null;
    if (operation !== null) {
      // 操作ステップ数が 0 の場合のみ、操作エラー率は 0%（evaluation.md 4章の例外）
      errorRate =
        operation.operationStepCount === 0
          ? 0
          : percentOrNull(operation.operationErrorCount, operation.operationStepCount);
    }
    return {
      ...passThrough(values, ['operationStepCount', 'operationMinutes']),
      operationErrorRatePercent: errorRate,
      operationErrorCount: optionalValue(values, 'operationErrorCount'),
    };
  },
});

export const maintainability = defineViewpoint({
  id: 'maintainability',
  hasShortHorizon: true,
  judgedIndicators: ['mttrHours'],
  usesStatusIndicator: true,
  allowsPartialJudgement: false,
  requiredInputs: ['failureCount', 'recoveryMinutes', 'statusCode'],
  detailMetrics: ['mttrHours', 'failureCount', 'recoveryMinutes'],
  attentionAction: '復旧し、故障回数と復旧に要した時間を記録してください',
  computeMetrics(values) {
    return {
      mttrHours: mttrHours(values),
      ...passThrough(values, ['failureCount', 'recoveryMinutes']),
    };
  },
});

/** 運用コスト（円）。暫定: (ロボットコスト + 人件費)（円/時間）× 稼働時間 + メンテナンス費 + 電気代。 */
function operatingCostYen(values: Readonly<Record<string, number>>): number | null {
  const picked = pickAll(values, [
    'robotCostYenPerHour',
    'laborCostYenPerHour',
    'operatingHours',
    'maintenanceCostYen',
    'electricityCostYen',
  ]);
  if (picked === null) {
    return null;
  }
  return normalizeMetric(
    (picked.robotCostYenPerHour + picked.laborCostYenPerHour) * picked.operatingHours +
      picked.maintenanceCostYen +
      picked.electricityCostYen,
  );
}

export const costEfficiency = defineViewpoint({
  id: 'costEfficiency',
  // MTBF・稼働率は長い期間の指標のため、短期評価を持たない（Q-009 の暫定）
  hasShortHorizon: false,
  judgedIndicators: [
    'marketableFruitRatePercent',
    'averageSecondsPerFruit',
    'availabilityPercent',
    'economicProductivity',
  ],
  usesStatusIndicator: false,
  allowsPartialJudgement: false,
  requiredInputs: [
    'harvestCount',
    'harvestOperatingHours',
    'operatingHours',
    'failureCount',
    'recoveryMinutes',
    'damagedFruitCount',
    'wrongHarvestCount',
    'robotCostYenPerHour',
    'laborCostYenPerHour',
    'maintenanceCostYen',
    'electricityCostYen',
  ],
  detailMetrics: [
    'marketableFruitRatePercent',
    'averageSecondsPerFruit',
    'availabilityPercent',
    'economicProductivity',
    'mtbfHours',
    'mttrHours',
    'harvestRatePerHour',
    'operatingCostYen',
  ],
  attentionAction: '稼働状況と費用を見直してください',
  computeMetrics(values) {
    const operatingHours = values.operatingHours;
    // 稼働時間が 0 の場合は「不明」（robot-health.md 5章）
    const mtbf = operatingHours === 0 ? null : mtbfHours(values);
    const mttr = mttrHours(values);
    const availability = availabilityPercent(mtbf, mttr);
    const harvest = pickAll(values, ['harvestCount', 'harvestOperatingHours']);
    const harvestRatePerHour =
      harvest === null ? null : divideOrNull(harvest.harvestCount, harvest.harvestOperatingHours);
    const marketable = marketableFruitRatePercent(values);
    const cost = operatingCostYen(values);
    let economicProductivity: number | null = null;
    if (
      marketable !== null &&
      harvestRatePerHour !== null &&
      availability !== null &&
      cost !== null &&
      cost !== 0
    ) {
      economicProductivity = normalizeMetric(
        ((marketable / 100) * harvestRatePerHour * (availability / 100)) / cost,
      );
    }
    return {
      marketableFruitRatePercent: marketable,
      averageSecondsPerFruit: averageSecondsPerFruit(values),
      availabilityPercent: availability,
      economicProductivity,
      mtbfHours: mtbf,
      mttrHours: mttr,
      harvestRatePerHour,
      operatingCostYen: cost,
    };
  },
});

export const safety = defineViewpoint({
  id: 'safety',
  hasShortHorizon: true,
  judgedIndicators: ['emergencyStopPerHour', 'nearMissPerHour'],
  usesStatusIndicator: false,
  allowsPartialJudgement: false,
  requiredInputs: ['emergencyStopCount', 'nearMissCount', 'operatingHours'],
  detailMetrics: ['emergencyStopPerHour', 'nearMissPerHour', 'emergencyStopCount', 'nearMissCount'],
  attentionAction: '現場で安全を確認し、緊急停止・ヒヤリハットの原因を確認してください',
  computeMetrics(values) {
    const emergency = pickAll(values, ['emergencyStopCount', 'operatingHours']);
    const nearMiss = pickAll(values, ['nearMissCount', 'operatingHours']);
    return {
      emergencyStopPerHour:
        emergency === null
          ? null
          : divideOrNull(emergency.emergencyStopCount, emergency.operatingHours),
      nearMissPerHour:
        nearMiss === null ? null : divideOrNull(nearMiss.nearMissCount, nearMiss.operatingHours),
      ...passThrough(values, ['emergencyStopCount', 'nearMissCount']),
    };
  },
});

export const durability = defineViewpoint({
  id: 'durability',
  // MTBF・稼働率は長い期間の指標のため、短期評価を持たない（Q-009 の暫定）
  hasShortHorizon: false,
  judgedIndicators: ['mtbfHours', 'availabilityPercent'],
  usesStatusIndicator: true,
  allowsPartialJudgement: false,
  requiredInputs: ['operatingHours', 'recoveryMinutes', 'failureCount', 'statusCode'],
  detailMetrics: [
    'mtbfHours',
    'availabilityPercent',
    'mttrHours',
    'operatingHours',
    'failureCount',
  ],
  attentionAction: '故障の傾向を確認し、保守を判断してください',
  computeMetrics(values) {
    const mtbf = mtbfHours(values);
    const mttr = mttrHours(values);
    return {
      mtbfHours: mtbf,
      availabilityPercent: availabilityPercent(mtbf, mttr),
      mttrHours: mttr,
      ...passThrough(values, ['operatingHours', 'failureCount']),
    };
  },
});
