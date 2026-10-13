/**
 * 閾値判定とステータスの組み合わせ（evaluation.md 3章・5章）。純粋関数。
 * 境界値は「以上」「未満」の記載に従う（例: 5%未満 → 正常、5%以上 → 注意）。
 */

import {
  STATUS_SEVERITY,
  type EvaluationStatus,
  type JudgedStatus,
} from '@smart-farm/shared/constants/status';
import type { Criterion } from '@smart-farm/shared/schemas/criteria';

/** 1つの指標の値を、判断基準で正常／注意／異常に判定する。 */
export function judgeByCriterion(criterion: Criterion, value: number): JudgedStatus {
  switch (criterion.kind) {
    case 'UPPER':
      if (value >= criterion.thresholds.errorFrom) {
        return 'ERROR';
      }
      return value >= criterion.thresholds.cautionFrom ? 'CAUTION' : 'NORMAL';
    case 'LOWER':
      if (value < criterion.thresholds.errorBelow) {
        return 'ERROR';
      }
      return value < criterion.thresholds.cautionBelow ? 'CAUTION' : 'NORMAL';
    case 'RANGE': {
      const { errorLower, normalLower, normalUpper, errorUpper } = criterion.thresholds;
      if (value < errorLower || value >= errorUpper) {
        return 'ERROR';
      }
      return value >= normalLower && value < normalUpper ? 'NORMAL' : 'CAUTION';
    }
  }
}

/** 複数の判定のうち最も悪いものを返す（異常 → 注意 → 正常）。空の場合は null。 */
export function worstJudgedStatus(statuses: readonly JudgedStatus[]): JudgedStatus | null {
  let worst: JudgedStatus | null = null;
  for (const status of statuses) {
    if (worst === null || STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) {
      worst = status;
    }
  }
  return worst;
}

function isJudged(status: EvaluationStatus | null): status is JudgedStatus {
  return status !== null && status !== 'UNKNOWN';
}

/**
 * 短期視点と長期視点から、観点の最終ステータスを決める。
 * 「不明」を除いた悪い方。両方「不明」（または短期なしで長期が「不明」）なら「不明」。
 */
export function combineHorizonStatuses(
  shortStatus: EvaluationStatus | null,
  longStatus: EvaluationStatus,
): EvaluationStatus {
  const judged = [shortStatus, longStatus].filter(isJudged);
  return worstJudgedStatus(judged) ?? 'UNKNOWN';
}
