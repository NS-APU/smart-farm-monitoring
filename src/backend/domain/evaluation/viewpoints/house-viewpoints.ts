/**
 * ハウスの健全性の観点（環境適応性）。docs/10_design/viewpoint/house-health.md に従う。
 * 温度・湿度・照度・CO2濃度の値を、メトリクスの算出なしで、そのまま判断基準に当てる。
 */

import { defineViewpoint } from '../definition.ts';
import { passThrough } from './helpers.ts';

const ENVIRONMENT_ITEMS = [
  'temperatureCelsius',
  'humidityPercent',
  'illuminanceLux',
  'co2Ppm',
] as const;

export const environmentalAdaptability = defineViewpoint({
  id: 'environmentalAdaptability',
  hasShortHorizon: true,
  judgedIndicators: ENVIRONMENT_ITEMS,
  usesStatusIndicator: false,
  // 一部の指標のみ取得できている場合は、取得できた指標だけで判定する（evaluation.md 4章）
  allowsPartialJudgement: true,
  requiredInputs: [],
  detailMetrics: ENVIRONMENT_ITEMS,
  attentionAction:
    'ハウスの環境を現場で確認し、調整してください（本システムは環境を自動では制御しません）',
  computeMetrics(values) {
    return {
      ...passThrough(values, ['temperatureCelsius', 'humidityPercent', 'illuminanceLux', 'co2Ppm']),
    };
  },
});
