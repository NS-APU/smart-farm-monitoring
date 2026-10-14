/**
 * 参照（Query）: ダッシュボード（UC-01。FR-6.1〜6.3, 6.6, 6.7）。
 * 保存済みの最新の評価結果を読むだけで、この呼び出しでは評価しない（NFR-3.4）。
 */

import type { Horizon, PeriodDays } from '@smart-farm/shared/constants/status';
import {
  viewpointsForEquipmentType,
  type ViewpointMeta,
} from '@smart-farm/shared/constants/viewpoints';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type {
  DashboardResponse,
  DataFreshness,
  EvaluationResult,
  ViewpointCard,
} from '@smart-farm/shared/schemas/evaluation';
import { MS_PER_MINUTE, toIsoOrNull } from '@smart-farm/shared/time';
import { combineHorizonStatuses } from '../../domain/evaluation/grading.ts';
import { UNKNOWN_ACTION } from '../../domain/evaluation/messages.ts';
import { getViewpointDefinition } from '../../domain/evaluation/viewpoints/registry.ts';
import { resolveEvaluationScope } from '../evaluation/scope.ts';
import type { IngestionSettings } from '../ingestion/ingestion-settings.ts';
import { requireActiveEquipment } from '../equipment/require-active-equipment.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { Repositories } from '../ports/repositories.ts';
import type { AppSettings } from '../settings.ts';
import { findHorizonResults, selectDisplayedResult } from './evaluation-selection.ts';

export interface DashboardParams {
  readonly equipmentId: EquipmentId;
  readonly horizon: Horizon;
  readonly periodDays: PeriodDays;
}

export interface DashboardQuery {
  get(params: DashboardParams): Promise<DashboardResponse>;
}

export interface DashboardQueryDeps {
  readonly repositories: Pick<Repositories, 'equipment' | 'observations' | 'evaluations'>;
  readonly ingestionSettings: IngestionSettings;
  readonly settings: Pick<AppSettings, 'defaultIngestionIntervalMinutes' | 'staleAfterIntervals'>;
  readonly clock: ClockPort;
}

const NOT_EVALUATED_MESSAGE = '評価がまだ行われていません';

/** 評価がまだない観点のカード（長期の結果がない）。 */
function buildUnevaluatedCard(meta: ViewpointMeta): ViewpointCard {
  return {
    viewpointId: meta.id,
    name: meta.name,
    status: 'UNKNOWN',
    statuses: { short: null, long: 'UNKNOWN' },
    metrics: {},
    metricStatuses: {},
    statusDetail: null,
    diagnosticMessage: `${meta.name}: ${NOT_EVALUATED_MESSAGE}`,
    recommendedAction: UNKNOWN_ACTION,
    evaluatedFrom: null,
    evaluatedTo: null,
    isCustomCriteria: false,
    horizonUsed: 'LONG',
  };
}

/** 観点のカード。主要メトリクスは、表示する視点（短期または長期）の結果から取る。 */
function buildCard(
  meta: ViewpointMeta,
  latest: readonly EvaluationResult[],
  params: DashboardParams,
): ViewpointCard {
  const definition = getViewpointDefinition(meta.id);
  const { shortResult, longResult } = findHorizonResults(latest, definition, params.periodDays);
  if (longResult === undefined) {
    return buildUnevaluatedCard(meta);
  }
  const { display, horizonUsed } = selectDisplayedResult(params.horizon, shortResult, longResult);
  return {
    viewpointId: meta.id,
    name: meta.name,
    status: combineHorizonStatuses(shortResult?.status ?? null, longResult.status),
    statuses: { short: shortResult?.status ?? null, long: longResult.status },
    metrics: Object.fromEntries(
      definition.dashboardMetrics.map((metricId) => [metricId, display.metrics[metricId] ?? null]),
    ),
    metricStatuses: Object.fromEntries(
      definition.dashboardMetrics.flatMap((metricId) => {
        const status = display.indicatorStatuses[metricId];
        return status === undefined ? [] : [[metricId, status]];
      }),
    ),
    statusDetail: display.statusDetail,
    diagnosticMessage: display.diagnosticMessage,
    recommendedAction: display.recommendedAction,
    evaluatedFrom: display.evaluatedFrom,
    evaluatedTo: display.evaluatedTo,
    isCustomCriteria: display.isCustomCriteria,
    horizonUsed,
  };
}

/** 観点のカードを、最終ステータスごとに数える。 */
function summarize(cards: readonly ViewpointCard[]): DashboardResponse['summary'] {
  const summary = { NORMAL: 0, CAUTION: 0, ERROR: 0, UNKNOWN: 0 };
  for (const card of cards) {
    summary[card.status] += 1;
  }
  return summary;
}

/** 最終の受信日時から、データの新しさを判定する（基準を超えて古ければ STALE）。 */
function classifyFreshness(
  lastReceived: Date | null,
  now: Date,
  thresholdMinutes: number,
): DataFreshness {
  if (lastReceived === null) {
    return 'NONE';
  }
  return now.getTime() - lastReceived.getTime() > thresholdMinutes * MS_PER_MINUTE
    ? 'STALE'
    : 'FRESH';
}

export function createDashboardQuery(deps: DashboardQueryDeps): DashboardQuery {
  const { repositories, ingestionSettings, settings, clock } = deps;

  /** 「データが古い」とみなす基準（分）= 最短の取得間隔 × 設定の倍数（暫定。FR-6.3）。 */
  async function staleThresholdMinutes(): Promise<number> {
    const sources = (await ingestionSettings.listSources()).filter((source) => source.isEnabled);
    const interval =
      sources.length === 0
        ? settings.defaultIngestionIntervalMinutes
        : Math.min(...sources.map((source) => source.intervalMinutes));
    return interval * settings.staleAfterIntervals;
  }

  return {
    async get(params) {
      const equipment = await requireActiveEquipment(repositories.equipment, params.equipmentId);
      const allEquipment = await repositories.equipment.list();
      const scope = resolveEvaluationScope(equipment, allEquipment);
      const latest = await repositories.evaluations.listLatest(params.equipmentId);
      const now = clock.now();

      const cards = viewpointsForEquipmentType(equipment.equipmentType).map((meta) =>
        buildCard(meta, latest, params),
      );
      const evaluatedAt =
        latest
          .map((result) => result.evaluatedAt)
          .sort()
          .at(-1) ?? null;
      // データの新しさは、ロボット・センサーからの自動取り込みで判定する（手動入力で、供給の停止が隠れないように。V-024）
      const lastReceived = await repositories.observations.latestReceivedAt(scope.equipmentIds, {
        autoImportOnly: true,
      });
      const thresholdMinutes = await staleThresholdMinutes();

      return {
        equipmentId: params.equipmentId,
        horizon: params.horizon,
        periodDays: params.periodDays,
        evaluatedAt,
        lastReceivedAt: toIsoOrNull(lastReceived),
        dataFreshness: classifyFreshness(lastReceived, now, thresholdMinutes),
        staleThresholdMinutes: thresholdMinutes,
        summary: summarize(cards),
        viewpoints: cards,
      };
    },
  };
}
