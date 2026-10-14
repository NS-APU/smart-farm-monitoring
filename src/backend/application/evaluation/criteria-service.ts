/**
 * 判断基準の取得（変更後の値があればそれ、なければ既定値）。
 * 取得のみを担う。判断基準の編集（UC-19）は criteria-admin-service.ts にある。
 */

import { VIEWPOINT_IDS, type ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import type { ViewpointCriteria } from '@smart-farm/shared/schemas/criteria';
import { getDefaultCriteria } from '../../domain/evaluation/default-criteria.ts';
import type { CriteriaRepository } from '../ports/repositories.ts';

export interface CriteriaService {
  getEffective(viewpointId: ViewpointId): Promise<ViewpointCriteria>;
  getAllEffective(): Promise<ReadonlyMap<ViewpointId, ViewpointCriteria>>;
}

export function createCriteriaService(deps: { criteria: CriteriaRepository }): CriteriaService {
  async function getEffective(viewpointId: ViewpointId): Promise<ViewpointCriteria> {
    return (await deps.criteria.get(viewpointId)) ?? getDefaultCriteria(viewpointId);
  }

  return {
    getEffective,
    async getAllEffective() {
      const entries = await Promise.all(
        VIEWPOINT_IDS.map(async (id) => [id, await getEffective(id)] as const),
      );
      return new Map(entries);
    },
  };
}
