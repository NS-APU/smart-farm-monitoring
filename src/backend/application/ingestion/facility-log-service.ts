/**
 * ハウス別の取り込み・連携のログのユースケース（Issue #332。ADR-0013。FR-9.8）。
 * 一般ユーザーに、閲覧できるハウスの分だけを見せる。返すのは、時刻・結果・ハウスごとの件数だけで、
 * 接続先・認証情報・失敗の理由・全体の件数・キューの件数は、返さない（取り込みの参照権限〔管理者〕の画面・API で見る）。
 * 全設備を閲覧できる利用者（管理者）には、すべてのハウスの分を返す。割り当てがなければ、何も返さない。
 */

import type {
  FacilityFederationLogListResponse,
  FacilityIngestionLogListResponse,
} from '@smart-farm/shared/schemas/ingestion';
import { facilityIdsOf, type EquipmentScope } from '../access/facility-scope.ts';
import type { Repositories } from '../ports/repositories.ts';

export interface FacilityLogQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface FacilityLogService {
  listIngestionLogs(
    scope: EquipmentScope,
    query: FacilityLogQuery,
  ): Promise<FacilityIngestionLogListResponse>;
  listFederationLogs(
    scope: EquipmentScope,
    query: FacilityLogQuery,
  ): Promise<FacilityFederationLogListResponse>;
}

export function createFacilityLogService(deps: {
  readonly repositories: Pick<Repositories, 'equipment' | 'ingestion' | 'federation'>;
}): FacilityLogService {
  const { equipment, ingestion, federation } = deps.repositories;

  /** 閲覧できるハウス。全設備を閲覧できる利用者は、削除されていないすべてのハウス。 */
  async function visibleFacilityIds(scope: EquipmentScope): Promise<readonly string[]> {
    const limited = facilityIdsOf(scope);
    if (limited !== undefined) {
      return limited;
    }
    return (await equipment.list())
      .filter((item) => item.equipmentType === 'FACILITY')
      .map((item) => item.equipmentId);
  }

  return {
    async listIngestionLogs(scope, query) {
      const page = await ingestion.listFacilityLogs(await visibleFacilityIds(scope), {
        limit: query.limit,
        cursor: query.cursor,
      });
      return { items: page.items, nextCursor: page.nextCursor };
    },

    async listFederationLogs(scope, query) {
      const page = await federation.listFacilityLogs(await visibleFacilityIds(scope), {
        limit: query.limit,
        cursor: query.cursor,
      });
      return { items: page.items, nextCursor: page.nextCursor };
    },
  };
}
