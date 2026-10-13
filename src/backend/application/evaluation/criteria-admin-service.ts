/**
 * 判断基準の編集のユースケース（UC-19。FR-5.7、FR-5.8）。
 * 変更はシステム全体に適用し、変更済みであることを識別できるようにする（版・変更者・日時）。
 * 変更後は、現在の評価を更新する。過去の評価は、再計算せず保持する（暫定。dev_spec.md 4章 No.10）。
 * 変更の履歴（変更者・前後）は、変更履歴に残す。
 */

import type { ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import { validationError, type FieldError } from '@smart-farm/shared/errors';
import type { UserId } from '@smart-farm/shared/schemas/common';
import type {
  CriteriaUpdateRequest,
  CriteriaView,
  ViewpointCriteria,
} from '@smart-farm/shared/schemas/criteria';
import type { AuditTargetType } from '@smart-farm/shared/schemas/audit';
import { getDefaultCriteria } from '../../domain/evaluation/default-criteria.ts';
import { getViewpointDefinition } from '../../domain/evaluation/viewpoints/registry.ts';
import type { AuditService } from '../audit/audit-service.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { Logger } from '../ports/logger-port.ts';
import type { CriteriaRepository } from '../ports/repositories.ts';
import type { CriteriaService } from './criteria-service.ts';
import type { EvaluationService } from './evaluation-service.ts';
import { reevaluateSafely } from './reevaluate-safely.ts';

const CRITERIA_TARGET_TYPE = 'criteria' satisfies AuditTargetType;
const CUSTOM_VERSION_PATTERN = /^CUSTOM-(\d+)$/;

export interface CriteriaAdminService {
  /** 現在有効な判断基準（変更後があればそれ、なければ既定値）。 */
  get(viewpointId: ViewpointId): Promise<CriteriaView>;
  update(
    viewpointId: ViewpointId,
    input: CriteriaUpdateRequest,
    actor: UserId,
  ): Promise<CriteriaView>;
  /** 既定値へ戻す。 */
  reset(viewpointId: ViewpointId, actor: UserId): Promise<CriteriaView>;
}

export interface CriteriaAdminServiceDeps {
  readonly criteriaService: CriteriaService;
  readonly criteriaRepository: CriteriaRepository;
  readonly audit: AuditService;
  readonly evaluation: EvaluationService;
  readonly clock: ClockPort;
  readonly logger: Logger;
}

function nextVersion(current: string): string {
  const matched = CUSTOM_VERSION_PATTERN.exec(current);
  return `CUSTOM-${String(matched?.[1] === undefined ? 1 : Number(matched[1]) + 1)}`;
}

/**
 * 指標の構成は、観点の既定値と同じ（指標の追加・削除・重複はできない）。
 * ステータス（ステータスコードのカテゴリ）で判定する指標は、ここでは編集できない（FR-5.7）。
 */
function indicatorViolations(viewpointId: ViewpointId, input: CriteriaUpdateRequest): FieldError[] {
  const expected = getDefaultCriteria(viewpointId).criteria.map((criterion) => criterion.indicator);
  const violations: FieldError[] = [];
  const seen = new Set<string>();
  input.criteria.forEach((criterion, index) => {
    if (!expected.includes(criterion.indicator)) {
      violations.push({
        name: `criteria.${String(index)}.indicator`,
        message: 'この観点で編集できない指標です（ステータスコードで判定する指標を含む）',
      });
    } else if (seen.has(criterion.indicator)) {
      violations.push({
        name: `criteria.${String(index)}.indicator`,
        message: '同じ指標の条件が重複しています',
      });
    }
    seen.add(criterion.indicator);
  });
  const missing = expected.filter((indicator) => !seen.has(indicator));
  if (violations.length === 0 && missing.length > 0) {
    violations.push({
      name: 'criteria',
      message: `すべての指標の条件を指定してください（不足: ${missing.join('、')}）`,
    });
  }
  return violations;
}

export function createCriteriaAdminService(deps: CriteriaAdminServiceDeps): CriteriaAdminService {
  const { criteriaService, criteriaRepository, audit, evaluation, clock, logger } = deps;

  /** 評価の更新。失敗しても、判断基準の保存の結果には影響させない。 */
  const reevaluate = (): Promise<void> =>
    reevaluateSafely(evaluation, logger, 'CRITERIA_CHANGE', '判断基準の変更後の評価に失敗しました');

  /** 応答には、ステータスコードでも判定する観点か（その指標は編集できない）を加える。 */
  function toView(value: ViewpointCriteria): CriteriaView {
    return {
      ...value,
      usesStatusIndicator: getViewpointDefinition(value.viewpointId).usesStatusIndicator,
    };
  }

  return {
    async get(viewpointId) {
      return toView(await criteriaService.getEffective(viewpointId));
    },

    async update(viewpointId, input, actor) {
      const violations = indicatorViolations(viewpointId, input);
      if (violations.length > 0) {
        throw validationError(violations);
      }
      const before = await criteriaService.getEffective(viewpointId);
      const updated: ViewpointCriteria = {
        viewpointId,
        criteria: input.criteria,
        version: nextVersion(before.version),
        isDefault: false,
        updatedAt: clock.now().toISOString(),
        updatedBy: actor,
      };
      await criteriaRepository.save(updated);
      await audit.record({
        operation: 'UPDATE',
        targetType: CRITERIA_TARGET_TYPE,
        targetId: viewpointId,
        actor,
        before,
        after: updated,
      });
      await reevaluate();
      return toView(updated);
    },

    async reset(viewpointId, actor) {
      const before = await criteriaService.getEffective(viewpointId);
      await criteriaRepository.delete(viewpointId);
      const restored = getDefaultCriteria(viewpointId);
      await audit.record({
        operation: 'UPDATE',
        targetType: CRITERIA_TARGET_TYPE,
        targetId: viewpointId,
        actor,
        before,
        after: restored,
      });
      await reevaluate();
      return toView(restored);
    },
  };
}
