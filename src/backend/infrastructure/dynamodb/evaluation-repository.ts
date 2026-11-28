/** 評価結果（最新）と、観点の最終ステータスの変化の Repository（DynamoDB 実装）。 */

import {
  EvaluationResultSchema,
  type EvaluationResult,
} from '@smart-farm/shared/schemas/evaluation';
import { StatusChangeEntrySchema } from '../../application/ports/records.ts';
import type { EvaluationRepository } from '../../application/ports/repositories.ts';
import { VIEWPOINT_IDS } from '@smart-farm/shared/constants/viewpoints';
import { instantKey } from './keys.ts';
import { mainAggregate } from './main-table.ts';
import {
  batchWriteItems,
  putItemIf,
  queryAll,
  transactWrite,
  type Database,
} from './operations.ts';

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
    async saveLatest(result) {
      // 保存済みの結果の評価の日時が、これより新しければ、保存しない（遅れて終わった古い評価が、新しい結果を上書きしない。
      // 同じ日時は、上書きする）。評価の日時は、ISO 8601（UTC）の文字列で、辞書順が、時刻の順
      await putItemIf(
        db,
        db.tables.main,
        {
          pk: evaluationPartition(result.equipmentId),
          sk: evaluationSortKey(result),
          data: result,
        },
        {
          expression: 'attribute_not_exists(pk) OR #data.#evaluatedAt <= :evaluatedAt',
          names: { '#data': 'data', '#evaluatedAt': 'evaluatedAt' },
          values: { ':evaluatedAt': result.evaluatedAt },
        },
      );
    },
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
    async deleteByEquipment(equipmentId) {
      // 最新の評価結果・最終の変化・観点ごとの変化の履歴の、すべての項目（キーだけ）を集めて、まとめて削除する
      const partitions = [
        evaluationPartition(equipmentId),
        lastChangePartition(equipmentId),
        ...VIEWPOINT_IDS.map((viewpointId) => historyPartition(equipmentId, viewpointId)),
      ];
      const keys = (
        await Promise.all(partitions.map((partition) => queryAll(db, db.tables.main, partition)))
      ).flat();
      await batchWriteItems(
        db,
        db.tables.main,
        keys.map((item) => ({ delete: { pk: item.pk, sk: item.sk } })),
      );
    },
  };
}
