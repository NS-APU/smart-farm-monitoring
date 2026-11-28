/** 手動入力（SC-06）の画面操作の補助: フォームの入力・保存・エラーの確認。 */

import { expect, type Locator, type Page } from '@playwright/test';
import {
  SATISFACTION_TARGET_VIEWPOINT_IDS,
  findViewpointMeta,
} from '../../../src/shared/constants/viewpoints.ts';

export interface EntryFormValues {
  /** 設備の識別子（例: ROBOT-01）。 */
  readonly equipment?: string;
  /** カテゴリのコード（例: FAILURE）。 */
  readonly category?: string;
  /** 計測日時（日本時間。`2026-10-09T11:00` の形式）。 */
  readonly observedAt?: string;
  /** 項目の表示名（単位を除く） → 入力する文字列。 */
  readonly items?: Readonly<Record<string, string>>;
  /** スターで選ぶ項目（満足度）の表示名 → スターの数（1〜5）。 */
  readonly stars?: Readonly<Record<string, number>>;
  readonly note?: string;
}

/** 満足度の項目の表示名（例: 満足度（収穫精度））。9観点の表示順。 */
export const SATISFACTION_LABELS: readonly string[] = SATISFACTION_TARGET_VIEWPOINT_IDS.map(
  (viewpointId) => `満足度（${findViewpointMeta(viewpointId)?.name ?? viewpointId}）`,
);

/** 満足度の 9 観点すべての、スターの数（既定は `stars`。`overrides` で観点ごとに変える）。 */
export function allSatisfactionStars(
  stars: number,
  overrides: Readonly<Record<string, number>> = {},
): Record<string, number> {
  return {
    ...Object.fromEntries(SATISFACTION_LABELS.map((label) => [label, stars])),
    ...overrides,
  };
}

/** 満足度の入力の API の本文の項目（9観点すべて。D-18）。観点ごとの値は、`overrides`（観点の識別子 → スター）で変える。 */
export function satisfactionApiItems(
  stars: number,
  overrides: Readonly<Record<string, number>> = {},
): Record<string, number> {
  return Object.fromEntries(
    SATISFACTION_TARGET_VIEWPOINT_IDS.map((viewpointId) => [
      `satisfaction.${viewpointId}`,
      overrides[viewpointId] ?? stars,
    ]),
  );
}

/** 満足度の観点のスターのグループ（ラジオ）。 */
export function starGroup(form: Locator, label: string): Locator {
  return form.getByTestId('entry-items').getByRole('radiogroup', { name: label });
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
    // 数値の項目は、数値の欄（textbox）とスライダーを並べる。数値の欄を取る（スライダーの名前にも、項目名が含まれるため）
    await form.getByTestId('entry-items').getByRole('textbox', { name: label }).fill(text);
  }
  for (const [label, stars] of Object.entries(values.stars ?? {})) {
    // 利用者の操作と同じく、スター（ラベル）を押す
    await starGroup(form, label)
      .locator('label.star')
      .nth(stars - 1)
      .click();
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

/**
 * 保存後の結果の欄の、観点のステータスを確認する。既定は「期間の評価」。`scope: 'current'` は「現在」（短期の評価。短期を持つ観点だけ）。
 * 「現在」と「期間の評価」は、別々に示す（悪い方への合成はしない。#591）。
 */
export async function expectRelatedStatus(
  page: Page,
  viewpointId: string,
  status: string,
  scope: 'current' | 'period' = 'period',
): Promise<void> {
  const row = page.getByTestId(`related-${viewpointId}`);
  await expect(row).toBeVisible();
  await expect(
    page.getByTestId(`related-${scope}-${viewpointId}`).locator('.status-badge'),
  ).toContainText(status);
}
