/**
 * 画面のパス（URL）の定義。ルート表・メニュー・各画面のリンクが、同じ定義を使う
 * （機能仕様書 2.1 の画面の一覧に対応する）。
 */

import type { PeriodDays } from '@smart-farm/shared/constants/status';

export const PATHS = {
  dashboard: '/',
  login: '/login',
  satisfaction: '/satisfaction',
  notifications: '/notifications',
  dataEntry: '/data-entry',
  /** データ入力を、対象の設備を指定して開く（「対応の結果を記録する」から。初期値は、直前に入力した設備より優先する。#155）。 */
  dataEntryFor: (equipmentId: string) =>
    `/data-entry?${new URLSearchParams({ equipmentId }).toString()}`,
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

/**
 * 観点の詳細を、ドロワーで開くパス（ダッシュボードの URL に、`viewpoint` を付ける。Issue #357）。
 * 期間は、選んでいるときだけ付ける（選んでいなければ、観点ごとの既定の期間。ダッシュボードの期間を、勝手に選んだことにしない）。
 * 視点は、付けない（ドロワーの既定は、長期）。
 */
export function viewpointDrawerPath(
  viewpointId: string,
  selectedPeriodDays: PeriodDays | undefined,
): string {
  const query = new URLSearchParams({ viewpoint: viewpointId });
  if (selectedPeriodDays !== undefined) {
    query.set('periodDays', String(selectedPeriodDays));
  }
  return `${PATHS.dashboard}?${query.toString()}`;
}
