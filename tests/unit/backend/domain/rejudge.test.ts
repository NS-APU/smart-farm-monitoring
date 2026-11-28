/**
 * 保存済みの評価結果の再判定（`rejudgeStatus`。Issue #165 の SC-13-2。判断基準の影響のプレビュー）。
 * 検証: 「閾値 A で評価した結果のメトリクスを、閾値 B で再判定した結果」と「閾値 B で評価した結果」が、一致すること。
 * （プレビューと実際の評価で、判定のロジックが 1 か所であることの確認。）
 */

import { describe, expect, it } from 'vitest';
import { satisfactionItemKey } from '@smart-farm/shared/constants/items';
import {
  SATISFACTION_TARGET_VIEWPOINT_IDS,
  VIEWPOINT_IDS,
  type ViewpointId,
} from '@smart-farm/shared/constants/viewpoints';
import type { Criterion, ViewpointCriteria } from '@smart-farm/shared/schemas/criteria';
import type { StatusDetail } from '@smart-farm/shared/schemas/evaluation';
import { getDefaultCriteria } from '../../../../src/shared/constants/default-criteria.ts';
import {
  evaluateHorizon,
  rejudgeStatus,
} from '../../../../src/backend/domain/evaluation/engine.ts';
import { getViewpointDefinition } from '../../../../src/backend/domain/evaluation/viewpoints/registry.ts';

const NORMAL_STATUS: StatusDetail = { code: 'HARVESTING', name: '収穫中', category: 'NORMAL' };
const CAUTION_STATUS: StatusDetail = { code: 'STOPPED', name: '停止中', category: 'CAUTION' };
const ERROR_STATUS: StatusDetail = { code: 'FALLEN', name: '転倒', category: 'ERROR' };
const STATUSES: readonly (StatusDetail | null)[] = [
  null,
  NORMAL_STATUS,
  CAUTION_STATUS,
  ERROR_STATUS,
];

/** 観点ごとの入力の基準値（合成データ）。各項目を、0・半分・そのまま・2 倍・欠損にして、組み合わせる。 */
const BASE_VALUES: Readonly<Record<ViewpointId, Readonly<Record<string, number>>>> = {
  harvestAccuracy: {
    harvestCount: 100,
    damagedFruitCount: 5,
    wrongHarvestCount: 5,
    missedFruitCount: 5,
  },
  harvestSpeed: { harvestOperatingHours: 1, travelStoppedHours: 0.06, harvestCount: 100 },
  environmentalAdaptability: {
    temperatureCelsius: 20,
    humidityPercent: 60,
    illuminanceLux: 30000,
    co2Ppm: 900,
  },
  operability: { operationMinutes: 9, operationStepCount: 4, operationErrorCount: 1 },
  maintainability: { failureCount: 2, recoveryMinutes: 300 },
  costEfficiency: {
    harvestCount: 120,
    harvestOperatingHours: 1,
    operatingHours: 2,
    failureCount: 1,
    recoveryMinutes: 30,
    damagedFruitCount: 3,
    wrongHarvestCount: 3,
    robotCostYenPerHour: 25,
    laborCostYenPerHour: 25,
    maintenanceCostYen: 10,
    electricityCostYen: 10,
  },
  safety: { emergencyStopCount: 1, nearMissCount: 2, operatingHours: 100 },
  dataUtilization: {
    robotDataCount: 50,
    sensorDataCount: 30,
    manualDataCount: 10,
    totalDataCount: 100,
  },
  durability: { operatingHours: 1000, failureCount: 2, recoveryMinutes: 120 },
  satisfaction: Object.fromEntries(
    SATISFACTION_TARGET_VIEWPOINT_IDS.map((id) => [satisfactionItemKey(id), 4]),
  ),
};

/** 再現できる擬似乱数（0 以上 1 未満）。 */
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const VALUE_FACTORS = [0, 0.5, 1, 1.5, 2] as const;

function sampleValues(
  base: Readonly<Record<string, number>>,
  random: () => number,
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(base)) {
    // 5 回に 1 回は欠損（キーを持たない）にする
    if (random() < 0.2) {
      continue;
    }
    const factor = VALUE_FACTORS[Math.floor(random() * VALUE_FACTORS.length)] ?? 1;
    values[key] = value * factor;
  }
  return values;
}

/** 型の大小関係を保ったまま、閾値を、同じ倍率でずらす（倍率は正）。 */
function scaled(criterion: Criterion, factor: number): Criterion {
  switch (criterion.kind) {
    case 'UPPER':
      return {
        ...criterion,
        thresholds: {
          cautionFrom: criterion.thresholds.cautionFrom * factor,
          errorFrom: criterion.thresholds.errorFrom * factor,
        },
      };
    case 'LOWER':
      return {
        ...criterion,
        thresholds: {
          errorBelow: criterion.thresholds.errorBelow * factor,
          cautionBelow: criterion.thresholds.cautionBelow * factor,
        },
      };
    case 'RANGE':
      return {
        ...criterion,
        thresholds: {
          errorLower: criterion.thresholds.errorLower * factor,
          normalLower: criterion.thresholds.normalLower * factor,
          normalUpper: criterion.thresholds.normalUpper * factor,
          errorUpper: criterion.thresholds.errorUpper * factor,
        },
      };
  }
}

/** 閾値のうち 1 つを、指標の値（境界。「以上」「未満」の判定が分かれる点）にそろえる。大小関係が崩れるときは、そのままにする。 */
function pinnedTo(criterion: Criterion, value: number): Criterion {
  switch (criterion.kind) {
    case 'UPPER':
      return value < criterion.thresholds.errorFrom
        ? { ...criterion, thresholds: { ...criterion.thresholds, cautionFrom: value } }
        : criterion;
    case 'LOWER':
      return value > criterion.thresholds.errorBelow
        ? { ...criterion, thresholds: { ...criterion.thresholds, cautionBelow: value } }
        : criterion;
    case 'RANGE':
      return value > criterion.thresholds.errorLower && value < criterion.thresholds.normalUpper
        ? { ...criterion, thresholds: { ...criterion.thresholds, normalLower: value } }
        : criterion;
  }
}

function criteriaOf(viewpointId: ViewpointId, criteria: readonly Criterion[]): ViewpointCriteria {
  return {
    ...getDefaultCriteria(viewpointId),
    criteria: [...criteria],
    version: 'CUSTOM-1',
    isDefault: false,
  };
}

describe('保存済みの結果の再判定（rejudgeStatus）: 閾値 A の結果を閾値 B で再判定した結果は、閾値 B で評価した結果と一致する', () => {
  it.each(VIEWPOINT_IDS.map((id) => [id] as const))(
    '%s: 欠損・0・境界値・ステータスコードのカテゴリを含む入力と、閾値の組み合わせで、一致する',
    (viewpointId) => {
      const definition = getViewpointDefinition(viewpointId);
      const defaults = getDefaultCriteria(viewpointId);
      const random = createRandom(165 + VIEWPOINT_IDS.indexOf(viewpointId));
      const base = BASE_VALUES[viewpointId];
      const judgedStatuses = new Set<string>();
      let compared = 0;

      for (let sample = 0; sample < 60; sample += 1) {
        const values = sampleValues(base, random);
        const status = definition.usesStatusIndicator
          ? (STATUSES[Math.floor(random() * STATUSES.length)] ?? null)
          : null;
        const measures = { values, status };
        // 閾値 A: 既定値を、倍率でずらしたもの
        const criteriaA = criteriaOf(
          viewpointId,
          defaults.criteria.map((criterion) => scaled(criterion, [0.5, 1, 2][sample % 3] ?? 1)),
        );
        const evaluatedA = evaluateHorizon({ definition, measures, criteria: criteriaA });

        // 閾値 B: 倍率のちがい（0.8・1.1・3）と、指標の値にそろえた境界（A の結果のメトリクスの値）
        const candidatesB: ViewpointCriteria[] = [0.8, 1, 1.1, 3].map((factor) =>
          criteriaOf(
            viewpointId,
            defaults.criteria.map((criterion) => scaled(criterion, factor)),
          ),
        );
        candidatesB.push(
          criteriaOf(
            viewpointId,
            defaults.criteria.map((criterion) => {
              const metric = evaluatedA.metrics[criterion.indicator];
              return metric === null || metric === undefined
                ? criterion
                : pinnedTo(criterion, metric);
            }),
          ),
        );

        for (const criteriaB of candidatesB) {
          const evaluatedB = evaluateHorizon({ definition, measures, criteria: criteriaB });
          const rejudged = rejudgeStatus({
            definition,
            status: evaluatedA.status,
            metrics: evaluatedA.metrics,
            statusDetail: evaluatedA.statusDetail,
            criteria: criteriaB,
          });

          expect(rejudged).toBe(evaluatedB.status);
          judgedStatuses.add(evaluatedB.status);
          compared += 1;
        }
      }

      expect(compared).toBe(60 * 5);
      // 検証が、「不明」だけ・正常だけに偏っていない（複数の状態を、実際に比べている）
      expect(judgedStatuses.size).toBeGreaterThanOrEqual(2);
    },
  );

  it('境界値: 閾値ちょうどの値は、上限型は以上、下限型は未満、範囲型は [正常下限, 正常上限) で、評価と一致する', () => {
    const definition = getViewpointDefinition('environmentalAdaptability');
    const defaults = getDefaultCriteria('environmentalAdaptability');
    const boundary = [0, 10, 25, 35, 24.999, 9.999, 34.999, 35.001];

    for (const temperatureCelsius of boundary) {
      const measures = { values: { temperatureCelsius }, status: null };
      const evaluatedA = evaluateHorizon({ definition, measures, criteria: defaults });
      // B: 正常上限を、この値にそろえる（値ちょうどは、正常でなくなる）
      const criteriaB = criteriaOf(
        'environmentalAdaptability',
        defaults.criteria.map((criterion) =>
          criterion.indicator === 'temperatureCelsius' && criterion.kind === 'RANGE'
            ? {
                ...criterion,
                thresholds: {
                  ...criterion.thresholds,
                  normalUpper: Math.max(
                    criterion.thresholds.normalLower + 0.001,
                    Math.min(temperatureCelsius, criterion.thresholds.errorUpper - 0.001),
                  ),
                },
              }
            : criterion,
        ),
      );

      expect(
        rejudgeStatus({
          definition,
          status: evaluatedA.status,
          metrics: evaluatedA.metrics,
          statusDetail: evaluatedA.statusDetail,
          criteria: criteriaB,
        }),
      ).toBe(evaluateHorizon({ definition, measures, criteria: criteriaB }).status);
    }
  });

  it('「不明」の結果は、閾値を変えても「不明」のまま（未取得・算出できない・観測値がない）', () => {
    const cases = [
      // 未取得の項目がある（収穫精度）
      { viewpointId: 'harvestAccuracy', values: { harvestCount: 100 }, status: null },
      // 算出できない指標がある（収穫数 0。収穫精度）
      {
        viewpointId: 'harvestAccuracy',
        values: {
          harvestCount: 0,
          damagedFruitCount: 0,
          wrongHarvestCount: 0,
          missedFruitCount: 0,
        },
        status: null,
      },
      // 観測値が 1 つもない（環境適応性。一部の指標だけで判定する観点）
      { viewpointId: 'environmentalAdaptability', values: {}, status: null },
      // ステータスコードが未取得（収穫速度）
      {
        viewpointId: 'harvestSpeed',
        values: { harvestOperatingHours: 1, travelStoppedHours: 0.5, harvestCount: 10 },
        status: null,
      },
    ] as const;

    for (const item of cases) {
      const definition = getViewpointDefinition(item.viewpointId);
      const defaults = getDefaultCriteria(item.viewpointId);
      const measures = { values: item.values, status: item.status };
      const evaluatedA = evaluateHorizon({ definition, measures, criteria: defaults });
      expect(evaluatedA.status).toBe('UNKNOWN');
      const loose = criteriaOf(
        item.viewpointId,
        defaults.criteria.map((criterion) => scaled(criterion, 0.1)),
      );

      expect(
        rejudgeStatus({
          definition,
          status: evaluatedA.status,
          metrics: evaluatedA.metrics,
          statusDetail: evaluatedA.statusDetail,
          criteria: loose,
        }),
      ).toBe('UNKNOWN');
      expect(evaluateHorizon({ definition, measures, criteria: loose }).status).toBe('UNKNOWN');
    }
  });

  it('環境適応性の部分判定: 一部の指標だけ取得できているとき、取得できた指標だけで再判定する', () => {
    const definition = getViewpointDefinition('environmentalAdaptability');
    const defaults = getDefaultCriteria('environmentalAdaptability');
    // 温度だけ取得できている（湿度・照度・CO2 は欠損）。既定値では正常（10〜25℃）
    const measures = { values: { temperatureCelsius: 20 }, status: null };
    const evaluatedA = evaluateHorizon({ definition, measures, criteria: defaults });
    expect(evaluatedA.status).toBe('NORMAL');
    const tightened = criteriaOf(
      'environmentalAdaptability',
      defaults.criteria.map((criterion) =>
        criterion.indicator === 'temperatureCelsius' && criterion.kind === 'RANGE'
          ? { ...criterion, thresholds: { ...criterion.thresholds, normalUpper: 20 } }
          : criterion,
      ),
    );

    const rejudged = rejudgeStatus({
      definition,
      status: evaluatedA.status,
      metrics: evaluatedA.metrics,
      statusDetail: evaluatedA.statusDetail,
      criteria: tightened,
    });

    expect(rejudged).toBe('CAUTION');
    expect(rejudged).toBe(evaluateHorizon({ definition, measures, criteria: tightened }).status);
  });

  it('ステータスコードのカテゴリで判定する観点: 閾値に関わらず、カテゴリの悪さが下限になる（異常のカテゴリは、閾値を緩めても異常）', () => {
    const definition = getViewpointDefinition('maintainability');
    const defaults = getDefaultCriteria('maintainability');
    const measures = { values: { failureCount: 1, recoveryMinutes: 60 }, status: ERROR_STATUS };
    const evaluatedA = evaluateHorizon({ definition, measures, criteria: defaults });
    const loose = criteriaOf(
      'maintainability',
      defaults.criteria.map((criterion) => scaled(criterion, 10)),
    );

    expect(evaluatedA.status).toBe('ERROR');
    expect(
      rejudgeStatus({
        definition,
        status: evaluatedA.status,
        metrics: evaluatedA.metrics,
        statusDetail: evaluatedA.statusDetail,
        criteria: loose,
      }),
    ).toBe('ERROR');
  });
});
