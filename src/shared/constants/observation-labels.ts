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

export interface ObservationQualityMeaning {
  /** 状態の意味（画面の凡例にそのまま表示する）。 */
  readonly meaning: string;
  /** 評価に使うか。 */
  readonly usedInEvaluation: boolean;
}

/**
 * 状態（有効・欠損・遅延・不正）の意味と、評価での扱い（ADR-0016 の D-10 の定義の転記）。
 * 遅延・未来の許容の時間は設定値（既定は 60 分・5 分）のため、「一定時間（既定 …）」と書く。
 */
export const OBSERVATION_QUALITY_MEANINGS: Readonly<
  Record<ObservationQuality, ObservationQualityMeaning>
> = {
  VALID: { meaning: '欠損・遅延・不正のどれでもない、通常のデータです', usedInEvaluation: true },
  MISSING: { meaning: '値がありません（0 で代用しません）', usedInEvaluation: false },
  LATE: {
    meaning: '受信が、計測から一定時間（既定 60 分）を超えて遅れたデータです',
    usedInEvaluation: true,
  },
  INVALID: {
    meaning:
      '型・範囲が合わない値、未定義のステータスコード、計測日時が受信より一定時間（既定 5 分）を超えて未来のデータです',
    usedInEvaluation: false,
  },
};
