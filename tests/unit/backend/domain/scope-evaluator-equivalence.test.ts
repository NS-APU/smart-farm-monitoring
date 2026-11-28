/**
 * 評価の単位の評価（`evaluateScope`）の、計算の高速化（窓ごとの観測値の解釈・累積の項目の基準の引き直しをやめた）が、結果を変えないことの確認
 * （Issue #165 の PR 3。負荷テストの同時の保存の応答時間）。
 * 基準: 窓ごとに、観測値を絞り込み、`aggregateMeasures` の `observations`・`priorObservations`（窓ごとに、全件を解釈し直す経路。推移〔series〕と同じ）で
 * 集計する、変更前の `evaluateScope` と同じ手順。複数のデータセット（合成データ。同じ計測日時の重なり・手動入力と自動取り込みの重なり・論理削除・
 * 品質・遅れて受信した値・値の減少〔リセット〕・期間より前の基準・ステータスコード・満足度）で、診断の全項目が一致すること。
 */

import { describe, expect, it } from 'vitest';
import { CUMULATIVE_ITEM_KEYS, isCumulativeItem } from '@smart-farm/shared/constants/items';
import { VIEWPOINT_IDS } from '@smart-farm/shared/constants/viewpoints';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import type { StatusCodeDefinition } from '@smart-farm/shared/schemas/status-code';
import { MS_PER_HOUR } from '@smart-farm/shared/time';
import { getDefaultCriteria } from '../../../../src/shared/constants/default-criteria.ts';
import { evaluateHorizon } from '../../../../src/backend/domain/evaluation/engine.ts';
import { aggregateMeasures } from '../../../../src/backend/domain/evaluation/measures.ts';
import {
  evaluateScope,
  evaluationWindows,
  type EvaluationDraft,
  type ScopeEvaluationInput,
} from '../../../../src/backend/domain/evaluation/scope-evaluator.ts';
import { getViewpointDefinition } from '../../../../src/backend/domain/evaluation/viewpoints/registry.ts';
import { STATUS_CODE_FIXTURES } from '../../../support/builders.ts';

/** 変更前の `evaluateScope`（窓ごとに、観測値を絞り込み、全件を解釈し直して集計する）。 */
function referenceEvaluateScope(input: ScopeEvaluationInput): EvaluationDraft[] {
  const drafts: EvaluationDraft[] = [];
  const nowMs = input.now.getTime();
  const observedMs = input.observations.map((observation) => Date.parse(observation.observedAt));
  const around = (fromMs: number, toMs: number) => {
    const within: Observation[] = [];
    const prior: Observation[] = [...(input.baselineObservations ?? [])];
    for (const [index, observation] of input.observations.entries()) {
      const ms = observedMs[index] ?? Number.NaN;
      if (ms >= fromMs && ms <= toMs) {
        within.push(observation);
      } else if (ms < fromMs && isCumulativeItem(observation.itemKey)) {
        prior.push(observation);
      }
    }
    return { within, prior };
  };
  for (const viewpointId of input.viewpointIds) {
    const definition = getViewpointDefinition(viewpointId);
    const criteria = input.criteriaOf(viewpointId);
    for (const window of evaluationWindows(definition.hasShortHorizon)) {
      const from = new Date(nowMs - window.hours * MS_PER_HOUR);
      const { within, prior } = around(from.getTime(), nowMs);
      const measures = aggregateMeasures({
        observations: within,
        priorObservations: prior,
        horizon: window.horizon,
        from,
        to: input.now,
        statusCodes: input.statusCodes,
        expectedStreams: input.expectedStreams,
        coverageSlotMinutes: input.coverageSlotMinutes,
      });
      drafts.push({
        viewpointId,
        horizon: window.horizon,
        periodDays: window.periodDays,
        evaluation: evaluateHorizon({ definition, measures, criteria }),
        evaluatedFrom: from,
        evaluatedTo: input.now,
        criteriaVersion: criteria.version,
        isCustomCriteria: !criteria.isDefault,
      });
    }
  }
  return drafts;
}

const NOW = new Date('2026-11-24T03:00:00.000Z');
const EQUIPMENT = ['HOUSE-Q', 'ROBOT-Q1', 'ROBOT-Q2', 'SENSOR-Q1'].map(toEquipmentId);
const NUMERIC_ITEMS = [
  ...CUMULATIVE_ITEM_KEYS,
  'temperatureCelsius',
  'humidityPercent',
  'operationMinutes',
  'operationStepCount',
  'operationErrorCount',
  'emergencyStopCount',
  'satisfaction.harvestAccuracy',
  'satisfaction.safety',
] as const;
const STATUS_CODES = new Map<string, StatusCodeDefinition>(
  STATUS_CODE_FIXTURES.map((definition) => [definition.code, definition]),
);

function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function pick<Item>(items: readonly Item[], random: () => number): Item {
  return items[Math.floor(random() * items.length)] as Item;
}

/** 合成の観測値。計測日時は 1 時間の格子（同じ計測日時が重なる）。 */
function generate(seed: number, count: number, daysBack: number): Observation[] {
  const random = createRandom(seed);
  const result: Observation[] = [];
  const counters = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const hoursAgo = Math.floor(random() * daysBack * 24);
    const observedAt = new Date(NOW.getTime() - hoursAgo * MS_PER_HOUR).toISOString();
    const itemKey = random() < 0.08 ? 'statusCode' : pick<string>(NUMERIC_ITEMS, random);
    const equipmentId = pick(EQUIPMENT, random);
    const source = random() < 0.25 ? 'MANUAL' : 'AUTO_IMPORT';
    const counterKey = `${equipmentId}#${itemKey}#${source}`;
    let value: number | string | null;
    if (itemKey === 'statusCode') {
      value = pick(STATUS_CODE_FIXTURES, random).code;
    } else if (isCumulativeItem(itemKey)) {
      // 累積: 増えていき、ときどき減る（リセット）
      const previous = counters.get(counterKey) ?? 0;
      value = random() < 0.05 ? Math.floor(random() * 5) : previous + Math.floor(random() * 10);
      counters.set(counterKey, value);
    } else if (itemKey.startsWith('satisfaction.')) {
      value = 1 + Math.floor(random() * 5);
    } else {
      value = Math.floor(random() * 40);
    }
    if (random() < 0.03) {
      value = null;
    }
    const late = random() < 0.05;
    result.push({
      equipmentId,
      category:
        itemKey === 'statusCode' ? 'STATUS' : itemKey.includes('Count') ? 'FAILURE' : 'OPERATION',
      itemKey,
      observedAt,
      value,
      source,
      quality: pick(['VALID', 'VALID', 'VALID', 'LATE', 'MISSING', 'INVALID'] as const, random),
      // まれに、評価時刻より後に受信した値（評価に使わない）
      receivedAt: new Date(
        Date.parse(observedAt) + (late ? 5 * 24 * MS_PER_HOUR : 60_000),
      ).toISOString(),
      isDeleted: random() < 0.04,
    });
  }
  return result;
}

function inputOf(
  seed: number,
  options: {
    count: number;
    baselineCount: number;
    viewpointIds: readonly (typeof VIEWPOINT_IDS)[number][];
  },
): ScopeEvaluationInput {
  return {
    observations: generate(seed, options.count, 95),
    // 期間（最長 90 日）より前の基準
    baselineObservations: generate(seed + 7, options.baselineCount, 400).map(
      (observation, index) => {
        const observedAt = new Date(
          NOW.getTime() - (91 * 24 + (index % 5)) * MS_PER_HOUR,
        ).toISOString();
        return { ...observation, observedAt, receivedAt: observedAt };
      },
    ),
    now: NOW,
    viewpointIds: options.viewpointIds,
    criteriaOf: (viewpointId) => getDefaultCriteria(viewpointId),
    statusCodes: STATUS_CODES,
    expectedStreams: { robot: true, sensor: true },
    coverageSlotMinutes: 15,
  };
}

describe('評価の単位の評価（evaluateScope）の高速化は、結果を変えない', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    '全観点・全窓: 窓ごとに全件を解釈し直す手順と、診断の全項目が一致する（データセット %i）',
    (seed) => {
      const input = inputOf(seed, { count: 1500, baselineCount: 60, viewpointIds: VIEWPOINT_IDS });

      const actual = evaluateScope(input);
      const expected = referenceEvaluateScope(input);

      expect(actual).toEqual(expected);
      // 比べている結果が、「不明」だけに偏っていない
      expect(new Set(actual.map((draft) => draft.evaluation.status)).size).toBeGreaterThanOrEqual(
        2,
      );
    },
  );

  it('観測値がない・期間外だけ・基準がない場合でも、一致する', () => {
    const empty = inputOf(11, { count: 0, baselineCount: 0, viewpointIds: VIEWPOINT_IDS });
    const sparse = inputOf(12, { count: 40, baselineCount: 0, viewpointIds: VIEWPOINT_IDS });
    const withoutBaseline: ScopeEvaluationInput = { ...sparse };
    delete (withoutBaseline as { baselineObservations?: unknown }).baselineObservations;

    for (const input of [empty, sparse, withoutBaseline]) {
      expect(evaluateScope(input)).toEqual(referenceEvaluateScope(input));
    }
  });

  it('同じ計測日時の累積の値（基準の候補が同時刻）・手動入力と自動取り込みの重なりが多いデータでも、一致する', () => {
    const random = createRandom(99);
    const observations: Observation[] = [];
    for (let index = 0; index < 600; index += 1) {
      // 計測日時を 6 時間の格子（ほとんどが同時刻）に置く
      const hoursAgo = Math.floor(random() * 30) * 6 + 2;
      const observedAt = new Date(NOW.getTime() - hoursAgo * MS_PER_HOUR).toISOString();
      observations.push({
        equipmentId: pick(EQUIPMENT.slice(1, 3), random),
        category: 'OPERATION',
        itemKey: pick(['harvestCount', 'operatingHours', 'harvestOperatingHours'], random),
        observedAt,
        value: Math.floor(random() * 50),
        source: pick(['AUTO_IMPORT', 'MANUAL'] as const, random),
        quality: 'VALID',
        receivedAt: observedAt,
        isDeleted: false,
      });
    }
    const input: ScopeEvaluationInput = {
      observations,
      now: NOW,
      viewpointIds: VIEWPOINT_IDS,
      criteriaOf: (viewpointId) => getDefaultCriteria(viewpointId),
      statusCodes: STATUS_CODES,
      expectedStreams: { robot: true, sensor: false },
      coverageSlotMinutes: 60,
    };

    expect(evaluateScope(input)).toEqual(referenceEvaluateScope(input));
  });
});
