/**
 * 取り込んだ値の品質の判定（FR-1.6。純粋関数）。
 * 欠損・不正・遅延を区別して扱う。扱いの定義は未確定（FR-1.6 の TODO）のため、暫定の規則（dev_spec.md 4章）:
 * - 項目がカタログにない、型・範囲が合わない、ステータスコードが未定義、計測日時が未来 → INVALID（不正）
 * - 値がない（null）→ MISSING（欠損）
 * - 受信が計測より一定時間以上遅れた → LATE（遅延）。値は評価に使う
 * - それ以外 → VALID
 */

import {
  STATUS_CODE_ITEM_KEY,
  findItemDefinition,
  isValidItemValue,
} from '@smart-farm/shared/constants/items';
import { FUTURE_TOLERANCE_MINUTES } from '@smart-farm/shared/constants/limits';
import type { ObservationQuality } from '@smart-farm/shared/constants/status';
import type { StatusCodeDefinition } from '@smart-farm/shared/schemas/status-code';
import { MS_PER_MINUTE } from '@smart-farm/shared/time';

/** 受信が計測より何分遅れたら「遅延」とするか（暫定）。 */
export const DEFAULT_LATE_AFTER_MINUTES = 60;

/** 評価に使う品質（正常と遅延）。 */
export function isUsableQuality(quality: ObservationQuality): boolean {
  return quality === 'VALID' || quality === 'LATE';
}

/** 取り込みで、拒否した値として数える品質（欠損と不正）。 */
export function isRejectedQuality(quality: ObservationQuality): boolean {
  return quality === 'MISSING' || quality === 'INVALID';
}

export interface QualityVerdict {
  readonly quality: ObservationQuality;
  /** 不正の理由。内部情報を含めない。 */
  readonly reason?: string;
}

export interface QualityContext {
  readonly observedAt: Date;
  readonly receivedAt: Date;
  readonly lateAfterMinutes: number;
  readonly statusCodes: ReadonlyMap<string, StatusCodeDefinition>;
}

export function classifyValue(
  itemKey: string,
  rawValue: unknown,
  context: QualityContext,
): QualityVerdict {
  const item = findItemDefinition(itemKey);
  if (item === undefined) {
    return { quality: 'INVALID', reason: `未定義の項目です: ${itemKey}` };
  }
  const lagMinutes = (context.receivedAt.getTime() - context.observedAt.getTime()) / MS_PER_MINUTE;
  if (lagMinutes < -FUTURE_TOLERANCE_MINUTES) {
    return { quality: 'INVALID', reason: '計測日時が未来です' };
  }
  if (rawValue === null || rawValue === undefined) {
    return { quality: 'MISSING' };
  }
  if (!isValidItemValue(item, rawValue)) {
    return { quality: 'INVALID', reason: `値が型・範囲に合いません: ${item.label}` };
  }
  if (itemKey === STATUS_CODE_ITEM_KEY && typeof rawValue === 'string') {
    const definition = context.statusCodes.get(rawValue);
    if (definition === undefined || definition.isDeleted) {
      return { quality: 'INVALID', reason: '未定義のステータスコードです' };
    }
  }
  return lagMinutes > context.lateAfterMinutes ? { quality: 'LATE' } : { quality: 'VALID' };
}
