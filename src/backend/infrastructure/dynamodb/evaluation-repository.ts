/** 評価結果（最新）と、観点の最終ステータスの変化の Repository（DynamoDB 実装）。 */

import {
  EvaluationResultSchema,
  type EvaluationResult,
} from '@smart-farm/shared/schemas/evaluation';
import { StatusChangeEntrySchema } from '../../application/ports/records.ts';
import type { EvaluationRepository } from '../../application/ports/repositories.ts';
import { instantKey } from './keys.ts';
import { mainAggregate } from './main-table.ts';
import { transactWrite, type Database } from './operations.ts';

const evaluationPartition = (equipmentId: string): string => `EVAL#${equipmentId}`;
const evaluationSortKey = (
  result: Pick<EvaluationResult, 'viewpointId' | 'horizon' | 'periodDays'>,
): string => `${result.viewpointId}#${result.horizon}#${result.periodDays ?? 0}`;
const lastChangePartition = (equipmentId: string): string => `SCLAST#${equipmentId}`;
const historyPartition = (equipmentId: string, viewpointId: string): string =>
  `SCH#${equipmentId}#${viewpointId}`;

export function createEvaluationRepository(db: Database): EvaluationRepository {
  const evaluations = mainAggregate(db, EvaluationResultSchema);
  const changes = mainAggregate(db, StatusChangeEntrySchema);

  return {
    saveLatest: (result) =>
      evaluations.put(evaluationPartition(result.equipmentId), evaluationSortKey(result), result),
    getLatest: (equipmentId, viewpointId, horizon, periodDays) =>
      evaluations.get(
        evaluationPartition(equipmentId),
        evaluationSortKey({ viewpointId, horizon, periodDays }),
      ),
    listLatest: (equipmentId) => evaluations.list(evaluationPartition(equipmentId)),
    async appendStatusChange(entry) {
      // 最終の変化と履歴は、同時に書く（片方だけ残らない）
      await transactWrite(db, [
        changes.putOperation(lastChangePartition(entry.equipmentId), entry.viewpointId, entry),
        changes.putOperation(
          historyPartition(entry.equipmentId, entry.viewpointId),
          instantKey(entry.changedAt),
          entry,
        ),
      ]);
    },
    getLastStatusChange: (equipmentId, viewpointId) =>
      changes.get(lastChangePartition(equipmentId), viewpointId),
    listStatusChanges: (equipmentId, viewpointId) =>
      changes.list(historyPartition(equipmentId, viewpointId)),
  };
}
