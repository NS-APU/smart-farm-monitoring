/**
 * 通知（UC-05、UC-10、UC-22、UC-24）の E2E の補助: 通知の発生（異常な環境の値・取り込みの失敗）と、API での確認・既読化。
 */

import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { advanceMinutes, api, apiOk, setMock } from './app.ts';
import { environmentData, seed } from './viewpoint-scenarios.ts';

export interface ApiNotification {
  readonly notificationId: string;
  readonly kind: 'STATUS_CHANGE' | 'INGESTION_FAILURE';
  readonly viewpointId?: string;
  readonly equipmentId?: string;
  readonly sourceId?: string;
  readonly status?: string;
  readonly message: string;
  readonly createdAt: string;
  readonly readState: 'UNREAD' | 'READ';
}

/** 温度 40℃（異常）の環境の値を入れて、評価する。環境適応性（ハウス・センサー）と、データ活用度合い（ハウス）の通知が作られる。 */
export async function seedAbnormalEnvironment(request: APIRequestContext): Promise<void> {
  await seed(request, environmentData({ temperature: 40 }));
}

/** ファイルサーバーを停止して、指定の取り込み元を取り込み、取り込み失敗の通知を作る（その後、ファイルサーバーを復旧する）。 */
export async function failIngestion(
  request: APIRequestContext,
  sourceIds: readonly string[],
): Promise<void> {
  await setMock(request, 'file-server', 'DOWN');
  for (const sourceId of sourceIds) {
    await apiOk(request, 'POST', `/ingestion/${sourceId}/run`);
  }
  await setMock(request, 'file-server', 'UP');
}

/** 抑制の期間（60分）を超えて、取り込み失敗を繰り返し、通知を count 件作る。 */
export async function failIngestionRepeatedly(
  request: APIRequestContext,
  count: number,
): Promise<void> {
  await setMock(request, 'file-server', 'DOWN');
  for (let index = 0; index < count; index += 1) {
    await apiOk(request, 'POST', '/ingestion/robot/run');
    await advanceMinutes(request, 61);
  }
  await setMock(request, 'file-server', 'UP');
}

/** ログイン中の利用者の通知の一覧（API。新しい順）。 */
export async function listNotifications(
  request: APIRequestContext,
  query = '',
): Promise<ApiNotification[]> {
  const body = await apiOk<{ items: ApiNotification[] }>(
    request,
    'GET',
    `/notifications?limit=100${query}`,
  );
  return body.items;
}

/** 通知を API で既読にする（前提の用意）。 */
export async function markReadViaApi(
  request: APIRequestContext,
  notificationId: string,
): Promise<void> {
  const response = await api(request, 'POST', `/notifications/${notificationId}/read`);
  expect(response.status()).toBe(204);
}

/** 通知の一覧の画面の、行の数。 */
export async function rowCount(page: Page): Promise<number> {
  return page.getByTestId('notification-row').count();
}
