/** 評価結果（最新）と、観点の最終ステータスの変化の Repository（ローカル実装）。 */

import {
  EvaluationResultSchema,
  type EvaluationResult,
} from '@smart-farm/shared/schemas/evaluation';
import {
  StatusChangeEntrySchema,
  type StatusChangeEntry,
} from '../../../application/ports/records.ts';
import type { EvaluationRepository } from '../../../application/ports/repositories.ts';
import type { LocalStore } from '../local-store.ts';
import { saverOf } from './collection-helpers.ts';

const evaluationKey = (item: EvaluationResult): string =>
  `${item.equipmentId}#${item.viewpointId}#${item.horizon}#${item.periodDays ?? 0}`;
const lastStatusChangeKey = (item: StatusChangeEntry): string =>
  `${item.equipmentId}#${item.viewpointId}`;
const statusChangeHistoryKey = (item: StatusChangeEntry): string =>
  `${item.equipmentId}#${item.viewpointId}#${item.changedAt}`;

export function createEvaluationRepository(store: LocalStore): EvaluationRepository {
  const evaluations = store.collection('evaluations', EvaluationResultSchema, evaluationKey);
  const lastStatusChanges = store.collection(
    'lastStatusChanges',
    StatusChangeEntrySchema,
    lastStatusChangeKey,
  );
  const statusChangeHistory = store.collection(
    'statusChangeHistory',
    StatusChangeEntrySchema,
    statusChangeHistoryKey,
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
    deleteByEquipment(equipmentId) {
      for (const item of evaluations.values()) {
        if (item.equipmentId === equipmentId) {
          evaluations.delete(evaluationKey(item));
        }
      }
      for (const item of lastStatusChanges.values()) {
        if (item.equipmentId === equipmentId) {
          lastStatusChanges.delete(lastStatusChangeKey(item));
        }
      }
      for (const item of statusChangeHistory.values()) {
        if (item.equipmentId === equipmentId) {
          statusChangeHistory.delete(statusChangeHistoryKey(item));
        }
      }
      return Promise.resolve();
    },
  };
}
