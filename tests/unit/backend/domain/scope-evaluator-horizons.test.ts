/**
 * 評価の単位の評価（`evaluateScope`）で、評価する視点（`horizons`）を、短期だけに絞ったときの確認（Issue #591。手動入力の保存の直後に、
 * 「現在」＝短期の評価だけを、同期で行うため）。
 * - 短期だけに絞った結果は、全視点の結果のうち、短期のものと、すべての項目が一致する
 * - 短期の評価は、直近 7 日（`CURRENT_EVALUATION_READ_DAYS`）の観測値と、7 日より前の累積の基準（設備・項目ごとの最新の値）だけで決まり、
 *   全期間を読んだ評価と、同じ結果になる（観測値が 7 日の中にあるとき。読み取りを、90 日から 7 日に減らせる）。
 *   24 時間分だけを読むと、累積の項目の基準が（取得元ごと・使える品質の最新の値でなく、設備・項目ごとの最新の値になり）、違うことがある
 */

import { describe, expect, it } from 'vitest';
import { CUMULATIVE_ITEM_KEYS } from '@smart-farm/shared/constants/items';
import { VIEWPOINT_IDS } from '@smart-farm/shared/constants/viewpoints';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import type { StatusCodeDefinition } from '@smart-farm/shared/schemas/status-code';
import { MS_PER_HOUR } from '@smart-farm/shared/time';
import { getDefaultCriteria } from '../../../../src/shared/constants/default-criteria.ts';
import {
  CURRENT_EVALUATION_READ_DAYS,
  evaluateScope,
  type ScopeEvaluationInput,
} from '../../../../src/backend/domain/evaluation/scope-evaluator.ts';
import { getViewpointDefinition } from '../../../../src/backend/domain/evaluation/viewpoints/registry.ts';
import { STATUS_CODE_FIXTURES } from '../../../support/builders.ts';

const NOW = new Date('2026-11-24T03:00:00.000Z');
const EQUIPMENT = ['ROBOT-H1', 'ROBOT-H2', 'SENSOR-H1'].map(toEquipmentId);
const STATUS_CODES = new Map<string, StatusCodeDefinition>(
  STATUS_CODE_FIXTURES.map((definition) => [definition.code, definition]),
);
const LEVEL_ITEMS = ['temperatureCelsius', 'humidityPercent', 'operationMinutes'] as const;

function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** 合成の観測値（直近 N 日。累積の項目・水準の項目・ステータスコード。手動入力と自動取り込みが重なる）。 */
function generate(seed: number, count: number, daysBack: number): Observation[] {
  const random = createRandom(seed);
  const counters = new Map<string, number>();
  const result: Observation[] = [];
  for (let index = 0; index < count; index += 1) {
    const observedAt = new Date(
      NOW.getTime() - Math.floor(random() * daysBack * 24) * MS_PER_HOUR,
    ).toISOString();
    const kind = random();
    const equipmentId = EQUIPMENT[Math.floor(random() * EQUIPMENT.length)] ?? EQUIPMENT[0];
    const source = random() < 0.3 ? 'MANUAL' : 'AUTO_IMPORT';
    let itemKey: string;
    let value: number | string;
    if (kind < 0.1) {
      itemKey = 'statusCode';
      value = STATUS_CODE_FIXTURES[Math.floor(random() * STATUS_CODE_FIXTURES.length)]?.code ?? '';
    } else if (kind < 0.6) {
      itemKey = CUMULATIVE_ITEM_KEYS[Math.floor(random() * CUMULATIVE_ITEM_KEYS.length)] ?? '';
      const counterKey = `${String(equipmentId)}#${itemKey}#${source}`;
      const previous = counters.get(counterKey) ?? 0;
      value = random() < 0.05 ? Math.floor(random() * 5) : previous + Math.floor(random() * 10);
      counters.set(counterKey, value);
    } else {
      itemKey = LEVEL_ITEMS[Math.floor(random() * LEVEL_ITEMS.length)] ?? '';
      value = Math.floor(random() * 40);
    }
    result.push({
      equipmentId: equipmentId ?? EQUIPMENT[0] ?? toEquipmentId('ROBOT-H1'),
      category: itemKey === 'statusCode' ? 'STATUS' : 'OPERATION',
      itemKey,
      observedAt,
      value,
      source,
      quality: 'VALID',
      receivedAt: observedAt,
      isDeleted: false,
    });
  }
  return result;
}

function inputOf(observations: readonly Observation[]): ScopeEvaluationInput {
  return {
    observations,
    now: NOW,
    viewpointIds: VIEWPOINT_IDS,
    criteriaOf: (viewpointId) => getDefaultCriteria(viewpointId),
    statusCodes: STATUS_CODES,
    expectedStreams: { robot: true, sensor: true },
    coverageSlotMinutes: 15,
  };
}

/** 設備・項目ごとに、`before` より前で、計測日時が最も新しい観測値（`findLatestBefore` と同じ。同じ計測日時は、手動入力）。 */
function latestBefore(observations: readonly Observation[], before: Date): Observation[] {
  const latest = new Map<string, Observation>();
  for (const item of observations) {
    if (
      item.isDeleted ||
      !CUMULATIVE_ITEM_KEYS.includes(item.itemKey) ||
      Date.parse(item.observedAt) >= before.getTime()
    ) {
      continue;
    }
    const key = `${String(item.equipmentId)}#${item.itemKey}`;
    const current = latest.get(key);
    const order =
      current === undefined ? 1 : Date.parse(item.observedAt) - Date.parse(current.observedAt);
    if (order > 0 || (order === 0 && item.source === 'MANUAL')) {
      latest.set(key, item);
    }
  }
  return [...latest.values()];
}

describe('評価する視点を、短期だけに絞る（horizons）', () => {
  it.each([1, 2, 3, 4, 5, 6])(
    '短期だけに絞った結果は、全視点の結果のうち、短期のものと一致する（データセット %i）',
    (seed) => {
      const observations = generate(seed, 800, 40);

      const shortOnly = evaluateScope({ ...inputOf(observations), horizons: ['SHORT'] });
      const all = evaluateScope(inputOf(observations));

      expect(shortOnly).toEqual(all.filter((draft) => draft.horizon === 'SHORT'));
      expect(shortOnly.length).toBeGreaterThan(0);
      expect(shortOnly.every((draft) => draft.periodDays === null)).toBe(true);
      // 短期を持つ観点だけ（短期を持たない観点は、結果がない）
      expect(
        shortOnly.every((draft) => getViewpointDefinition(draft.viewpointId).hasShortHorizon),
      ).toBe(true);
      expect(
        new Set(shortOnly.map((draft) => draft.evaluation.status)).size,
      ).toBeGreaterThanOrEqual(2);
    },
  );

  it('指定がなければ、すべての視点（短期・長期）を評価する。長期だけの指定は、長期だけ', () => {
    const observations = generate(7, 300, 40);

    const all = evaluateScope(inputOf(observations));
    const longOnly = evaluateScope({ ...inputOf(observations), horizons: ['LONG'] });

    expect(new Set(all.map((draft) => draft.horizon))).toEqual(new Set(['SHORT', 'LONG']));
    expect(longOnly).toEqual(all.filter((draft) => draft.horizon === 'LONG'));
  });

  it.each([1, 2, 3, 4, 5, 6])(
    '短期の評価は、直近 7 日の観測値と、7 日より前の累積の基準だけで、全期間を読んだときと同じ結果になる（観測値が 7 日の中。データセット %i）',
    (seed) => {
      // 観測値は、直近 6 日の中（累積の基準が、すべて、読んだ範囲の中の、取得元ごとの値になる）
      const observations = generate(seed, 800, 6);
      const cutoff = new Date(NOW.getTime() - CURRENT_EVALUATION_READ_DAYS * 24 * MS_PER_HOUR);
      const within = observations.filter((item) => Date.parse(item.observedAt) >= cutoff.getTime());

      const fromFullRead = evaluateScope({ ...inputOf(observations), horizons: ['SHORT'] });
      const fromShortRead = evaluateScope({
        ...inputOf(within),
        baselineObservations: latestBefore(observations, cutoff),
        horizons: ['SHORT'],
      });

      expect(fromShortRead).toEqual(fromFullRead);
    },
  );

  it.each([1, 2, 3, 4, 5, 6])(
    '観測値が 7 日より前にもあるとき、7 日の範囲の中の観測値だけが、短期の窓に入る（短期の窓は、直近 24 時間のまま。データセット %i）',
    (seed) => {
      const observations = generate(seed, 800, 40);
      const cutoff = new Date(NOW.getTime() - CURRENT_EVALUATION_READ_DAYS * 24 * MS_PER_HOUR);
      const within = observations.filter((item) => Date.parse(item.observedAt) >= cutoff.getTime());

      const shortRead = evaluateScope({
        ...inputOf(within),
        baselineObservations: latestBefore(observations, cutoff),
        horizons: ['SHORT'],
      });

      // 判定の対象期間は、直近 24 時間
      expect(
        shortRead.every(
          (draft) =>
            draft.evaluatedTo.getTime() - draft.evaluatedFrom.getTime() === 24 * MS_PER_HOUR,
        ),
      ).toBe(true);
      expect(shortRead.length).toBeGreaterThan(0);
    },
  );
});
