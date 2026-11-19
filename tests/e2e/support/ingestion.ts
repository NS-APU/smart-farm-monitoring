/**
 * 取り込み設定・状況（SC-11。UC-15、UC-16）の画面操作の補助。接続は、設備ごと（Issue #367。ADR-0026）。SC-11 は、取り込み元ごとのカードに、
 * 設備ごとの表（接続先・接続テストなど）を持つ。接続・認証情報の入力は、設備のダイアログ（SC-10。UC-15 の E2E）で行う。
 */

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

/** 設備ごとの表の行（`equipment-run-<設備 ID>`）。 */
export const equipmentRow = (page: Page, equipmentId: string): Locator =>
  page.getByTestId(`equipment-run-${equipmentId}`);

/**
 * 設備の接続テスト（SC-11 の設備ごとの表のボタン）を実行し、結果の表示を待つ。結果は設備ごとに残る（再び実行すると、置き換わる）ため、
 * 続けて実行するときは、結果の文言で、置き換わるまで待つ。
 */
export async function testEquipmentConnection(page: Page, equipmentId: string): Promise<Locator> {
  await page.getByTestId(`equipment-test-${equipmentId}`).click();
  const result = page.getByTestId(`equipment-test-result-${equipmentId}`);
  await expect(result).toBeVisible();
  return result;
}
