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

/** 指標ごとの判定と、最終ステータスを決めるための材料（メトリクスと判断基準から求める）。 */
interface MetricJudgement {
  readonly indicatorStatuses: Record<string, EvaluationStatus>;
  readonly judgements: JudgedStatus[];
  readonly details: string[];
  readonly uncomputable: string[];
  readonly unconfigured: string[];
}

/**
 * メトリクス・ステータスコードのカテゴリ・判断基準から、指標ごとの判定を求める。評価（`evaluateHorizon`）と、
 * 保存済みの結果の再判定（`rejudgeStatus`。判断基準の影響のプレビュー）が、同じ判定になるように、ここに 1 か所だけ置く。
 */
function judgeMetrics(
  definition: ViewpointDefinition,
  metrics: MetricValueMap,
  status: StatusDetail | null,
  criteria: ViewpointCriteria,
): MetricJudgement {
  const judgement: MetricJudgement = {
    indicatorStatuses: {},
    judgements: [],
    details: [],
    uncomputable: [],
    unconfigured: [],
  };
  for (const indicator of definition.judgedIndicators) {
    const criterion = criteria.criteria.find((candidate) => candidate.indicator === indicator);
    const value = metrics[indicator] ?? null;
    if (criterion === undefined) {
      judgement.unconfigured.push(getMetricMeta(indicator).label);
      judgement.indicatorStatuses[indicator] = 'UNKNOWN';
    } else if (value === null) {
      if (!definition.allowsPartialJudgement) {
        judgement.uncomputable.push(getMetricMeta(indicator).label);
      }
      judgement.indicatorStatuses[indicator] = 'UNKNOWN';
    } else {
      const judged = judgeByCriterion(criterion, value);
      judgement.indicatorStatuses[indicator] = judged;
      judgement.judgements.push(judged);
      judgement.details.push(
        `${criterion.label} ${formatMetricValue(indicator, value)}（${STATUS_LABELS[judged]}）`,
      );
    }
  }

  if (definition.usesStatusIndicator && status !== null) {
    judgement.indicatorStatuses[STATUS_INDICATOR_ID] = status.category;
    judgement.judgements.push(status.category);
    judgement.details.push(`ステータス ${status.name}（${STATUS_LABELS[status.category]}）`);
  }
  return judgement;
}

/** 指標ごとの判定から、最終ステータス（判定できなければ、「不明」の理由）を決める。 */
function decideOutcome(
  judgement: MetricJudgement,
): { readonly worst: JudgedStatus } | { readonly reason: string } {
  if (judgement.unconfigured.length > 0) {
    return { reason: `判断基準が未設定の指標: ${judgement.unconfigured.join('、')}` };
  }
  if (judgement.uncomputable.length > 0) {
    return {
      reason: `算出できない指標: ${judgement.uncomputable.join('、')}（収穫数や稼働時間が 0 などのため）`,
    };
  }
  const worst = worstJudgedStatus(judgement.judgements);
  return worst === null ? { reason: '観測値が1つも取得できていません' } : { worst };
}

/** 1つの視点（短期または長期）の評価。 */
export function evaluateHorizon(input: HorizonEvaluationInput): HorizonEvaluation {
  const { definition, measures, criteria } = input;
  const isCustomCriteria = !criteria.isDefault;
  const metrics = definition.computeMetrics(measures.values);

  const missingInputs = findMissingInputs(definition, measures);
  if (missingInputs.length > 0) {
    const reason = `未取得の項目: ${missingInputs.map(labelOfInput).join('、')}`;
    return unknownResult(definition, measures, metrics, {}, reason, isCustomCriteria);
  }

  const judgement = judgeMetrics(definition, metrics, measures.status, criteria);
  const outcome = decideOutcome(judgement);
  if ('reason' in outcome) {
    return unknownResult(
      definition,
      measures,
      metrics,
      judgement.indicatorStatuses,
      outcome.reason,
      isCustomCriteria,
    );
  }

  return {
    status: outcome.worst,
    metrics,
    indicatorStatuses: judgement.indicatorStatuses,
    statusDetail: definition.usesStatusIndicator ? measures.status : null,
    diagnosticMessage: buildDiagnosticMessage({
      viewpointId: definition.id,
      status: outcome.worst,
      reason: '',
      details: judgement.details,
      isCustomCriteria,
    }),
    recommendedAction: buildRecommendedAction(definition, outcome.worst),
  };
}

export interface RejudgeInput {
  readonly definition: ViewpointDefinition;
  /** 保存済みの結果の、ステータス・メトリクス・ステータスコードのカテゴリ。 */
  readonly status: EvaluationStatus;
  readonly metrics: MetricValueMap;
  readonly statusDetail: StatusDetail | null;
  /** 当てる判断基準（現在の基準、または入力途中の基準）。 */
  readonly criteria: ViewpointCriteria;
}

/**
 * 保存済みの評価結果（観測値は読まない）に、判断基準を当てて、ステータスを求め直す（判断基準の影響のプレビュー。SC-13-2）。
 * 「不明」の結果は、未取得・算出できない・観測値がないといった、判断基準によらない理由のため、「不明」のまま（再判定の対象外）。
 * それ以外は、評価と同じ判定（`judgeMetrics`）を、保存済みのメトリクスに当てる。
 */
export function rejudgeStatus(input: RejudgeInput): EvaluationStatus {
  if (input.status === 'UNKNOWN') {
    return 'UNKNOWN';
  }
  const outcome = decideOutcome(
    judgeMetrics(input.definition, input.metrics, input.statusDetail, input.criteria),
  );
  return 'worst' in outcome ? outcome.worst : 'UNKNOWN';
}
