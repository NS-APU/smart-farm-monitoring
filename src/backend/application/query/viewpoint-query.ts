/**
 * 参照（Query）: 観点の詳細（UC-02・UC-04・UC-21。SC-03・SC-04）と、メトリクス・ステータスの推移（UC-03）。
 * - 詳細: 保存済みの最新の評価結果を読むだけで、この呼び出しでは評価しない（NFR-3.4）
 * - 推移: 観測値から、評価と同じ集計・算出式で、区間ごとのメトリクスを求める。ステータスの推移は、
 *   評価の状態変化の履歴から返す（architecture.md 4.3。FR-6.10）
 */

import { AppError } from '@smart-farm/shared/errors';
import { satisfactionItemKey } from '@smart-farm/shared/constants/items';
import type { Horizon, PeriodDays } from '@smart-farm/shared/constants/status';
import {
  SATISFACTION_TARGET_VIEWPOINT_IDS,
  findViewpointMeta,
  viewpointsForEquipmentType,
  type ViewpointMeta,
} from '@smart-farm/shared/constants/viewpoints';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type {
  EvaluationResult,
  HorizonDiagnosis,
  MetricRow,
  RadarPoint,
  SeriesResponse,
  ViewpointDetailResponse,
} from '@smart-farm/shared/schemas/evaluation';
import { JST_OFFSET_MINUTES } from '@smart-farm/shared/time';
import { combineHorizonStatuses } from '../../domain/evaluation/grading.ts';
import type { ViewpointDefinition } from '../../domain/evaluation/definition.ts';
import { computeMetricSeries, planBuckets } from '../../domain/evaluation/series.ts';
import { getViewpointDefinition } from '../../domain/evaluation/viewpoints/registry.ts';
import { requireActiveEquipment } from '../equipment/require-active-equipment.ts';
import type { CriteriaService } from '../evaluation/criteria-service.ts';
import { resolveEvaluationScope } from '../evaluation/scope.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { Repositories } from '../ports/repositories.ts';
import type { AppSettings } from '../settings.ts';
import { findHorizonResults, selectDisplayedResult } from './evaluation-selection.ts';

export interface ViewpointQueryParams {
  readonly equipmentId: EquipmentId;
  readonly viewpointId: string;
  readonly horizon: Horizon;
  readonly periodDays: PeriodDays;
}

export interface ViewpointQuery {
  detail(params: ViewpointQueryParams): Promise<ViewpointDetailResponse>;
  series(params: ViewpointQueryParams): Promise<SeriesResponse>;
}

export interface ViewpointQueryDeps {
  readonly repositories: Pick<
    Repositories,
    'equipment' | 'evaluations' | 'observations' | 'statusCodes'
  >;
  readonly criteria: CriteriaService;
  readonly settings: Pick<AppSettings, 'defaultIngestionIntervalMinutes'>;
  readonly clock: ClockPort;
}

interface Target {
  readonly equipment: Equipment;
  readonly allEquipment: readonly Equipment[];
  readonly meta: ViewpointMeta;
  readonly definition: ViewpointDefinition;
}

function toDiagnosis(result: EvaluationResult): HorizonDiagnosis {
  return {
    horizon: result.horizon,
    periodDays: result.periodDays,
    status: result.status,
    diagnosticMessage: result.diagnosticMessage,
    recommendedAction: result.recommendedAction,
    statusDetail: result.statusDetail,
    isCustomCriteria: result.isCustomCriteria,
    criteriaVersion: result.criteriaVersion,
    evaluatedFrom: result.evaluatedFrom,
    evaluatedTo: result.evaluatedTo,
    evaluatedAt: result.evaluatedAt,
  };
}

/** 満足度のレーダーチャートの軸（満足度以外の9観点。未入力は null）。 */
function radarOf(display: EvaluationResult | undefined): RadarPoint[] {
  return SATISFACTION_TARGET_VIEWPOINT_IDS.map((viewpointId) => ({
    viewpointId,
    name: findViewpointMeta(viewpointId)?.name ?? viewpointId,
    score: display?.metrics[satisfactionItemKey(viewpointId)] ?? null,
  }));
}

export function createViewpointQuery(deps: ViewpointQueryDeps): ViewpointQuery {
  const { repositories, criteria, settings, clock } = deps;

  /** 設備と観点を確認する。存在しない設備・観点、その設備では評価しない観点は、NOT_FOUND。 */
  async function resolveTarget(params: ViewpointQueryParams): Promise<Target> {
    const equipment = await requireActiveEquipment(repositories.equipment, params.equipmentId);
    const meta = findViewpointMeta(params.viewpointId);
    if (meta === undefined) {
      throw new AppError('NOT_FOUND', '観点が見つかりません');
    }
    if (!viewpointsForEquipmentType(equipment.equipmentType).some((item) => item.id === meta.id)) {
      throw new AppError('NOT_FOUND', 'この設備では評価しない観点です');
    }
    return {
      equipment,
      allEquipment: await repositories.equipment.list(),
      meta,
      definition: getViewpointDefinition(meta.id),
    };
  }

  return {
    async detail(params) {
      const { meta, definition } = await resolveTarget(params);
      const latest = await repositories.evaluations.listLatest(params.equipmentId);
      const { shortResult, longResult } = findHorizonResults(latest, definition, params.periodDays);
      const { display, horizonUsed } = selectDisplayedResult(
        params.horizon,
        shortResult,
        longResult,
      );

      const metrics: MetricRow[] = definition.detailMetrics.map((metricId) => ({
        metricId,
        value: display?.metrics[metricId] ?? null,
        indicatorStatus: display?.indicatorStatuses[metricId] ?? null,
        isPrimary: definition.dashboardMetrics.includes(metricId),
      }));

      return {
        equipmentId: params.equipmentId,
        viewpointId: meta.id,
        name: meta.name,
        horizon: params.horizon,
        periodDays: params.periodDays,
        horizonUsed,
        hasShortHorizon: definition.hasShortHorizon,
        status:
          longResult === undefined
            ? 'UNKNOWN'
            : combineHorizonStatuses(shortResult?.status ?? null, longResult.status),
        isEvaluated: longResult !== undefined,
        short: shortResult === undefined ? null : toDiagnosis(shortResult),
        long: longResult === undefined ? null : toDiagnosis(longResult),
        selected: display === undefined ? null : toDiagnosis(display),
        metrics,
        criteria: await criteria.getEffective(meta.id),
        usesStatusIndicator: definition.usesStatusIndicator,
        radar: meta.id === 'satisfaction' ? radarOf(display) : null,
      };
    },

    async series(params) {
      const { equipment, allEquipment, meta, definition } = await resolveTarget(params);
      const horizonUsed: Horizon =
        params.horizon === 'SHORT' && definition.hasShortHorizon ? 'SHORT' : 'LONG';
      const periodDays = horizonUsed === 'SHORT' ? null : params.periodDays;
      const now = clock.now();
      const scope = resolveEvaluationScope(equipment, allEquipment);

      const plan = planBuckets(now, horizonUsed, periodDays, JST_OFFSET_MINUTES);
      const from = plan.starts[0] ?? now;
      const observations = await repositories.observations.findForEvaluation(
        scope.equipmentIds,
        from,
        now,
      );
      const statusCodeList = await repositories.statusCodes.list({ includeDeleted: true });
      const result = computeMetricSeries({
        definition,
        observations,
        now,
        horizon: horizonUsed,
        periodDays,
        statusCodes: new Map(statusCodeList.map((code) => [code.code, code])),
        expectedStreams: scope.expectedStreams,
        coverageSlotMinutes: settings.defaultIngestionIntervalMinutes,
        timeZoneOffsetMinutes: JST_OFFSET_MINUTES,
      });

      const history = await repositories.evaluations.listStatusChanges(params.equipmentId, meta.id);
      const fromIso = result.from.toISOString();
      const initial = history.filter((entry) => entry.changedAt < fromIso).at(-1)?.status ?? null;
      const latest = await repositories.evaluations.listLatest(params.equipmentId);
      const { shortResult, longResult } = findHorizonResults(latest, definition, params.periodDays);

      return {
        equipmentId: params.equipmentId,
        viewpointId: meta.id,
        horizon: params.horizon,
        horizonUsed,
        periodDays,
        hasShortHorizon: definition.hasShortHorizon,
        bucket: result.bucket,
        from: fromIso,
        to: now.toISOString(),
        metrics: result.metrics,
        statusHistory: {
          initial,
          changes: history
            .filter((entry) => entry.changedAt >= fromIso)
            .map((entry) => ({ changedAt: entry.changedAt, status: entry.status })),
        },
        feedback: {
          short: shortResult === undefined ? null : toDiagnosis(shortResult),
          long: longResult === undefined ? null : toDiagnosis(longResult),
        },
      };
    },
  };
}
