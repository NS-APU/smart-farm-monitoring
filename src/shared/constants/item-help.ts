/**
 * データ入力（SC-06）の、入力項目・カテゴリの説明（ヘルプヒントに表示する。Issue #154 の PR2）。
 * 説明は、既存の設計の定義から書く（data-dictionary.md 4・5 章、viewpoint/、ADR-0017）。定義のない項目には、説明を付けない。
 * 次の項目は、別の Issue で、実装・決定にあわせて説明を付けるため、ここには含めない（文言が先走らないようにする）:
 * - コスト情報の 4 項目（単位が円/時間にそろう。D-20。#215）
 * - 故障情報（復旧に要した時間の単位・MTTR、同じ入力の中の合計。D-21。#215）
 * - 操作情報の 3 項目（1 回の作業あたりの入力。D-22。#217）
 * - 合計の項目（収穫数・稼働時間・待機時間・収穫稼働時間・走行停止時間）の値の意味（今日これまでの累計など。D-26。#162）
 */

import type { Category } from './items.ts';

export interface ItemHelp {
  /** 項目の意味。 */
  readonly help: string;
  /** 入力例（数値の項目。保存できる範囲に収まる値）。 */
  readonly example?: string;
}

const ITEM_HELP: Readonly<Record<string, ItemHelp>> = {
  harvestSecondsPerFruit: {
    help: '1果実の収穫にかかった時間です。参考の項目で、観点の判定には使いません',
    example: '45',
  },
  temperatureCelsius: {
    help: 'ハウス内の温度です。環境適応性の評価に使います',
    example: '23.5',
  },
  humidityPercent: {
    help: 'ハウス内の湿度です。環境適応性の評価に使います',
    example: '65',
  },
  illuminanceLux: {
    help: 'ハウス内の照度です。環境適応性の評価に使います',
    example: '30000',
  },
  co2Ppm: {
    help: 'ハウス内のCO2濃度です。環境適応性の評価に使います',
    example: '900',
  },
  statusCode: {
    help: 'ロボットの状態を表すコードです。コードのカテゴリ（正常・注意・異常）が、収穫速度・メンテナンス性・耐久性の判定に使われます',
  },
  harvestAttemptCount: { help: '参考の項目です。観点の判定には使いません' },
  harvestSuccessCount: { help: '参考の項目です。観点の判定には使いません' },
  misrecognitionCount: { help: '参考の項目です。観点の判定には使いません' },
  damagedFruitCount: {
    help: '収穫した果実のうち、損傷したものの数です。収穫精度・コスト効率の評価に使います',
  },
  wrongHarvestCount: {
    help: '誤って収穫した果実の数です。収穫精度・コスト効率の評価に使います',
  },
  missedFruitCount: {
    help: '取り残した果実の数です。収穫精度の評価に使います',
  },
  emergencyStopCount: {
    help: '緊急停止した回数です。安全性の評価に使います',
  },
  nearMissCount: {
    help: 'ヒヤリハット（事故や損傷にはならなかったが、ロボットの動作で、人・作物・設備に、危害や損傷を与えかけた出来事）の件数です。緊急停止を伴う出来事は、緊急停止の回数に数え、ここには数えません。1つの出来事を1件とし、気づいたときに記録します。安全性の評価に使います',
  },
};

/** 説明のある項目の識別子。 */
export const ITEM_HELP_KEYS: readonly string[] = Object.keys(ITEM_HELP);

/** 項目の説明。説明のない項目は undefined。 */
export function findItemHelp(itemKey: string): ItemHelp | undefined {
  return ITEM_HELP[itemKey];
}

/** カテゴリの説明（data-dictionary.md 4 章の「内容」）。 */
export const CATEGORY_HELP: Readonly<Record<Category, string>> = {
  HARVEST: '収穫の数・品質',
  OPERATION: '稼働・待機・停止の時間',
  STATUS: 'ロボットの状態のコード',
  ENVIRONMENT: 'ハウスの環境',
  OPERABILITY: '人による操作',
  SAFETY: '緊急停止・ヒヤリハット',
  COST: '運用の費用',
  FAILURE: '故障・復旧',
  SATISFACTION: '観点への 1〜5 スター',
};
