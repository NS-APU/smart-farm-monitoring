/**
 * データ項目のカタログ（data-dictionary.md 4〜5章）。
 * 項目の名前・型・単位・取得元を1か所に定義し、検証・集計・画面の表示で共有する。
 * 状態は「仮」（取り込みの仕様が未提供。Q-001, Q-003, Q-004）。確定仕様の提供後に更新する。
 */

import type { ObservationSource } from './status.ts';
import { VIEWPOINTS } from './viewpoints.ts';

export const CATEGORIES = [
  'HARVEST',
  'OPERATION',
  'STATUS',
  'ENVIRONMENT',
  'OPERABILITY',
  'SAFETY',
  'COST',
  'FAILURE',
  'SATISFACTION',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  HARVEST: '収穫情報',
  OPERATION: '稼働情報',
  STATUS: 'ステータス',
  ENVIRONMENT: '環境情報',
  OPERABILITY: '操作情報',
  SAFETY: '安全情報',
  COST: 'コスト情報',
  FAILURE: '故障情報',
  SATISFACTION: '満足度情報',
};

/** 手動入力で選べるカテゴリ（FR-4.1。稼働情報・ステータスは自動取り込みのみ）。 */
export const MANUAL_INPUT_CATEGORIES: readonly Category[] = [
  'OPERABILITY',
  'HARVEST',
  'SAFETY',
  'COST',
  'FAILURE',
  'ENVIRONMENT',
  'SATISFACTION',
];

export type ItemValueType = 'integer' | 'number' | 'string';

/**
 * 集計の種類（dev_spec.md 4章の暫定仕様）。
 * - TOTAL: 期間内の合計（件数・時間・金額など、記録ごとの発生量）
 * - LEVEL: 状態値。短期は期間内の最新値、長期は期間内の平均
 * - STATUS: ステータスコード。短期は最新、長期は期間内で最も悪いカテゴリ
 */
export type ItemAggregation = 'TOTAL' | 'LEVEL' | 'STATUS';

export interface ItemDefinition {
  readonly itemKey: string;
  readonly category: Category;
  readonly label: string;
  readonly unit: string;
  readonly valueType: ItemValueType;
  readonly min?: number;
  readonly max?: number;
  readonly aggregation: ItemAggregation;
  readonly origins: readonly ObservationSource[];
}

const AUTO: readonly ObservationSource[] = ['AUTO_IMPORT'];
const MANUAL: readonly ObservationSource[] = ['MANUAL'];
const BOTH: readonly ObservationSource[] = ['AUTO_IMPORT', 'MANUAL'];

/** ステータスコードの項目キー（評価では、ステータスの判定の入力として特別に扱う）。 */
export const STATUS_CODE_ITEM_KEY = 'statusCode';
/** 満足度の項目の、スターの上限（1〜この値）。 */
export const SATISFACTION_MAX_STARS = 5;

export function satisfactionItemKey(viewpointId: string): string {
  return `satisfaction.${viewpointId}`;
}

/** 満足度の項目: 満足度以外の9観点に対する、1〜5 スターの評価（整数）。 */
const SATISFACTION_ITEMS: readonly ItemDefinition[] = VIEWPOINTS.filter(
  (viewpoint) => viewpoint.id !== 'satisfaction',
).map((viewpoint) => ({
  itemKey: satisfactionItemKey(viewpoint.id),
  category: 'SATISFACTION',
  label: `満足度（${viewpoint.name}）`,
  unit: 'スター',
  valueType: 'integer',
  min: 1,
  max: SATISFACTION_MAX_STARS,
  aggregation: 'LEVEL',
  origins: MANUAL,
}));

export const ITEM_CATALOG: readonly ItemDefinition[] = [
  // 自動取り込み（ロボットデータ）。data-dictionary.md 5.1
  {
    itemKey: 'harvestCount',
    category: 'HARVEST',
    label: '収穫数',
    unit: '個',
    valueType: 'integer',
    min: 0,
    aggregation: 'TOTAL',
    origins: AUTO,
  },
  // データ辞書（data-dictionary.md）の項目。自動取り込み（robot-json）と合成データが使う。参考の項目で、収穫速度の平均処理時間は、収穫稼働時間と収穫数から算出する。
  // 削除すると、手動入力の選択肢・取り込みの扱い（未定義の項目は不正として拒否）が変わるため、勝手に消さない。
  {
    itemKey: 'harvestSecondsPerFruit',
    category: 'HARVEST',
    label: '1果実あたりの収穫時間',
    unit: '秒/果実',
    valueType: 'number',
    min: 0,
    aggregation: 'LEVEL',
    origins: AUTO,
  },
  {
    itemKey: 'operatingHours',
    category: 'OPERATION',
    label: '稼働時間',
    unit: '時間',
    valueType: 'number',
    min: 0,
    aggregation: 'TOTAL',
    origins: AUTO,
  },
  // データ辞書（data-dictionary.md）の項目。自動取り込み（robot-json）と合成データが使う。参考の項目で、どの観点の判定にも使わない。
  // 削除すると、手動入力の選択肢・取り込みの扱い（未定義の項目は不正として拒否）が変わるため、勝手に消さない。
  {
    itemKey: 'standbyHours',
    category: 'OPERATION',
    label: '待機時間',
    unit: '時間',
    valueType: 'number',
    min: 0,
    aggregation: 'TOTAL',
    origins: AUTO,
  },
  {
    itemKey: 'harvestOperatingHours',
    category: 'OPERATION',
    label: '収穫稼働時間',
    unit: '時間',
    valueType: 'number',
    min: 0,
    aggregation: 'TOTAL',
    origins: AUTO,
  },
  {
    itemKey: 'travelStoppedHours',
    category: 'OPERATION',
    label: '走行停止時間',
    unit: '時間',
    valueType: 'number',
    min: 0,
    aggregation: 'TOTAL',
    origins: AUTO,
  },
  {
    itemKey: STATUS_CODE_ITEM_KEY,
    category: 'STATUS',
    label: 'ステータスコード',
    unit: '',
    valueType: 'string',
    aggregation: 'STATUS',
    origins: AUTO,
  },
  // 環境情報（環境センサー、手動入力）
  {
    itemKey: 'temperatureCelsius',
    category: 'ENVIRONMENT',
    label: '温度',
    unit: '℃',
    valueType: 'number',
    aggregation: 'LEVEL',
    origins: BOTH,
  },
  {
    itemKey: 'humidityPercent',
    category: 'ENVIRONMENT',
    label: '湿度',
    unit: '%',
    valueType: 'number',
    min: 0,
    max: 100,
    aggregation: 'LEVEL',
    origins: BOTH,
  },
  {
    itemKey: 'illuminanceLux',
    category: 'ENVIRONMENT',
    label: '照度',
    unit: 'lx',
    valueType: 'number',
    min: 0,
    aggregation: 'LEVEL',
    origins: BOTH,
  },
  {
    itemKey: 'co2Ppm',
    category: 'ENVIRONMENT',
    label: 'CO2濃度',
    unit: 'ppm',
    valueType: 'number',
    min: 0,
    aggregation: 'LEVEL',
    origins: BOTH,
  },
  // 手動入力。data-dictionary.md 5.2
  {
    itemKey: 'operationMinutes',
    category: 'OPERABILITY',
    label: '操作時間',
    unit: '分',
    valueType: 'number',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  {
    itemKey: 'operationStepCount',
    category: 'OPERABILITY',
    label: '操作ステップ数',
    unit: '回',
    valueType: 'integer',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  {
    itemKey: 'operationErrorCount',
    category: 'OPERABILITY',
    label: '操作エラー数',
    unit: '回',
    valueType: 'integer',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  // データ辞書（data-dictionary.md）の項目。手動入力の項目として画面に出る。参考の項目で、どの観点の判定にも使わない。
  // 削除すると、手動入力の選択肢・取り込みの扱い（未定義の項目は不正として拒否）が変わるため、勝手に消さない。
  {
    itemKey: 'harvestAttemptCount',
    category: 'HARVEST',
    label: '収穫試行回数',
    unit: '回',
    valueType: 'integer',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  // データ辞書（data-dictionary.md）の項目。手動入力の項目として画面に出る。収穫数の代替の候補（要確認）で、どの観点の判定にも使わない。
  // 削除すると、手動入力の選択肢・取り込みの扱い（未定義の項目は不正として拒否）が変わるため、勝手に消さない。
  {
    itemKey: 'harvestSuccessCount',
    category: 'HARVEST',
    label: '収穫成功回数',
    unit: '回',
    valueType: 'integer',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  {
    itemKey: 'damagedFruitCount',
    category: 'HARVEST',
    label: '果実損傷数',
    unit: '個',
    valueType: 'integer',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  // データ辞書（data-dictionary.md）の項目。手動入力の項目として画面に出る。未使用（要否は要確認）で、どの観点の判定にも使わない。
  // 削除すると、手動入力の選択肢・取り込みの扱い（未定義の項目は不正として拒否）が変わるため、勝手に消さない。
  {
    itemKey: 'misrecognitionCount',
    category: 'HARVEST',
    label: '誤認識数',
    unit: '回',
    valueType: 'integer',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  {
    itemKey: 'wrongHarvestCount',
    category: 'HARVEST',
    label: '誤収穫数',
    unit: '個',
    valueType: 'integer',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  {
    itemKey: 'missedFruitCount',
    category: 'HARVEST',
    label: '取り残し数',
    unit: '個',
    valueType: 'integer',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  {
    itemKey: 'emergencyStopCount',
    category: 'SAFETY',
    label: '緊急停止回数',
    unit: '回',
    valueType: 'integer',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  {
    itemKey: 'nearMissCount',
    category: 'SAFETY',
    label: 'ヒヤリハット件数',
    unit: '件',
    valueType: 'integer',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  {
    itemKey: 'robotCostYenPerHour',
    category: 'COST',
    label: 'ロボットコスト',
    unit: '円/時間',
    valueType: 'number',
    min: 0,
    aggregation: 'LEVEL',
    origins: MANUAL,
  },
  {
    itemKey: 'laborCostYenPerHour',
    category: 'COST',
    label: '人件費',
    unit: '円/時間',
    valueType: 'number',
    min: 0,
    aggregation: 'LEVEL',
    origins: MANUAL,
  },
  {
    itemKey: 'maintenanceCostYen',
    category: 'COST',
    label: 'メンテナンス費',
    unit: '円',
    valueType: 'number',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  {
    itemKey: 'electricityCostYen',
    category: 'COST',
    label: '電気代',
    unit: '円',
    valueType: 'number',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  {
    itemKey: 'failureCount',
    category: 'FAILURE',
    label: '故障回数',
    unit: '回',
    valueType: 'integer',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  {
    itemKey: 'recoveryMinutes',
    category: 'FAILURE',
    label: '復旧に要した時間',
    unit: '分',
    valueType: 'number',
    min: 0,
    aggregation: 'TOTAL',
    origins: MANUAL,
  },
  ...SATISFACTION_ITEMS,
];

const ITEM_BY_KEY: ReadonlyMap<string, ItemDefinition> = new Map(
  ITEM_CATALOG.map((item) => [item.itemKey, item]),
);

export function findItemDefinition(itemKey: string): ItemDefinition | undefined {
  return ITEM_BY_KEY.get(itemKey);
}

export function itemsOfCategory(category: Category): readonly ItemDefinition[] {
  return ITEM_CATALOG.filter((item) => item.category === category);
}

/** 項目の値が、カタログの型・範囲に合うかを返す（取り込み・手動入力の検証で使う）。 */
export function isValidItemValue(item: ItemDefinition, value: unknown): boolean {
  if (item.valueType === 'string') {
    return typeof value === 'string' && value.length > 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  if (item.valueType === 'integer' && !Number.isInteger(value)) {
    return false;
  }
  if (item.min !== undefined && value < item.min) {
    return false;
  }
  return item.max === undefined || value <= item.max;
}
