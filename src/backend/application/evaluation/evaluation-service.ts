/**
 * 評価・診断のユースケース（JB-02。FR-5、architecture.md 7章）。
 * 観測値を読み、純粋関数の評価エンジンで判定し、評価結果を保存する。
 * 状態の変化（「注意」「異常」への遷移）を検知して通知につなげ、連携キューに積む。
 * 評価の契機（EVALUATION_TRIGGERS）: 取り込み・手動入力の保存後、設備・ステータスコード・判断基準の変更後、
 * 定期（データ途絶の確認）、初期データの投入後、開発用 API からの再評価。
 */

import {
  viewpointsForEquipmentType,
  type ViewpointId,
} from '@smart-farm/shared/constants/viewpoints';
import type { ViewpointCriteria } from '@smart-farm/shared/schemas/criteria';
import type { StatusCodeDefinition } from '@smart-farm/shared/schemas/status-code';
import { DEFAULT_PERIOD_DAYS, PERIOD_DAYS_OPTIONS } from '@smart-farm/shared/constants/status';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { EvaluationResult } from '@smart-farm/shared/schemas/evaluation';
import { MS_PER_DAY } from '@smart-farm/shared/time';
import { combineHorizonStatuses } from '../../domain/evaluation/grading.ts';
import { evaluateScope, type EvaluationDraft } from '../../domain/evaluation/scope-evaluator.ts';
import { isNotifiableTransition } from '../../domain/notification-rules.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import { errorLogFields } from '../error-fields.ts';
import type { Logger } from '../ports/logger-port.ts';
import type { Repositories } from '../ports/repositories.ts';
import type { AppSettings } from '../settings.ts';
import type { FederationService } from '../federation/federation-service.ts';
import type { NotificationService } from '../notification/notification-service.ts';
import type { CriteriaService } from './criteria-service.ts';
import { resolveEvaluationScope } from './scope.ts';

/**
 * 評価は、CPU を使う処理のため、設備ごとの区切りで、イベントループへ制御を戻す。受信した通信（ほかの利用者の参照・保存）を
 * 評価の合間に処理でき、評価の開始の直前に届いた保存の要求は、同じ回の評価にまとまる。
 */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const LONGEST_PERIOD_DAYS = Math.max(...PERIOD_DAYS_OPTIONS);

/** 評価を実行した契機。ログ（trigger）に残す。 */
export const EVALUATION_TRIGGERS = [
  'INGESTION',
  'MANUAL_ENTRY',
  'EQUIPMENT_CHANGE',
  'STATUS_CODE_CHANGE',
  'CRITERIA_CHANGE',
  'SCHEDULED',
  'SEED',
  'DEV',
] as const;
export type EvaluationTrigger = (typeof EVALUATION_TRIGGERS)[number];

export interface EvaluationRunSummary {
  readonly equipmentEvaluated: number;
  readonly resultsSaved: number;
  readonly statusChanges: number;
  readonly notificationsCreated: number;
}

export interface EvaluationService {
  /**
   * すべての設備を評価し、結果を保存する。契機（trigger）はログに残す。
   * 評価は、同時に1つだけ実行する（通知・連携の重複を防ぐ）。実行中に重なった要求は、実行が終わってから、
   * 1回にまとめて実行する（その間の変更も反映される）。1つの設備の評価が失敗しても、残りの設備を評価し、
   * すべての設備の評価のあとに、最初の失敗を呼び出し元へ伝える（失敗した設備は、すべてログに残す）。
   */
  evaluateAll(trigger: EvaluationTrigger): Promise<EvaluationRunSummary>;
  /**
   * 指定した設備と、その設備を含むハウス（ロボット・センサーの観測値は、ハウスの評価にも使う）だけを評価する。
   * 手動入力・取り込みの保存後に、データが変わった設備だけを評価して、保存の応答を速くする（ほかの設備の評価は、
   * 定期の評価 JB-02 が更新する）。実行中に重なった要求は、全設備の評価も含めて、1回にまとめる。
   */
  evaluateAffected(
    trigger: EvaluationTrigger,
    equipmentIds: readonly EquipmentId[],
  ): Promise<EvaluationRunSummary>;
}

export interface EvaluationServiceDeps {
  readonly repositories: Pick<
    Repositories,
    'equipment' | 'observations' | 'statusCodes' | 'evaluations'
  >;
  readonly criteria: CriteriaService;
  readonly notifications: NotificationService;
  readonly federation: FederationService;
  readonly clock: ClockPort;
  readonly settings: Pick<AppSettings, 'defaultIngestionIntervalMinutes'>;
  readonly logger: Logger;
}

function toResult(
  draft: EvaluationDraft,
  equipment: Equipment,
  evaluatedAt: Date,
): EvaluationResult {
  const { evaluation } = draft;
  return {
    equipmentId: equipment.equipmentId,
    viewpointId: draft.viewpointId,
    horizon: draft.horizon,
    periodDays: draft.periodDays,
    status: evaluation.status,
    metrics: { ...evaluation.metrics },
    indicatorStatuses: { ...evaluation.indicatorStatuses },
    statusDetail: evaluation.statusDetail,
    diagnosticMessage: evaluation.diagnosticMessage,
    recommendedAction: evaluation.recommendedAction,
    criteriaVersion: draft.criteriaVersion,
    isCustomCriteria: draft.isCustomCriteria,
    evaluatedFrom: draft.evaluatedFrom.toISOString(),
    evaluatedTo: draft.evaluatedTo.toISOString(),
    evaluatedAt: evaluatedAt.toISOString(),
  };
}

/** 指定した設備と、それを含むハウスを、設備の登録の順に返す。 */
function selectAffected(
  allEquipment: readonly Equipment[],
  only: ReadonlySet<EquipmentId>,
): Equipment[] {
  const included = new Set<EquipmentId>(only);
  for (const equipment of allEquipment) {
    if (only.has(equipment.equipmentId) && equipment.facilityId !== undefined) {
      included.add(equipment.facilityId);
    }
  }
  return allEquipment.filter((equipment) => included.has(equipment.equipmentId));
}

export function createEvaluationService(deps: EvaluationServiceDeps): EvaluationService {
  const { repositories, criteria, notifications, federation, clock, settings, logger } = deps;

  /** 設備の観点（短期・長期の各期間）を評価し、結果を保存する。 */
  async function evaluateAndSave(
    equipment: Equipment,
    allEquipment: readonly Equipment[],
    statusCodes: ReadonlyMap<string, StatusCodeDefinition>,
    criteriaMap: ReadonlyMap<ViewpointId, ViewpointCriteria>,
    now: Date,
  ): Promise<EvaluationResult[]> {
    const scope = resolveEvaluationScope(equipment, allEquipment);
    const viewpointIds = viewpointsForEquipmentType(equipment.equipmentType).map((meta) => meta.id);
    const observations = await repositories.observations.findForEvaluation(
      scope.equipmentIds,
      new Date(now.getTime() - LONGEST_PERIOD_DAYS * MS_PER_DAY),
      now,
    );
    const drafts = evaluateScope({
      observations,
      now,
      viewpointIds,
      criteriaOf: (viewpointId) => {
        const effective = criteriaMap.get(viewpointId);
        if (effective === undefined) {
          throw new Error(`判断基準が見つかりません: ${viewpointId}`);
        }
        return effective;
      },
      statusCodes,
      expectedStreams: scope.expectedStreams,
      coverageSlotMinutes: settings.defaultIngestionIntervalMinutes,
    });

    const results = drafts.map((draft) => toResult(draft, equipment, now));
    for (const result of results) {
      await repositories.evaluations.saveLatest(result);
    }
    return results;
  }

  /**
   * 観点の最終ステータス（短期・長期のうち「不明」を除いた悪い方）の変化を記録し、
   * 変化があれば、連携キューに積み、「注意」「異常」への変化は通知する。
   */
  async function recordStatusChanges(
    equipment: Equipment,
    results: readonly EvaluationResult[],
    now: Date,
  ): Promise<{ changes: number; notified: number }> {
    let changes = 0;
    let notified = 0;
    // 観点ごとに、既定の期間の長期の結果（すべての観点にある）を基準にする
    const defaultLongResults = results.filter(
      (result) => result.horizon === 'LONG' && result.periodDays === DEFAULT_PERIOD_DAYS,
    );
    for (const longResult of defaultLongResults) {
      const viewpointId = longResult.viewpointId;
      const shortResult = results.find(
        (result) => result.viewpointId === viewpointId && result.horizon === 'SHORT',
      );
      // 通知・連携の基準は、短期視点と長期視点（既定の期間）のうち「不明」を除いた悪い方
      const status = combineHorizonStatuses(shortResult?.status ?? null, longResult.status);
      const previous = await repositories.evaluations.getLastStatusChange(
        equipment.equipmentId,
        viewpointId,
      );
      if (previous?.status === status) {
        continue;
      }
      changes += 1;
      await repositories.evaluations.appendStatusChange({
        equipmentId: equipment.equipmentId,
        viewpointId,
        status,
        changedAt: now.toISOString(),
      });
      const basis =
        [longResult, shortResult].find((result) => result?.status === status) ?? longResult;
      await federation.enqueue({
        targetType: 'EVALUATION',
        targetRef: `${equipment.equipmentId}#${viewpointId}`,
        payload: {
          equipmentId: equipment.equipmentId,
          viewpointId,
          status,
          metrics: basis.metrics,
          diagnosticMessage: basis.diagnosticMessage,
          recommendedAction: basis.recommendedAction,
          evaluatedAt: basis.evaluatedAt,
        },
      });
      if (isNotifiableTransition(previous?.status ?? null, status)) {
        const created = await notifications.notifyStatusChange({
          equipment,
          viewpointId,
          status,
          diagnosticMessage: basis.diagnosticMessage,
        });
        if (created !== null) {
          notified += 1;
        }
      }
    }
    return { changes, notified };
  }

  /** 評価する設備。`only` を指定したら、その設備と、それを含むハウスだけ。 */
  async function execute(
    trigger: EvaluationTrigger,
    only: ReadonlySet<EquipmentId> | undefined,
  ): Promise<EvaluationRunSummary> {
    const now = clock.now();
    const allEquipment = await repositories.equipment.list();
    const targets = only === undefined ? allEquipment : selectAffected(allEquipment, only);
    const statusCodeList = await repositories.statusCodes.list({ includeDeleted: true });
    const statusCodes = new Map(statusCodeList.map((definition) => [definition.code, definition]));
    const criteriaMap = await criteria.getAllEffective();

    let resultsSaved = 0;
    let statusChanges = 0;
    let notificationsCreated = 0;
    const failures: unknown[] = [];
    for (const equipment of targets) {
      await yieldToEventLoop();
      // 1つの設備の失敗が、残りの設備の評価・通知を止めないようにする
      try {
        const results = await evaluateAndSave(
          equipment,
          allEquipment,
          statusCodes,
          criteriaMap,
          now,
        );
        const outcome = await recordStatusChanges(equipment, results, now);
        resultsSaved += results.length;
        statusChanges += outcome.changes;
        notificationsCreated += outcome.notified;
      } catch (error) {
        failures.push(error);
        logger.error('設備の評価に失敗しました', {
          trigger,
          equipmentId: equipment.equipmentId,
          ...errorLogFields(error),
        });
      }
    }
    logger.info('評価を実行しました', {
      trigger,
      equipmentEvaluated: targets.length,
      resultsSaved,
      equipmentFailed: failures.length,
    });
    if (failures.length > 0) {
      throw failures[0];
    }
    return {
      equipmentEvaluated: targets.length,
      resultsSaved,
      statusChanges,
      notificationsCreated,
    };
  }

  // 実行中の評価の完了を待つ鎖と、まだ始まっていない待機中の1回分（重なった要求は、これにまとめる）
  interface Pending {
    readonly promise: Promise<EvaluationRunSummary>;
    /** 待機中の1回分に、評価する設備を加える（undefined は、全設備）。 */
    readonly widen: (more: readonly EquipmentId[] | undefined) => void;
  }
  let chain: Promise<unknown> = Promise.resolve();
  let pending: Pending | undefined;

  function request(
    trigger: EvaluationTrigger,
    only: readonly EquipmentId[] | undefined,
  ): Promise<EvaluationRunSummary> {
    if (pending !== undefined) {
      pending.widen(only);
      return pending.promise;
    }
    // 評価する設備。undefined なら、全設備（全設備の要求が重なったら、全設備にする）
    let scope = only === undefined ? undefined : new Set(only);
    const promise = chain.then(async () => {
      // 開始の直前に届いた要求を、この回にまとめる
      await yieldToEventLoop();
      pending = undefined;
      return execute(trigger, scope);
    });
    pending = {
      promise,
      widen(more) {
        if (more === undefined) {
          scope = undefined;
        } else if (scope !== undefined) {
          for (const equipmentId of more) {
            scope.add(equipmentId);
          }
        }
      },
    };
    chain = promise.then(
      () => undefined,
      () => undefined,
    );
    return promise;
  }

  return {
    evaluateAll: (trigger) => request(trigger, undefined),
    evaluateAffected: (trigger, equipmentIds) => request(trigger, equipmentIds),
  };
}
