/**
 * 観点の定義（判定する指標・ダッシュボードの主要メトリクス・詳細のメトリクス・必須の入力・算出するメトリクスの順序）を、
 * 一覧で固定する（観点の定義の記述を整理しても、定義の内容と順序が変わらないことを確認する）。
 */

import { describe, expect, it } from 'vitest';
import { VIEWPOINT_DEFINITIONS } from '../../../../src/backend/domain/evaluation/viewpoints/registry.ts';

const EXPECTED = [
  {
    id: 'harvestAccuracy',
    judged: ['marketableFruitRatePercent', 'recognitionAccuracyPercent'],
    dashboard: ['marketableFruitRatePercent', 'recognitionAccuracyPercent'],
    detail: [
      'marketableFruitRatePercent',
      'recognitionAccuracyPercent',
      'missedFruitRatePercent',
      'damagedFruitRatePercent',
    ],
    required: ['harvestCount', 'damagedFruitCount', 'wrongHarvestCount', 'missedFruitCount'],
    metricKeys: [
      'marketableFruitRatePercent',
      'recognitionAccuracyPercent',
      'missedFruitRatePercent',
      'damagedFruitRatePercent',
    ],
  },
  {
    id: 'harvestSpeed',
    judged: ['travelStoppedRatePercent', 'averageSecondsPerFruit'],
    dashboard: ['averageSecondsPerFruit', 'travelStoppedRatePercent'],
    detail: [
      'averageSecondsPerFruit',
      'travelStoppedRatePercent',
      'harvestOperatingHours',
      'travelStoppedHours',
    ],
    required: ['harvestOperatingHours', 'travelStoppedHours', 'harvestCount', 'statusCode'],
    metricKeys: [
      'averageSecondsPerFruit',
      'travelStoppedRatePercent',
      'harvestOperatingHours',
      'travelStoppedHours',
    ],
  },
  {
    id: 'environmentalAdaptability',
    judged: ['temperatureCelsius', 'humidityPercent', 'illuminanceLux', 'co2Ppm'],
    dashboard: ['temperatureCelsius', 'humidityPercent', 'illuminanceLux', 'co2Ppm'],
    detail: ['temperatureCelsius', 'humidityPercent', 'illuminanceLux', 'co2Ppm'],
    required: [],
    metricKeys: ['temperatureCelsius', 'humidityPercent', 'illuminanceLux', 'co2Ppm'],
  },
  {
    id: 'operability',
    judged: ['operationStepCount', 'operationMinutes', 'operationErrorRatePercent'],
    dashboard: ['operationStepCount', 'operationMinutes', 'operationErrorRatePercent'],
    detail: [
      'operationStepCount',
      'operationMinutes',
      'operationErrorRatePercent',
      'operationErrorCount',
    ],
    required: ['operationMinutes', 'operationStepCount', 'operationErrorCount'],
    metricKeys: [
      'operationStepCount',
      'operationMinutes',
      'operationErrorRatePercent',
      'operationErrorCount',
    ],
  },
  {
    id: 'maintainability',
    judged: ['mttrHours'],
    dashboard: ['mttrHours'],
    detail: ['mttrHours', 'failureCount', 'recoveryMinutes'],
    required: ['failureCount', 'recoveryMinutes', 'statusCode'],
    metricKeys: ['mttrHours', 'failureCount', 'recoveryMinutes'],
  },
  {
    id: 'costEfficiency',
    judged: [
      'marketableFruitRatePercent',
      'averageSecondsPerFruit',
      'availabilityPercent',
      'economicProductivity',
    ],
    dashboard: [
      'marketableFruitRatePercent',
      'averageSecondsPerFruit',
      'availabilityPercent',
      'economicProductivity',
    ],
    detail: [
      'marketableFruitRatePercent',
      'averageSecondsPerFruit',
      'availabilityPercent',
      'economicProductivity',
      'mtbfHours',
      'mttrHours',
      'harvestRatePerHour',
      'operatingCostYen',
    ],
    required: [
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
    metricKeys: [
      'marketableFruitRatePercent',
      'averageSecondsPerFruit',
      'availabilityPercent',
      'economicProductivity',
      'mtbfHours',
      'mttrHours',
      'harvestRatePerHour',
      'operatingCostYen',
    ],
  },
  {
    id: 'safety',
    judged: ['emergencyStopPerHour', 'nearMissPerHour'],
    dashboard: ['emergencyStopPerHour', 'nearMissPerHour'],
    detail: ['emergencyStopPerHour', 'nearMissPerHour', 'emergencyStopCount', 'nearMissCount'],
    required: ['emergencyStopCount', 'nearMissCount', 'operatingHours'],
    metricKeys: ['emergencyStopPerHour', 'nearMissPerHour', 'emergencyStopCount', 'nearMissCount'],
  },
  {
    id: 'dataUtilization',
    judged: ['dataCoveragePercent'],
    dashboard: ['dataCoveragePercent'],
    detail: [
      'dataCoveragePercent',
      'robotDataCount',
      'sensorDataCount',
      'manualDataCount',
      'totalDataCount',
    ],
    required: ['totalDataCount'],
    metricKeys: [
      'dataCoveragePercent',
      'robotDataCount',
      'sensorDataCount',
      'manualDataCount',
      'totalDataCount',
    ],
  },
  {
    id: 'durability',
    judged: ['mtbfHours', 'availabilityPercent'],
    dashboard: ['mtbfHours', 'availabilityPercent'],
    detail: ['mtbfHours', 'availabilityPercent', 'mttrHours', 'operatingHours', 'failureCount'],
    required: ['operatingHours', 'recoveryMinutes', 'failureCount', 'statusCode'],
    metricKeys: ['mtbfHours', 'availabilityPercent', 'mttrHours', 'operatingHours', 'failureCount'],
  },
  {
    id: 'satisfaction',
    judged: ['overallSatisfaction'],
    dashboard: ['overallSatisfaction'],
    detail: [
      'overallSatisfaction',
      'satisfaction.harvestAccuracy',
      'satisfaction.harvestSpeed',
      'satisfaction.environmentalAdaptability',
      'satisfaction.operability',
      'satisfaction.maintainability',
      'satisfaction.costEfficiency',
      'satisfaction.safety',
      'satisfaction.dataUtilization',
      'satisfaction.durability',
    ],
    required: [
      'satisfaction.harvestAccuracy',
      'satisfaction.harvestSpeed',
      'satisfaction.environmentalAdaptability',
      'satisfaction.operability',
      'satisfaction.maintainability',
      'satisfaction.costEfficiency',
      'satisfaction.safety',
      'satisfaction.dataUtilization',
      'satisfaction.durability',
    ],
    metricKeys: [
      'satisfaction.harvestAccuracy',
      'satisfaction.harvestSpeed',
      'satisfaction.environmentalAdaptability',
      'satisfaction.operability',
      'satisfaction.maintainability',
      'satisfaction.costEfficiency',
      'satisfaction.safety',
      'satisfaction.dataUtilization',
      'satisfaction.durability',
      'overallSatisfaction',
    ],
  },
] as const;

describe('観点の定義の内容', () => {
  it('観点は、表示順に10観点ある', () => {
    expect(VIEWPOINT_DEFINITIONS.map((definition) => definition.id)).toEqual(
      EXPECTED.map((expected) => expected.id),
    );
  });

  for (const expected of EXPECTED) {
    it(`${expected.id}: 判定する指標・主要メトリクス・詳細のメトリクス・必須の入力が、順序を含めて定義どおりである`, () => {
      const definition = VIEWPOINT_DEFINITIONS.find((candidate) => candidate.id === expected.id);
      expect(definition?.judgedIndicators).toEqual(expected.judged);
      expect(definition?.dashboardMetrics).toEqual(expected.dashboard);
      expect(definition?.detailMetrics).toEqual(expected.detail);
      expect(definition?.requiredInputs).toEqual(expected.required);
    });

    it(`${expected.id}: 算出するメトリクスのキーの並びが、定義どおりである`, () => {
      const definition = VIEWPOINT_DEFINITIONS.find((candidate) => candidate.id === expected.id);
      expect(Object.keys(definition?.computeMetrics({}) ?? {})).toEqual(expected.metricKeys);
    });
  }
});
