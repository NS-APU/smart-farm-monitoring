/** 手動入力（SC-06）の画面操作の補助: フォームの入力・保存・エラーの確認。 */

import { expect, type Locator, type Page } from '@playwright/test';

export interface EntryFormValues {
  /** 設備の識別子（例: ROBOT-01）。 */
  readonly equipment?: string;
  /** カテゴリのコード（例: FAILURE）。 */
  readonly category?: string;
  /** 計測日時（日本時間。`2026-10-09T11:00` の形式）。 */
  readonly observedAt?: string;
  /** 項目の表示名（単位を除く） → 入力する文字列。 */
  readonly items?: Readonly<Record<string, string>>;
  readonly note?: string;
}

/** 画面の本文（ヘッダーの設備の選択と区別する）。 */
export const mainArea = (page: Page): Locator => page.getByRole('main');

/** 手動入力のフォームに入力する（指定した項目だけ）。 */
export async function fillEntryForm(
  page: Page,
  values: EntryFormValues,
  form: Locator = mainArea(page),
): Promise<void> {
  if (values.equipment !== undefined) {
    await form.getByLabel('対象の設備').selectOption(values.equipment);
  }
  if (values.category !== undefined) {
    await form.getByLabel('カテゴリ').selectOption(values.category);
  }
  if (values.observedAt !== undefined) {
    await form.getByLabel('計測日時（日本時間）').fill(values.observedAt);
  }
  for (const [label, text] of Object.entries(values.items ?? {})) {
    await form.getByTestId('entry-items').getByLabel(label).fill(text);
  }
  if (values.note !== undefined) {
    await form.getByLabel('備考（所感・補足情報）').fill(values.note);
  }
}

/** 保存する（新規の入力）。 */
export async function saveEntry(page: Page): Promise<void> {
  await mainArea(page).getByRole('button', { name: '保存する' }).click();
}

/** 項目のエラーの表示（項目名は、`equipmentId`・`items.failureCount` など）。 */
export function fieldError(page: Page, name: string, scope: Locator = mainArea(page)): Locator {
  return scope.locator(`[data-field="${name}"] .field-error`);
}

/** 保存後の結果の欄の、観点のステータスを確認する。 */
export async function expectRelatedStatus(
  page: Page,
  viewpointId: string,
  status: string,
): Promise<void> {
  const row = page.getByTestId(`related-${viewpointId}`);
  await expect(row).toBeVisible();
  await expect(row.locator('.status-badge')).toContainText(status);
}
