/**
 * 初期データ（すべての環境で投入する）。ステータスコードの初期の定義（仮。FR-3、data-dictionary.md 7章）。
 * 投入は冪等（すでに定義がある場合は何もしない）。
 */

import type { StatusCodeDefinition } from '@smart-farm/shared/schemas/status-code';
import type { StatusCodeRepository } from '../ports/repositories.ts';

export const INITIAL_STATUS_CODES: readonly StatusCodeDefinition[] = [
  { code: 'STANDBY', name: '待機中', category: 'NORMAL', isDeleted: false },
  { code: 'RUNNING', name: '走行中', category: 'NORMAL', isDeleted: false },
  { code: 'HARVESTING', name: '収穫中', category: 'NORMAL', isDeleted: false },
  { code: 'STOPPED', name: '停止中', category: 'CAUTION', isDeleted: false },
  { code: 'LOW_BATTERY', name: 'バッテリー不足', category: 'CAUTION', isDeleted: false },
  { code: 'RUNNING_ERROR', name: '走行異常', category: 'ERROR', isDeleted: false },
  { code: 'HARVEST_ERROR', name: '収穫異常', category: 'ERROR', isDeleted: false },
  { code: 'FALLEN', name: '転倒（姿勢異常）', category: 'ERROR', isDeleted: false },
];

/** ステータスコードの定義が1件もなければ、初期の定義を投入する。投入した件数を返す。 */
export async function seedInitialStatusCodes(statusCodes: StatusCodeRepository): Promise<number> {
  const existing = await statusCodes.list({ includeDeleted: true });
  if (existing.length > 0) {
    return 0;
  }
  for (const definition of INITIAL_STATUS_CODES) {
    await statusCodes.save(definition);
  }
  return INITIAL_STATUS_CODES.length;
}
