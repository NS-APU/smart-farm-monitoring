/**
 * 評価エンジン（ドメイン層の純粋関数）。
 * 「集計済みの入力・判断基準 → ステータス・診断メッセージ・推奨アクション」を、
 * 外部（DB・時刻・ネットワーク）に依存せず計算する（architecture.md 7章）。
 *
 * 判定のルール（evaluation.md）:
 * - 複数の指標は、最も悪い判定を最終ステータスとする
 * - 判定に必要なデータが未取得、または算出できない（分母が 0）場合は「不明」
 * - 一部の指標だけ取得できていれば、取得できた指標だけで判定する観点（環境適応性）がある
 */

import {
  STATUS_INDICATOR_ID,
  formatMetricValue,
  getMetricMeta,
} from '@smart-farm/shared/constants/metrics';
import {
  STATUS_LABELS,
  type EvaluationStatus,
  type JudgedStatus,
} from '@smart-farm/shared/constants/status';
import type { ViewpointCriteria } from '@smart-farm/shared/schemas/criteria';
import type { StatusDetail } from '@smart-farm/shared/schemas/evaluation';
import { STATUS_CODE_ITEM_KEY, findItemDefinition } from '@smart-farm/shared/constants/items';
import { type Measures, type MetricValueMap, type ViewpointDefinition } from './definition.ts';
import { judgeByCriterion, worstJudgedStatus } from './grading.ts';
import { buildDiagnosticMessage, buildRecommendedAction } from './messages.ts';

export interface HorizonEvaluationInput {
  readonly definition: ViewpointDefinition;
  readonly measures: Measures;
  /** 判定に使う判断基準（既定値、または変更後）。 */
  readonly criteria: ViewpointCriteria;
}

export interface HorizonEvaluation {
  readonly status: EvaluationStatus;
  readonly metrics: MetricValueMap;
  readonly indicatorStatuses: Readonly<Record<string, EvaluationStatus>>;
  readonly statusDetail: StatusDetail | null;
  readonly diagnosticMessage: string;
  readonly recommendedAction: string;
}

function labelOfInput(inputKey: string): string {
  if (inputKey === STATUS_CODE_ITEM_KEY) {
    return getMetricMeta(STATUS_INDICATOR_ID).label;
  }
  return findItemDefinition(inputKey)?.label ?? inputKey;
}

function findMissingInputs(definition: ViewpointDefinition, measures: Measures): string[] {
  return definition.requiredInputs.filter((inputKey) =>
    inputKey === STATUS_CODE_ITEM_KEY
      ? measures.status === null
      : measures.values[inputKey] === undefined,
  );
}

function unknownResult(
  definition: ViewpointDefinition,
  measures: Measures,
  metrics: MetricValueMap,
  indicatorStatuses: Record<string, EvaluationStatus>,
  reason: string,
  isCustomCriteria: boolean,
): HorizonEvaluation {
  return {
    status: 'UNKNOWN',
    metrics,
    indicatorStatuses,
    statusDetail: definition.usesStatusIndicator ? measures.status : null,
    diagnosticMessage: buildDiagnosticMessage({
      viewpointId: definition.id,
      status: 'UNKNOWN',
      reason,
      details: [],
      isCustomCriteria,
    }),
    recommendedAction: buildRecommendedAction(definition, 'UNKNOWN'),
  };
}

/** 1つの視点（短期または長期）の評価。 */
export function evaluateHorizon(input: HorizonEvaluationInput): HorizonEvaluation {
  const { definition, measures, criteria } = input;
  const isCustomCriteria = !criteria.isDefault;
  const metrics = definition.computeMetrics(measures.values);
  const indicatorStatuses: Record<string, EvaluationStatus> = {};
  /** 理由だけを変えて、「不明」の結果を返す。 */
  const unknown = (reason: string): HorizonEvaluation =>
    unknownResult(definition, measures, metrics, indicatorStatuses, reason, isCustomCriteria);

  const missingInputs = findMissingInputs(definition, measures);
  if (missingInputs.length > 0) {
    const reason = `未取得の項目: ${missingInputs.map(labelOfInput).join('、')}`;
    return unknown(reason);
  }

  const judgements: JudgedStatus[] = [];
  const details: string[] = [];
  const uncomputable: string[] = [];
  const unconfigured: string[] = [];

  for (const indicator of definition.judgedIndicators) {
    const criterion = criteria.criteria.find((candidate) => candidate.indicator === indicator);
    const value = metrics[indicator] ?? null;
    if (criterion === undefined) {
      unconfigured.push(getMetricMeta(indicator).label);
      indicatorStatuses[indicator] = 'UNKNOWN';
    } else if (value === null) {
      if (!definition.allowsPartialJudgement) {
        uncomputable.push(getMetricMeta(indicator).label);
      }
      indicatorStatuses[indicator] = 'UNKNOWN';
    } else {
      const status = judgeByCriterion(criterion, value);
      indicatorStatuses[indicator] = status;
      judgements.push(status);
      details.push(
        `${criterion.label} ${formatMetricValue(indicator, value)}（${STATUS_LABELS[status]}）`,
      );
    }
  }

  if (definition.usesStatusIndicator && measures.status !== null) {
    indicatorStatuses[STATUS_INDICATOR_ID] = measures.status.category;
    judgements.push(measures.status.category);
    details.push(
      `ステータス ${measures.status.name}（${STATUS_LABELS[measures.status.category]}）`,
    );
  }

  if (unconfigured.length > 0) {
    const reason = `判断基準が未設定の指標: ${unconfigured.join('、')}`;
    return unknown(reason);
  }
  if (uncomputable.length > 0) {
    const reason = `算出できない指標: ${uncomputable.join('、')}（収穫数や稼働時間が 0 などのため）`;
    return unknown(reason);
  }

  const worst = worstJudgedStatus(judgements);
  if (worst === null) {
    return unknown('観測値が1つも取得できていません');
  }

  return {
    status: worst,
    metrics,
    indicatorStatuses,
    statusDetail: definition.usesStatusIndicator ? measures.status : null,
    diagnosticMessage: buildDiagnosticMessage({
      viewpointId: definition.id,
      status: worst,
      reason: '',
      details,
      isCustomCriteria,
    }),
    recommendedAction: buildRecommendedAction(definition, worst),
  };
}
