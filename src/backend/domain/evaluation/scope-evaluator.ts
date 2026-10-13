/**
 * 評価の単位（設備のまとまり）の全観点・全視点の評価（純粋関数）。
 * 短期視点・長期視点（当日〜90日）の窓を決め、観点ごとに集計 → 判定 → メッセージ付与までを行う。
 * 入力（観測値・判断基準・時刻）はアプリケーション層が渡す。
 */

import {
  PERIOD_DAYS_OPTIONS,
  type Horizon,
  type PeriodDays,
} from '@smart-farm/shared/constants/status';
import type { ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import type { ViewpointCriteria } from '@smart-farm/shared/schemas/criteria';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import type { StatusCodeDefinition } from '@smart-farm/shared/schemas/status-code';
import { MS_PER_HOUR } from '@smart-farm/shared/time';
import { evaluateHorizon, type HorizonEvaluation } from './engine.ts';
import type { Measures } from './definition.ts';
import { aggregateMeasures, type ExpectedStreams } from './measures.ts';
import { getViewpointDefinition } from './viewpoints/registry.ts';

/** 短期視点の対象期間（直近の時間）。短期の定義は未確定（Q-009）のため暫定（dev_spec.md 4章）。 */
export const SHORT_HORIZON_HOURS = 24;

export interface ScopeEvaluationInput {
  /** 評価の単位に含まれる設備の観測値（最長の期間の分）。 */
  readonly observations: readonly Observation[];
  readonly now: Date;
  readonly viewpointIds: readonly ViewpointId[];
  readonly criteriaOf: (viewpointId: ViewpointId) => ViewpointCriteria;
  readonly statusCodes: ReadonlyMap<string, StatusCodeDefinition>;
  readonly expectedStreams: ExpectedStreams;
  readonly coverageSlotMinutes: number;
}

export interface EvaluationDraft {
  readonly viewpointId: ViewpointId;
  readonly horizon: Horizon;
  readonly periodDays: PeriodDays | null;
  readonly evaluation: HorizonEvaluation;
  readonly evaluatedFrom: Date;
  readonly evaluatedTo: Date;
  readonly criteriaVersion: string;
  readonly isCustomCriteria: boolean;
}

export function evaluateScope(input: ScopeEvaluationInput): EvaluationDraft[] {
  const drafts: EvaluationDraft[] = [];
  const nowMs = input.now.getTime();
  // 計測日時の解釈は、観測値ごとに1度だけ行う（窓ごと・観点ごとに、全観測値を解釈し直さない。V-072）
  const observedMs = input.observations.map((observation) => Date.parse(observation.observedAt));
  /** 窓（from〜to）の観測値。元の順序を保つ（集計の結果は、窓の外の観測値に影響されない）。 */
  const observationsWithin = (fromMs: number, toMs: number): Observation[] => {
    const within: Observation[] = [];
    for (const [index, observation] of input.observations.entries()) {
      const ms = observedMs[index] ?? Number.NaN;
      if (ms >= fromMs && ms <= toMs) {
        within.push(observation);
      }
    }
    return within;
  };
  // 集計の結果は、観点に依存しない（観測値・視点・窓・設備の構成だけで決まる）。同じ窓は、観点をまたいで共有する（V-072）
  const measuresCache = new Map<string, Measures>();

  for (const viewpointId of input.viewpointIds) {
    const definition = getViewpointDefinition(viewpointId);
    const criteria = input.criteriaOf(viewpointId);
    const windows: { horizon: Horizon; periodDays: PeriodDays | null; hours: number }[] = [];
    if (definition.hasShortHorizon) {
      windows.push({ horizon: 'SHORT', periodDays: null, hours: SHORT_HORIZON_HOURS });
    }
    for (const periodDays of PERIOD_DAYS_OPTIONS) {
      windows.push({ horizon: 'LONG', periodDays, hours: periodDays * 24 });
    }

    for (const window of windows) {
      const from = new Date(nowMs - window.hours * MS_PER_HOUR);
      const cacheKey = `${window.horizon}|${String(window.hours)}`;
      let measures = measuresCache.get(cacheKey);
      if (measures === undefined) {
        measures = aggregateMeasures({
          observations: observationsWithin(from.getTime(), nowMs),
          horizon: window.horizon,
          from,
          to: input.now,
          statusCodes: input.statusCodes,
          expectedStreams: input.expectedStreams,
          coverageSlotMinutes: input.coverageSlotMinutes,
        });
        measuresCache.set(cacheKey, measures);
      }
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
