/**
 * 評価の運用面の観点（データ活用度合い・満足度）。docs/10_design/viewpoint/operation-health.md に従う。
 * 「全データ数」（データ活用度合い）の定義は未確定のため、暫定の定義を dev_spec.md 4章に置く。
 */

import { satisfactionItemKey } from '@smart-farm/shared/constants/items';
import { OVERALL_SATISFACTION_METRIC_ID } from '@smart-farm/shared/constants/metrics';
import { SATISFACTION_TARGET_VIEWPOINT_IDS } from '@smart-farm/shared/constants/viewpoints';
import { defineViewpoint } from '../definition.ts';
import { normalizeMetric, percentOrNull, roundTo } from '../numbers.ts';
import { optionalValue, passThrough, pickAll } from './helpers.ts';

export const dataUtilization = defineViewpoint({
  id: 'dataUtilization',
  // 取得できたデータの割合は、一定の期間で見る指標のため、短期評価を持たない（Q-009 の暫定）
  hasShortHorizon: false,
  judgedIndicators: ['dataCoveragePercent'],
  usesStatusIndicator: false,
  allowsPartialJudgement: false,
  requiredInputs: ['totalDataCount'],
  detailMetrics: [
    'dataCoveragePercent',
    'robotDataCount',
    'sensorDataCount',
    'manualDataCount',
    'totalDataCount',
  ],
  attentionAction: '取り込みの失敗や入力の漏れを確認し、データを補ってください',
  computeMetrics(values) {
    const picked = pickAll(values, [
      'robotDataCount',
      'sensorDataCount',
      'manualDataCount',
      'totalDataCount',
    ]);
    return {
      dataCoveragePercent:
        picked === null
          ? null
          : percentOrNull(
              picked.robotDataCount + picked.sensorDataCount + picked.manualDataCount,
              picked.totalDataCount,
            ),
      ...passThrough(values, [
        'robotDataCount',
        'sensorDataCount',
        'manualDataCount',
        'totalDataCount',
      ]),
    };
  },
});

const SATISFACTION_KEYS = SATISFACTION_TARGET_VIEWPOINT_IDS.map(satisfactionItemKey);

function overallSatisfaction(picked: Readonly<Record<string, number>>): number {
  // picked には SATISFACTION_KEYS の値だけが入っている（pickAll の保証）
  const total = Object.values(picked).reduce((sum, value) => sum + value, 0);
  return normalizeMetric(roundTo(total / SATISFACTION_KEYS.length, 1));
}

export const satisfaction = defineViewpoint({
  id: 'satisfaction',
  // 満足度は、一定の期間のアンケート的な入力のため、短期評価を持たない（Q-009 の暫定）
  hasShortHorizon: false,
  judgedIndicators: [OVERALL_SATISFACTION_METRIC_ID],
  usesStatusIndicator: false,
  allowsPartialJudgement: false,
  requiredInputs: SATISFACTION_KEYS,
  detailMetrics: [OVERALL_SATISFACTION_METRIC_ID, ...SATISFACTION_KEYS],
  attentionAction: '満足度の低い観点について、農作業者から所感を聞き取り、改善につなげてください',
  computeMetrics(values) {
    const picked = pickAll(values, SATISFACTION_KEYS);
    const metrics: Record<string, number | null> = {};
    for (const key of SATISFACTION_KEYS) {
      metrics[key] = optionalValue(values, key);
    }
    // 総合満足度 = 9観点のスター評価の平均（小数第1位に丸める）
    metrics[OVERALL_SATISFACTION_METRIC_ID] = picked === null ? null : overallSatisfaction(picked);
    return metrics;
  },
});
