/**
 * 保存の後の評価の更新。失敗しても、保存した結果には影響させない（失敗はログに残す）。
 * 設備・ステータスコード・判断基準・手動入力の各サービスが共通で使う。
 */

import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import { errorLogFields } from '../error-fields.ts';
import type { Logger } from '../ports/logger-port.ts';
import type { EvaluationService, EvaluationTrigger } from './evaluation-service.ts';

export async function reevaluateSafely(
  evaluation: Pick<EvaluationService, 'evaluateAll' | 'evaluateAffected'>,
  logger: Logger,
  trigger: EvaluationTrigger,
  failureMessage: string,
  /** データが変わった設備。指定すると、その設備と、それを含むハウスだけを評価する。省略すると、全設備。 */
  affected?: readonly EquipmentId[],
): Promise<void> {
  try {
    if (affected === undefined) {
      await evaluation.evaluateAll(trigger);
    } else {
      await evaluation.evaluateAffected(trigger, affected);
    }
  } catch (error) {
    logger.error(failureMessage, { ...errorLogFields(error) });
  }
}
