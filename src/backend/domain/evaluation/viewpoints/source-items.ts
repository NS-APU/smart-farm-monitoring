/**
 * 観点の「元データ」にあたる観測値の項目（FR-6.4。詳細画面で、分析に使ったデータを参照する）。
 * 観点の入力（必須の入力と、判断基準で直接判定する項目）のうち、項目カタログにあるものを返す。
 * 入力が集計値のみ（例: データ活用度合い）の観点は、すべての観測値が対象のため、null を返す。
 */

import { findItemDefinition } from '@smart-farm/shared/constants/items';
import type { ViewpointDefinition } from '../definition.ts';

export function viewpointSourceItemKeys(definition: ViewpointDefinition): readonly string[] | null {
  const candidates = new Set([...definition.requiredInputs, ...definition.judgedIndicators]);
  const itemKeys = [...candidates].filter((key) => findItemDefinition(key) !== undefined);
  return itemKeys.length === 0 ? null : itemKeys;
}
