/**
 * 参照（Query）: 観測値の一覧（FR-6.4 元データ、FR-6.8 取り込み済みデータ。UC-02・UC-20）。
 * 設備（ハウスは配下のロボット・センサーを含む）、観点（その観点の元データの項目）、カテゴリ・項目・取得元・期間で絞り込み、
 * キーワード（項目・カテゴリ・設備・取得元・状態の表示名、値）で検索する。並べ替え・ページ分割はサーバー側で行う。
 */

import { AppError } from '@smart-farm/shared/errors';
import {
  CATEGORY_LABELS,
  findItemDefinition,
  type Category,
} from '@smart-farm/shared/constants/items';
import {
  OBSERVATION_QUALITY_LABELS,
  OBSERVATION_SOURCE_LABELS,
} from '@smart-farm/shared/constants/observation-labels';
import type { ObservationSortKey, SortDirection } from '@smart-farm/shared/constants/sorting';
import type { ObservationSource } from '@smart-farm/shared/constants/status';
import { findViewpointMeta } from '@smart-farm/shared/constants/viewpoints';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Observation, ObservationListResponse } from '@smart-farm/shared/schemas/observation';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import { getViewpointDefinition } from '../../domain/evaluation/viewpoints/registry.ts';
import { viewpointSourceItemKeys } from '../../domain/evaluation/viewpoints/source-items.ts';
import { EQUIPMENT_NOT_FOUND_MESSAGE } from '../equipment/require-active-equipment.ts';
import { resolveEvaluationScope } from '../evaluation/scope.ts';
import type { Repositories } from '../ports/repositories.ts';

export interface ObservationListParams {
  readonly equipmentId?: EquipmentId | undefined;
  readonly viewpointId?: string | undefined;
  readonly category?: Category | undefined;
  readonly itemKey?: string | undefined;
  readonly source?: ObservationSource | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly keyword?: string | undefined;
  readonly sort: ObservationSortKey;
  readonly direction: SortDirection;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface ObservationQuery {
  list(params: ObservationListParams): Promise<ObservationListResponse>;
}

export interface ObservationQueryDeps {
  readonly repositories: Pick<Repositories, 'equipment' | 'observations' | 'statusCodes'>;
}

export interface ObservationNames {
  readonly equipment: ReadonlyMap<string, string>;
  readonly statusCodes: ReadonlyMap<string, string>;
}

/** キーワードに一致するか（大文字・小文字を区別しない部分一致）。 */
export function observationMatchesKeyword(
  observation: Observation,
  keyword: string,
  names: ObservationNames,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  const value = observation.value === null ? '' : String(observation.value);
  const haystacks = [
    observation.itemKey,
    findItemDefinition(observation.itemKey)?.label ?? '',
    CATEGORY_LABELS[observation.category],
    names.equipment.get(observation.equipmentId) ?? '',
    OBSERVATION_SOURCE_LABELS[observation.source],
    OBSERVATION_QUALITY_LABELS[observation.quality],
    value,
    names.statusCodes.get(value) ?? '',
  ];
  return haystacks.some((text) => text.toLowerCase().includes(needle));
}

/**
 * キーワードの判定関数を作る。観測値ごとに変わらない部分（項目・カテゴリ・設備・取得元・状態の表示名）は、
 * 項目・設備・取得元・状態の組ごとに、小文字にした文字列を1度だけ作って使い回す（観測値ごとに配列・文字列を作り直さない。V-189）。
 * 判定の結果は、observationMatchesKeyword と同じ。
 */
export function createKeywordMatcher(
  keyword: string,
  names: ObservationNames,
): (observation: Observation) => boolean {
  const needle = keyword.trim().toLowerCase();
  if (needle === '') {
    return () => true;
  }
  // 項目 → 設備 → 取得元 → 品質 → カテゴリ の順の木（観測値ごとに、キーの文字列を作らない）
  interface MatchNode {
    readonly children: Map<string, MatchNode>;
    matched?: boolean;
  }
  const root: MatchNode = { children: new Map() };
  const staticMatchOf = (observation: Observation): boolean => {
    let node = root;
    for (const part of [
      observation.itemKey,
      observation.equipmentId,
      observation.source,
      observation.quality,
      observation.category,
    ]) {
      let child = node.children.get(part);
      if (child === undefined) {
        child = { children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.matched ??= [
      observation.itemKey,
      findItemDefinition(observation.itemKey)?.label ?? '',
      CATEGORY_LABELS[observation.category],
      names.equipment.get(observation.equipmentId) ?? '',
      OBSERVATION_SOURCE_LABELS[observation.source],
      OBSERVATION_QUALITY_LABELS[observation.quality],
    ].some((text) => text.toLowerCase().includes(needle));
    return node.matched;
  };
  return (observation) => {
    if (staticMatchOf(observation)) {
      return true;
    }
    const value = observation.value === null ? '' : String(observation.value);
    return (
      value.toLowerCase().includes(needle) ||
      (names.statusCodes.get(value) ?? '').toLowerCase().includes(needle)
    );
  };
}

export function createObservationQuery(deps: ObservationQueryDeps): ObservationQuery {
  const { repositories } = deps;

  return {
    async list(params) {
      const allEquipment = await repositories.equipment.list();
      let equipmentIds: readonly EquipmentId[] | undefined;
      if (params.equipmentId !== undefined) {
        // 削除済みの設備の元データも参照できる（他の画面と違い、isDeleted を見ない。現状の判定を保つ）
        const equipment = allEquipment.find((item) => item.equipmentId === params.equipmentId);
        if (equipment === undefined) {
          throw new AppError('NOT_FOUND', EQUIPMENT_NOT_FOUND_MESSAGE);
        }
        equipmentIds = resolveEvaluationScope(equipment, allEquipment).equipmentIds;
      }

      let itemKeys: readonly string[] | undefined;
      if (params.viewpointId !== undefined) {
        const meta = findViewpointMeta(params.viewpointId);
        if (meta === undefined) {
          throw new AppError('NOT_FOUND', '観点が見つかりません');
        }
        itemKeys = viewpointSourceItemKeys(getViewpointDefinition(meta.id)) ?? undefined;
      }

      const keyword = params.keyword?.trim() ?? '';
      let matches: ((observation: Observation) => boolean) | undefined;
      if (keyword !== '') {
        const statusCodes = await repositories.statusCodes.list({ includeDeleted: true });
        const names: ObservationNames = {
          equipment: new Map(allEquipment.map((item) => [item.equipmentId, item.name])),
          statusCodes: new Map(statusCodes.map((item) => [item.code, item.name])),
        };
        matches = createKeywordMatcher(keyword, names);
      }

      const page = await repositories.observations.query(
        omitUndefined({
          equipmentIds,
          category: params.category,
          itemKey: params.itemKey,
          itemKeys,
          source: params.source,
          from: params.from,
          to: params.to,
          matches,
        }),
        { limit: params.limit, cursor: params.cursor },
        { key: params.sort, direction: params.direction },
      );
      return { items: page.items, nextCursor: page.nextCursor };
    },
  };
}
