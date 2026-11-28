/**
 * 判断基準の影響のプレビュー（UC-19。SC-13-2。ADR-0017 の D-24）。入力途中の閾値を、保存済みの評価結果（メトリクス・ステータスコードの
 * カテゴリ）に当てて再判定し、状態が変わる設備・観点を返す。観測値は読まない。何も保存しない。
 * 「現在」と「変更後」は、同じ保存済みの結果に、現在の判断基準と入力途中の判断基準を当てた判定（閾値と無関係な差を出さない。
 * 評価の直後に判断基準が変わり、保存済みの結果が、まだ古い基準のままのときも同じ）。判定は、実際の評価と同じ関数（`rejudgeStatus`）で行う。
 * ハウスの結果は、実際の評価と同じく、配下の設備の再判定した結果を `aggregateWorstResults` で再集計する
 * （配下に、この観点の結果がなければ、ハウス自身の保存済みの結果を再判定する）。
 * 読み取りは、設備ごとの保存済みの結果の Query だけ。対象は、閲覧できる設備（閲覧範囲。ADR-0013）。
 */

import {
  defaultPeriodDays,
  viewpointsForEquipmentType,
} from '@smart-farm/shared/constants/viewpoints';
import type { ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import { validationError } from '@smart-farm/shared/errors';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type {
  CriteriaPreviewResponse,
  CriteriaUpdateRequest,
  ViewpointCriteria,
} from '@smart-farm/shared/schemas/criteria';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { EvaluationResult } from '@smart-farm/shared/schemas/evaluation';
import { combineHorizonStatuses } from '../../domain/evaluation/grading.ts';
import { rejudgeStatus } from '../../domain/evaluation/engine.ts';
import { getViewpointDefinition } from '../../domain/evaluation/viewpoints/registry.ts';
import { aggregateWorstResults } from '../../domain/evaluation/worst-result.ts';
import { canViewEquipment, type EquipmentScope } from '../access/facility-scope.ts';
import type { Repositories } from '../ports/repositories.ts';
import { indicatorViolations } from './criteria-admin-service.ts';
import type { CriteriaService } from './criteria-service.ts';
import { memberEquipmentOf } from './scope.ts';

export interface CriteriaPreviewService {
  /** 入力途中の閾値の影響を、保存済みの評価結果から求める（保存しない）。入力は、保存と同じ検証にする。 */
  preview(
    viewpointId: ViewpointId,
    input: CriteriaUpdateRequest,
    scope: EquipmentScope,
  ): Promise<CriteriaPreviewResponse>;
}

export interface CriteriaPreviewServiceDeps {
  readonly criteriaService: CriteriaService;
  readonly repositories: Pick<Repositories, 'equipment' | 'evaluations'>;
}

export function createCriteriaPreviewService(
  deps: CriteriaPreviewServiceDeps,
): CriteriaPreviewService {
  const { criteriaService, repositories } = deps;

  return {
    async preview(viewpointId, input, scope) {
      const violations = indicatorViolations(viewpointId, input);
      if (violations.length > 0) {
        throw validationError(violations);
      }
      const definition = getViewpointDefinition(viewpointId);
      const periodDays = defaultPeriodDays(viewpointId);
      const current = await criteriaService.getEffective(viewpointId);
      const draft: ViewpointCriteria = { ...current, criteria: input.criteria };

      // 対象: 閲覧できる設備のうち、この観点の対象の設備（削除済みを除く）。ハウスの配下は、ハウスが閲覧できれば、閲覧できる
      const allEquipment = await repositories.equipment.list();
      const targets = allEquipment.filter(
        (equipment) =>
          !equipment.isDeleted &&
          canViewEquipment(scope, equipment.equipmentId) &&
          viewpointsForEquipmentType(equipment.equipmentType).some(
            (meta) => meta.id === viewpointId,
          ),
      );
      const saved = new Map<EquipmentId, readonly EvaluationResult[]>(
        await Promise.all(
          targets.map(
            async (equipment) =>
              [
                equipment.equipmentId,
                (await repositories.evaluations.listLatest(equipment.equipmentId)).filter(
                  (result) => result.viewpointId === viewpointId,
                ),
              ] as const,
          ),
        ),
      );

      /** 保存済みの結果に、判断基準を当てて、ステータスを求め直した結果。 */
      const rejudged = (
        results: readonly EvaluationResult[],
        criteria: ViewpointCriteria,
      ): EvaluationResult[] =>
        results.map((result) => ({
          ...result,
          status: rejudgeStatus({
            definition,
            status: result.status,
            metrics: result.metrics,
            statusDetail: result.statusDetail,
            criteria,
          }),
        }));

      /** 設備の結果（ハウスは、配下の設備の結果を再集計。配下に結果がなければ、ハウス自身の結果）。 */
      const resultsOf = (equipment: Equipment, criteria: ViewpointCriteria): EvaluationResult[] => {
        if (equipment.equipmentType === 'FACILITY') {
          const aggregated = aggregateWorstResults({
            equipmentId: equipment.equipmentId,
            members: memberEquipmentOf(equipment, allEquipment).map((member) => ({
              equipmentName: member.name,
              results: rejudged(saved.get(member.equipmentId) ?? [], criteria),
            })),
            evaluatedAt: new Date(0),
          });
          if (aggregated.length > 0) {
            return aggregated;
          }
        }
        return rejudged(saved.get(equipment.equipmentId) ?? [], criteria);
      };

      /** 観点の状態: 短期・長期（既定の期間）のうち「不明」を除いた悪い方。長期の結果がなければ undefined（未評価）。 */
      const statusOf = (results: readonly EvaluationResult[]) => {
        const long = results.find(
          (result) => result.horizon === 'LONG' && result.periodDays === periodDays,
        );
        const short = definition.hasShortHorizon
          ? results.find((result) => result.horizon === 'SHORT')
          : undefined;
        return long === undefined
          ? undefined
          : combineHorizonStatuses(short?.status ?? null, long.status);
      };

      const changes: CriteriaPreviewResponse['changes'] = [];
      const unevaluated: CriteriaPreviewResponse['unevaluated'] = [];
      let unknownCount = 0;
      const evaluatedAts: string[] = [];
      for (const equipment of targets) {
        const identity = {
          equipmentId: equipment.equipmentId,
          equipmentName: equipment.name,
          equipmentType: equipment.equipmentType,
        };
        const before = statusOf(resultsOf(equipment, current));
        const after = statusOf(resultsOf(equipment, draft));
        if (before === undefined || after === undefined) {
          unevaluated.push(identity);
          continue;
        }
        evaluatedAts.push(
          ...(saved.get(equipment.equipmentId) ?? []).map((result) => result.evaluatedAt),
        );
        if (before === 'UNKNOWN') {
          unknownCount += 1;
        } else if (before !== after) {
          changes.push({ ...identity, current: before, after });
        }
      }
      return {
        viewpointId,
        evaluatedAt: evaluatedAts.sort()[0] ?? null,
        targetCount: targets.length,
        changes,
        unevaluated,
        unknownCount,
      };
    },
  };
}
