/** 取り込み設定・状況（SC-11。UC-15、UC-16）の画面操作の補助。 */

import { expect, type Locator, type Page } from '@playwright/test';

export type SourceId = 'robot' | 'environment-sensor';

export const SOURCE_NAMES: Readonly<Record<SourceId, string>> = {
  robot: 'ロボットデータ',
  'environment-sensor': '環境センサーデータ',
};

/** 取り込み元のカード。 */
export const sourceCard = (page: Page, sourceId: SourceId): Locator =>
  page.getByTestId(`source-${sourceId}`);

/** 取り込みのログの行（新しい順）。 */
export const logRows = (page: Page): Locator => page.getByTestId('ingestion-log-row');

/** 連携の結果の行（新しい順）。 */
export const federationRows = (page: Page): Locator => page.getByTestId('federation-log-row');

/** 即時取得を実行し、結果の表示を待つ。 */
export async function runNow(page: Page, sourceId: SourceId): Promise<Locator> {
  const card = sourceCard(page, sourceId);
  await card.getByRole('button', { name: '即時取得' }).click();
  const result = page.getByTestId(`result-${sourceId}`);
  await expect(result).toBeVisible();
  return result;
}

/** 接続テストを実行し、結果の表示を待つ。 */
export async function testConnection(page: Page, sourceId: SourceId): Promise<Locator> {
  const card = sourceCard(page, sourceId);
  await card.getByRole('button', { name: '接続テスト' }).click();
  const result = page.getByTestId(`result-${sourceId}`);
  await expect(result).toBeVisible();
  return result;
}
