/**
 * 画面のパス（URL）の定義。ルート表・メニュー・各画面のリンクが、同じ定義を使う
 * （機能仕様書 2.1 の画面の一覧に対応する）。
 */

export const PATHS = {
  dashboard: '/',
  login: '/login',
  satisfaction: '/satisfaction',
  notifications: '/notifications',
  dataEntry: '/data-entry',
  dataEntryList: '/data-entry/list',
  dataEntryHistory: '/data-entry/history',
  observations: '/observations',
  settingsEquipment: '/settings/equipment',
  settingsIngestion: '/settings/ingestion',
  settingsStatusCodes: '/settings/status-codes',
  settingsUsers: '/settings/users',
  settingsPush: '/settings/push',
  /** 観点の詳細。 */
  viewpoint: (viewpointId: string) => `/viewpoints/${viewpointId}`,
  /** 判断基準の編集。 */
  criteria: (viewpointId: string) => `/viewpoints/${viewpointId}/criteria`,
} as const;

/** ルート表で使う、パラメータつきのパターン（`:名前` がパラメータ）。 */
export const ROUTE_PATTERNS = {
  viewpoint: '/viewpoints/:viewpointId',
  criteria: '/viewpoints/:viewpointId/criteria',
} as const;
