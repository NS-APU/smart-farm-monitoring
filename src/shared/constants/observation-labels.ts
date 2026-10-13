/** 観測値の取得元・状態の表示名（取り込み済みデータ・元データの一覧。FR-6.8）。 */

import type { ObservationQuality, ObservationSource } from './status.ts';

export const OBSERVATION_SOURCE_LABELS: Readonly<Record<ObservationSource, string>> = {
  AUTO_IMPORT: '自動取り込み',
  MANUAL: '手動入力',
};

export const OBSERVATION_QUALITY_LABELS: Readonly<Record<ObservationQuality, string>> = {
  VALID: '有効',
  MISSING: '欠損',
  LATE: '遅延',
  INVALID: '不正',
};
