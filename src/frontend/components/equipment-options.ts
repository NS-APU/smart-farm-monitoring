/** 設備の選択肢の表示。配下の設備（ロボット・センサー）は、ハウスの下に字下げして示す。 */

import type { Equipment } from '@smart-farm/shared/schemas/equipment';

/** 配下の設備の字下げ（全角の空白）。 */
const CHILD_INDENT = String.fromCodePoint(0x3000);

export function equipmentOptionLabel(item: Pick<Equipment, 'equipmentType' | 'name'>): string {
  return item.equipmentType === 'FACILITY' ? item.name : `${CHILD_INDENT}${item.name}`;
}
