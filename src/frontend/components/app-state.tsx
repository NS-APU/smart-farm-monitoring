/**
 * 画面をまたいで共有する状態: 設備の選択（FR-6.6）、最終のデータ取得日時（FR-6.3）。
 * 設備の階層はサーバーから読み、選択がなければ最初のハウスを対象にする。
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { DataFreshness } from '@smart-farm/shared/schemas/evaluation';
import type { Equipment, EquipmentTreeResponse } from '@smart-farm/shared/schemas/equipment';
import { getEquipmentTree } from '../api/endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { usePolling } from '../hooks/use-polling.ts';

export interface DataStatus {
  readonly lastReceivedAt: string | null;
  readonly freshness: DataFreshness;
}

export interface AppState {
  /** 設備の階層。読み込み中は undefined。 */
  readonly equipmentTree: EquipmentTreeResponse | undefined;
  /** 設備の一覧（ハウス、その配下の順。読み込み中は空）。 */
  readonly equipmentList: readonly Equipment[];
  /** 設備の名称の表（設備ID → 名称。読み込み中は空）。 */
  readonly equipmentNames: ReadonlyMap<string, string>;
  readonly equipmentError: Error | undefined;
  /** 設備の階層を、すぐに読み直す（設備を変更した後）。 */
  readonly reloadEquipment: () => void;
  /** 選択中の設備。階層が読み込めて、ハウスが1つ以上あれば、必ず値がある。 */
  readonly selectedEquipmentId: EquipmentId | undefined;
  readonly selectEquipment: (equipmentId: EquipmentId) => void;
  readonly dataStatus: DataStatus | undefined;
  readonly setDataStatus: (status: DataStatus | undefined) => void;
}

const AppStateContext = createContext<AppState | undefined>(undefined);

const EQUIPMENT_REFRESH_MS = 60_000;

export function AppStateProvider(props: { readonly children: ReactNode }): ReactNode {
  const { api } = useAuth();
  const fetchTree = useCallback(() => getEquipmentTree(api), [api]);
  const tree = usePolling(fetchTree, EQUIPMENT_REFRESH_MS);
  const [chosenId, setChosenId] = useState<EquipmentId | undefined>(undefined);
  const [dataStatus, setDataStatus] = useState<DataStatus | undefined>(undefined);

  const value = useMemo<AppState>(() => {
    const equipmentList =
      tree.data?.facilities.flatMap(({ facility, children }) => [facility, ...children]) ?? [];
    const knownIds = new Set(equipmentList.map((item) => item.equipmentId));
    const firstFacilityId = tree.data?.facilities[0]?.facility.equipmentId;
    return {
      equipmentTree: tree.data,
      equipmentList,
      equipmentNames: new Map(equipmentList.map((item) => [item.equipmentId, item.name])),
      equipmentError: tree.error,
      reloadEquipment: tree.reload,
      selectedEquipmentId:
        chosenId !== undefined && knownIds.has(chosenId) ? chosenId : firstFacilityId,
      selectEquipment: setChosenId,
      dataStatus,
      setDataStatus,
    };
  }, [tree.data, tree.error, tree.reload, chosenId, dataStatus]);

  return <AppStateContext.Provider value={value}>{props.children}</AppStateContext.Provider>;
}

export function useAppState(): AppState {
  const value = useContext(AppStateContext);
  if (value === undefined) {
    throw new Error('AppStateProvider の外では useAppState を使えません');
  }
  return value;
}
