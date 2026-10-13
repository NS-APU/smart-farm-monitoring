/**
 * ステータス（観点の判定結果）と関連する列挙値。
 * 識別子は data-dictionary.md 8.2 に従う。画面の表示名は別に持つ（STATUS_LABELS）。
 */

export const EVALUATION_STATUSES = ['NORMAL', 'CAUTION', 'ERROR', 'UNKNOWN'] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

/** 観測値から判定できる区分（「不明」を除く）。ステータスコードのカテゴリも同じ3区分。 */
export const JUDGED_STATUSES = ['NORMAL', 'CAUTION', 'ERROR'] as const;
export type JudgedStatus = (typeof JUDGED_STATUSES)[number];

export const STATUS_LABELS: Readonly<Record<EvaluationStatus, string>> = {
  NORMAL: '正常',
  CAUTION: '注意',
  ERROR: '異常',
  UNKNOWN: '不明',
};

/**
 * 「不明」（判定に必要なデータが足りない、または評価前）のときの推奨アクション（FR-5.5。文言は暫定。Q-010）。
 * 評価の結果（バックエンド）と、評価前の観点の表示（フロントエンド）で、同じ文言を使う。
 */
export const UNKNOWN_ACTION = 'データの取得・入力を確認してください（取り込みの状況、手動入力）';

/** 色だけに頼らない表示（NFR-7.2）のためのアイコン文字。 */
export const STATUS_ICONS: Readonly<Record<EvaluationStatus, string>> = {
  NORMAL: '✔',
  CAUTION: '▲',
  ERROR: '✖',
  UNKNOWN: '?',
};

/** 悪さの順位。大きいほど悪い。「不明」は比較に使わない（evaluation.md 3章・5章）。 */
export const STATUS_SEVERITY: Readonly<Record<JudgedStatus, number>> = {
  NORMAL: 1,
  CAUTION: 2,
  ERROR: 3,
};

export const HORIZONS = ['SHORT', 'LONG'] as const;
export type Horizon = (typeof HORIZONS)[number];

/** 長期視点の期間（日）。既定は 7（FR-5.6）。 */
export const PERIOD_DAYS_OPTIONS = [1, 7, 30, 60, 90] as const;
export type PeriodDays = (typeof PERIOD_DAYS_OPTIONS)[number];
export const DEFAULT_PERIOD_DAYS: PeriodDays = 7;

export const EQUIPMENT_TYPES = ['FACILITY', 'ROBOT', 'SENSOR'] as const;
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export const OBSERVATION_SOURCES = ['AUTO_IMPORT', 'MANUAL'] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export const OBSERVATION_QUALITIES = ['VALID', 'MISSING', 'LATE', 'INVALID'] as const;
export type ObservationQuality = (typeof OBSERVATION_QUALITIES)[number];

export const NOTIFICATION_KINDS = ['STATUS_CHANGE', 'INGESTION_FAILURE'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const READ_STATES = ['UNREAD', 'READ'] as const;
export type ReadState = (typeof READ_STATES)[number];

/** 連携キューの項目の状態。 */
export const FEDERATION_STATUSES = ['PENDING', 'SENT', 'FAILED', 'HELD'] as const;
export type FederationStatus = (typeof FEDERATION_STATUSES)[number];
/** 連携の送信結果（成功／失敗／保留。FR-8.3）。キューの状態から、送信前の PENDING を除いたもの。 */
export const FEDERATION_RESULTS = ['SENT', 'FAILED', 'HELD'] as const;
export type FederationResult = (typeof FEDERATION_RESULTS)[number];

/** 取得間隔の候補（分）。FR-1.5。 */
export const INGESTION_INTERVAL_MINUTES_OPTIONS = [5, 15, 30, 60, 360, 1440] as const;
export type IngestionIntervalMinutes = (typeof INGESTION_INTERVAL_MINUTES_OPTIONS)[number];
