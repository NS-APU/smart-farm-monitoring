/** 評価結果（最新）と、観点の最終ステータスの変化の Repository（ローカル実装）。 */

import { EvaluationResultSchema } from '@smart-farm/shared/schemas/evaluation';
import { StatusChangeEntrySchema } from '../../../application/ports/records.ts';
import type { EvaluationRepository } from '../../../application/ports/repositories.ts';
import type { LocalStore } from '../local-store.ts';
import { saverOf } from './collection-helpers.ts';

export function createEvaluationRepository(store: LocalStore): EvaluationRepository {
  const evaluations = store.collection(
    'evaluations',
    EvaluationResultSchema,
    (item) => `${item.equipmentId}#${item.viewpointId}#${item.horizon}#${item.periodDays ?? 0}`,
  );
  const lastStatusChanges = store.collection(
    'lastStatusChanges',
    StatusChangeEntrySchema,
    (item) => `${item.equipmentId}#${item.viewpointId}`,
  );
  const statusChangeHistory = store.collection(
    'statusChangeHistory',
    StatusChangeEntrySchema,
    (item) => `${item.equipmentId}#${item.viewpointId}#${item.changedAt}`,
  );

  return {
    saveLatest: saverOf(evaluations),
    getLatest: (equipmentId, viewpointId, horizon, periodDays) =>
      Promise.resolve(
        evaluations.get(`${equipmentId}#${viewpointId}#${horizon}#${periodDays ?? 0}`),
      ),
    listLatest: (equipmentId) =>
      Promise.resolve(evaluations.values().filter((item) => item.equipmentId === equipmentId)),
    appendStatusChange(entry) {
      lastStatusChanges.put(entry);
      statusChangeHistory.put(entry);
      return Promise.resolve();
    },
    getLastStatusChange: (equipmentId, viewpointId) =>
      Promise.resolve(lastStatusChanges.get(`${equipmentId}#${viewpointId}`)),
    listStatusChanges: (equipmentId, viewpointId) =>
      Promise.resolve(
        statusChangeHistory
          .values()
          .filter((item) => item.equipmentId === equipmentId && item.viewpointId === viewpointId)
          .sort((left, right) => left.changedAt.localeCompare(right.changedAt)),
      ),
  };
}
