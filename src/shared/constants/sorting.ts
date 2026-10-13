/** 一覧の並べ替え（項目と向き）。API のクエリ・Repository のポート・画面が、同じ定義を使う。 */

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/** 観測値の一覧（元データ・取り込み済みデータ）の並べ替えの項目。 */
export const OBSERVATION_SORT_KEYS = ['observedAt', 'category', 'value'] as const;
export type ObservationSortKey = (typeof OBSERVATION_SORT_KEYS)[number];

/** 入力済みデータ（手動入力）の一覧の並べ替えの項目。 */
export const MANUAL_ENTRY_SORT_KEYS = ['observedAt', 'category', 'enteredBy'] as const;
export type ManualEntrySortKey = (typeof MANUAL_ENTRY_SORT_KEYS)[number];
