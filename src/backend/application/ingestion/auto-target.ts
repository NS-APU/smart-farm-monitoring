/**
 * 自動取り込みの対象の判定（Issue #202。ADR-0016 の D-12）。設備は、次のすべてを満たすとき、自動取り込みの対象。
 * - 同じ種別（ロボット・センサー）の取り込み元が、有効（取り込み設定の「自動取り込みを有効にする」）
 * - 取得先がある: 接続方式 HTTP は、設備ごとのファイルパス（`sourceFilePath`）。モック・S3 は、種別が合えば対象
 * 対象でない設備（手動のみの運用）は、「古い」「未取得」の警告を出さず、最終の手動入力を示す。
 */

import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { IngestionSource } from '@smart-farm/shared/schemas/ingestion';

export function isAutoIngestionTarget(
  equipment: Pick<Equipment, 'equipmentType' | 'sourceFilePath'>,
  sources: readonly IngestionSource[],
): boolean {
  return sources.some(
    (source) =>
      source.isEnabled &&
      source.kind === equipment.equipmentType &&
      (source.connection.type === 'MOCK' || equipment.sourceFilePath !== undefined),
  );
}
