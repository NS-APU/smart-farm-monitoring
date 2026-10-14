/**
 * 保存済みの評価結果から、観点ごとの結果を選ぶ規則（ダッシュボード・観点の詳細で共通）。
 * 短期は期間を持たず（periodDays が null）、長期は選択した期間の結果を使う。
 */

import type { Horizon, PeriodDays } from '@smart-farm/shared/constants/status';
import type { ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import type { EvaluationResult } from '@smart-farm/shared/schemas/evaluation';
import type { ViewpointDefinition } from '../../domain/evaluation/definition.ts';

export function findResult(
  results: readonly EvaluationResult[],
  viewpointId: ViewpointId,
  horizon: Horizon,
  periodDays: PeriodDays | null,
): EvaluationResult | undefined {
  return results.find(
    (result) =>
      result.viewpointId === viewpointId &&
      result.horizon === horizon &&
      result.periodDays === periodDays,
  );
}

/** 観点の短期・長期（選択した期間）の最新の結果。短期を持たない観点の短期は undefined。 */
export function findHorizonResults(
  results: readonly EvaluationResult[],
  definition: Pick<ViewpointDefinition, 'id' | 'hasShortHorizon'>,
  periodDays: PeriodDays,
): {
  readonly shortResult: EvaluationResult | undefined;
  readonly longResult: EvaluationResult | undefined;
} {
  return {
    shortResult: definition.hasShortHorizon
      ? findResult(results, definition.id, 'SHORT', null)
      : undefined,
    longResult: findResult(results, definition.id, 'LONG', periodDays),
  };
}

/** 画面に示す結果。短期を選び、かつ短期の結果がある場合だけ短期、それ以外は長期。 */
export function selectDisplayedResult<Long extends EvaluationResult | undefined>(
  horizon: Horizon,
  shortResult: EvaluationResult | undefined,
  longResult: Long,
): { readonly display: EvaluationResult | Long; readonly horizonUsed: Horizon } {
  const useShort = horizon === 'SHORT' && shortResult !== undefined;
  return useShort
    ? { display: shortResult, horizonUsed: 'SHORT' }
    : { display: longResult, horizonUsed: 'LONG' };
}
