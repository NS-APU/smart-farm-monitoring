/**
 * 設備の選択肢の表示。配下の設備（ロボット・センサー）は、ハウスの下に字下げし、種別（ロボット・センサー）を付ける
 * （同名の設備を区別できるように。Issue #152 の SC-06-8・SC-07-8）。ハウスは、名称のまま（階層の先頭）。
 */

import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import { MESSAGES } from '../i18n/messages.ts';

/** 配下の設備の字下げ（全角の空白）。 */
const CHILD_INDENT = String.fromCodePoint(0x3000);

export function equipmentOptionLabel(item: Pick<Equipment, 'equipmentType' | 'name'>): string {
  if (item.equipmentType === 'FACILITY') {
    return item.name;
  }
  return `${CHILD_INDENT}${item.name}（${MESSAGES.viewpoint.equipmentTypeShort[item.equipmentType]}）`;
}
