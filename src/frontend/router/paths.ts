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
  /** 変更履歴を、対象の種類と ID で絞って開く（クエリは、変更履歴の絞り込みの条件。#155）。 */
  historyOf: (targetType: string, targetId: string) =>
    `/data-entry/history?${new URLSearchParams({ targetType, targetId }).toString()}`,
  /** 入力済みデータを、設備と、計測日（日本時間。`2026-10-09`）で絞って開く（#155）。 */
  entriesOf: (equipmentId: string, date: string) =>
    `/data-entry/list?${new URLSearchParams({ equipmentId, from: date, to: date }).toString()}`,
  observations: '/observations',
  settingsEquipment: '/settings/equipment',
  settingsIngestion: '/settings/ingestion',
  settingsStatusCodes: '/settings/status-codes',
  settingsUsers: '/settings/users',
  settingsPush: '/settings/push',
  /** パスワードの変更（本人。変更が必要な利用者は、ログイン後に、この画面だけが使える。D-45）。 */
  changePassword: '/change-password',
  /** 自身のユーザー名の変更（本人。ロール・ユーザー ID は、変えられない。FR-9.7）。 */
  profile: '/profile',
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
