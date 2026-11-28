/**
 * 設備の選択（FR-6.6。Issue #355）。以前は、ヘッダーに 1 つだけあったもの。選択は、画面をまたいで共有する（app-state.tsx）が、
 * 選ぶ操作は、それが要る画面の中に置く:
 * - ダッシュボード（ハウス単位）: 「対象のハウス」。ハウスだけを選べる（`facilitiesOnly`）。ロボット・センサーを選んでいるときは、そのハウスを示す
 * - 観点の詳細・満足度の詳細: 「対象の設備」。ハウス・ロボット・センサーを選べる
 */

import type { ReactNode } from 'react';
import { equipmentOptionLabel } from './equipment-options.ts';
import { useAppState } from './app-state.tsx';

export function EquipmentSelect(props: {
  readonly label: string;
  /** true なら、ハウスだけを選択肢にする（ダッシュボード）。 */
  readonly facilitiesOnly?: boolean;
}): ReactNode {
  const { equipmentList, selectedEquipmentId, selectedFacilityId, selectEquipment } = useAppState();
  const facilitiesOnly = props.facilitiesOnly === true;
  const options = facilitiesOnly
    ? equipmentList.filter((item) => item.equipmentType === 'FACILITY')
    : equipmentList;
  const value = facilitiesOnly ? selectedFacilityId : selectedEquipmentId;
  return (
    <label className="equipment-field">
      <span>{props.label}</span>
      <select
        value={value ?? ''}
        onChange={(event) => {
          // 選択肢にある設備だけを選ぶ（選択肢の値は、設備の識別子）
          const selected = options.find((item) => item.equipmentId === event.target.value);
          if (selected !== undefined) {
            selectEquipment(selected.equipmentId);
          }
        }}
        disabled={options.length === 0}
      >
        {options.map((item) => (
          <option key={item.equipmentId} value={item.equipmentId}>
            {equipmentOptionLabel(item)}
          </option>
        ))}
      </select>
    </label>
  );
}
