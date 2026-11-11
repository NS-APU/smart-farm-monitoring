/**
 * 取り込み元の代表の取得間隔（分）。「データが古い」の判定・「データ取得停止」の通知の基準に使う。
 * 取得間隔は、設備ごとの設定（Issue #197）のため、その種別（ロボット／センサー）の有効な設備の、最長の取得間隔にする（最短にすると、間隔の長い設備が、取得の前に「古い」とされるため）。
 * 設備が 1 つもなければ、種別ごとの既定の間隔。設備ごとの基準への置き換えは、#198。
 */

import { DEFAULT_INTERVAL_MINUTES_BY_TYPE } from '@smart-farm/shared/constants/status';
import { effectiveIntervalMinutes, type Equipment } from '@smart-farm/shared/schemas/equipment';
import type { IngestionSource } from '@smart-farm/shared/schemas/ingestion';

export function representativeIntervalMinutes(
  kind: IngestionSource['kind'],
  equipment: readonly Pick<Equipment, 'equipmentType' | 'intervalMinutes'>[],
): number {
  const intervals = equipment
    .filter((item) => item.equipmentType === kind)
    .map((item) => effectiveIntervalMinutes(item))
    .filter((interval): interval is number => interval !== undefined);
  return intervals.length === 0
    ? DEFAULT_INTERVAL_MINUTES_BY_TYPE[kind === 'ROBOT' ? 'ROBOT' : 'SENSOR']
    : Math.max(...intervals);
}
