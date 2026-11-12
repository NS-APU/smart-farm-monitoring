/**
 * 参照（Query）: ダッシュボード（UC-01。FR-6.1〜6.3, 6.6, 6.7）。
 * 保存済みの最新の評価結果を読むだけで、この呼び出しでは評価しない（NFR-3.4）。
 */

import {
  DEFAULT_PERIOD_DAYS,
  type Horizon,
  type PeriodDays,
} from '@smart-farm/shared/constants/status';
import {
  defaultPeriodDays,
  viewpointsForEquipmentType,
  type ViewpointMeta,
} from '@smart-farm/shared/constants/viewpoints';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import { staleThresholdMinutesOf, type Equipment } from '@smart-farm/shared/schemas/equipment';
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
import { isAutoIngestionTarget } from '../ingestion/auto-target.ts';
import type { IngestionSettings } from '../ingestion/ingestion-settings.ts';
import { requireActiveEquipment } from '../equipment/require-active-equipment.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { Repositories } from '../ports/repositories.ts';
import type { AppSettings } from '../settings.ts';
import { findHorizonResults, selectDisplayedResult } from './evaluation-selection.ts';

export interface DashboardParams {
  readonly equipmentId: EquipmentId;
  readonly horizon: Horizon;
  /** 長期の期間。指定しなければ、観点ごとの既定の期間（満足度は 30 日、ほかは 7 日）。 */
  readonly periodDays?: PeriodDays | undefined;
}

export interface DashboardQuery {
  get(params: DashboardParams): Promise<DashboardResponse>;
}

export interface DashboardQueryDeps {
  readonly repositories: Pick<Repositories, 'equipment' | 'observations' | 'evaluations'>;
  readonly ingestionSettings: IngestionSettings;
  readonly settings: Pick<AppSettings, 'staleAfterIntervals'>;
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
  const periodDays = params.periodDays ?? defaultPeriodDays(meta.id);
  const { shortResult, longResult } = findHorizonResults(latest, definition, periodDays);
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

/**
 * データの新しさを、設備ごとに判定する（Issue #198。ADR-0016 の D-12）。設備（ハウスなら配下のロボット・センサー）の、
 * 最終の受信日時が、その設備の基準（取得間隔 × 倍数、最低 3 分）を超えて古ければ、その設備は古い。1 つでも古ければ STALE。
 * まだデータのない設備は、判定しない（どの設備にもデータがなければ、NONE）。
 */
function judgeFreshness(
  members: readonly Equipment[],
  receivedAt: ReadonlyMap<EquipmentId, Date>,
  now: Date,
  multiplier: number,
): {
  readonly freshness: DataFreshness;
  readonly lastReceived: Date | null;
  readonly staleEquipment: DashboardResponse['staleEquipment'];
} {
  const staleEquipment: DashboardResponse['staleEquipment'][number][] = [];
  let lastReceived: Date | null = null;
  let hasData = false;
  for (const member of members) {
    const received = receivedAt.get(member.equipmentId);
    const thresholdMinutes = staleThresholdMinutesOf(member, multiplier);
    if (received === undefined || thresholdMinutes === undefined) {
      continue;
    }
    hasData = true;
    if (lastReceived === null || received.getTime() > lastReceived.getTime()) {
      lastReceived = received;
    }
    if (now.getTime() - received.getTime() > thresholdMinutes * MS_PER_MINUTE) {
      staleEquipment.push({
        equipmentId: member.equipmentId,
        name: member.name,
        lastReceivedAt: received.toISOString(),
        thresholdMinutes,
      });
    }
  }
  return {
    freshness: !hasData ? 'NONE' : staleEquipment.length > 0 ? 'STALE' : 'FRESH',
    lastReceived,
    staleEquipment,
  };
}

/** 日時のうち、最も新しいもの。なければ null。 */
function latestOfDates(dates: readonly Date[]): Date | null {
  return dates.reduce<Date | null>(
    (latest, date) => (latest === null || date.getTime() > latest.getTime() ? date : latest),
    null,
  );
}

export function createDashboardQuery(deps: DashboardQueryDeps): DashboardQuery {
  const { repositories, ingestionSettings, settings, clock } = deps;

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
      // データの新しさは、ロボット・センサーからの自動取り込みで、設備ごとに判定する（手動入力で、供給の停止が隠れないように。V-024）。
      // 自動取り込みの対象でない設備（取り込み元が無効・取得先がない）は、判定しない。対象が 1 つもなければ、手動のみの運用（Issue #202）
      const members = allEquipment.filter(
        (item) =>
          !item.isDeleted &&
          item.equipmentType !== 'FACILITY' &&
          scope.equipmentIds.includes(item.equipmentId),
      );
      const sources = await ingestionSettings.listSources();
      const targets = members.filter((item) => isAutoIngestionTarget(item, sources));
      if (members.length > 0 && targets.length === 0) {
        const manualAt = await repositories.observations.receivedAtByEquipment(
          members.map((item) => item.equipmentId),
          { manualOnly: true },
        );
        return {
          equipmentId: params.equipmentId,
          horizon: params.horizon,
          periodDays: params.periodDays ?? DEFAULT_PERIOD_DAYS,
          evaluatedAt,
          lastReceivedAt: null,
          dataFreshness: 'MANUAL',
          lastManualInputAt: toIsoOrNull(latestOfDates([...manualAt.values()])),
          staleEquipment: [],
          summary: summarize(cards),
          viewpoints: cards,
        };
      }
      const receivedAt = await repositories.observations.receivedAtByEquipment(
        targets.map((item) => item.equipmentId),
        { autoImportOnly: true },
      );
      const { freshness, lastReceived, staleEquipment } = judgeFreshness(
        targets,
        receivedAt,
        now,
        settings.staleAfterIntervals,
      );

      return {
        equipmentId: params.equipmentId,
        horizon: params.horizon,
        periodDays: params.periodDays ?? DEFAULT_PERIOD_DAYS,
        evaluatedAt,
        lastReceivedAt: toIsoOrNull(lastReceived),
        dataFreshness: freshness,
        lastManualInputAt: null,
        staleEquipment,
        summary: summarize(cards),
        viewpoints: cards,
      };
    },
  };
}
