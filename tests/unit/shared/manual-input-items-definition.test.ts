/**
 * 手動入力の項目の定義（確定。docs/10_design/data/data-dictionary.md 5.2。Issue #301）の確認。
 * データ辞書 5.2 の表（カテゴリ・日本語名・識別子・型・範囲・単位・使う観点・状態）が、項目のカタログ（`items.ts`）と
 * 食い違わないこと、ADR-0017 で「参考として残す」と決めた項目が、観点で使わない参考の項目として書かれていることを確かめる。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_LABELS,
  ITEM_CATALOG,
  MANUAL_INPUT_CATEGORIES,
  findItemDefinition,
  type ItemDefinition,
} from '@smart-farm/shared/constants/items';

const DICTIONARY_PATH = 'docs/10_design/data/data-dictionary.md';
/** ADR-0017 で「参考として残す」と決めた項目（観点の判定に使わない）。 */
const REFERENCE_KEYS = ['harvestAttemptCount', 'harvestSuccessCount', 'misrecognitionCount'];

const dictionary = readFileSync(DICTIONARY_PATH, 'utf8');

/** 「5.2 手動入力のデータ」の章（次の章の見出しの手前まで）。 */
function section52(markdown: string): string {
  const start = markdown.indexOf('### 5.2 ');
  const end = markdown.indexOf('\n## 6. ');
  if (start < 0 || end < 0) {
    throw new Error('テストの前提: データ辞書に 5.2 と 6 章がある');
  }
  return markdown.slice(start, end);
}

interface Row {
  readonly category: string;
  readonly label: string;
  readonly itemKey: string;
  readonly type: string;
  readonly unit: string;
  readonly viewpoints: string;
  readonly status: string;
}

/** 5.2 の表の行（見出し・区切り行を除く）。 */
function rows(): Row[] {
  return section52(dictionary)
    .split(/\r?\n/)
    .filter(
      (line) => line.startsWith('| ') && !line.startsWith('| カテゴリ') && !line.includes('---'),
    )
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length === 7)
    .map(([category, label, itemKey, type, unit, viewpoints, status]) => ({
      category: category ?? '',
      label: label ?? '',
      itemKey: (itemKey ?? '').replaceAll('`', ''),
      type: type ?? '',
      unit: unit ?? '',
      viewpoints: viewpoints ?? '',
      status: status ?? '',
    }));
}

/** 手動入力だけの項目（5.2 の表の対象。環境・満足度の項目と、自動取り込みの項目〔5.1〕を除く）。 */
const MANUAL_ONLY_ITEMS: readonly ItemDefinition[] = ITEM_CATALOG.filter(
  (item) =>
    item.origins.length === 1 && item.origins[0] === 'MANUAL' && item.category !== 'SATISFACTION',
);

describe('手動入力の項目: データ辞書 5.2 の表と、項目のカタログ（実装）の一致', () => {
  const table = rows();

  it('手動入力だけの項目は、すべて 5.2 の表にある（過不足なし）。環境情報と満足度情報の行を含めて 19 行', () => {
    const keys = table.map((row) => row.itemKey);

    for (const item of MANUAL_ONLY_ITEMS) {
      expect(keys, item.itemKey).toContain(item.itemKey);
    }
    // 表の行 = 手動入力だけの項目 + 環境情報（5.1 と同じ）+ 満足度情報（9 観点で 1 行）
    expect(table).toHaveLength(MANUAL_ONLY_ITEMS.length + 2);
    expect(MANUAL_ONLY_ITEMS).toHaveLength(17);
  });

  it.each(MANUAL_ONLY_ITEMS.map((item) => [item.itemKey, item] as const))(
    '%s: カテゴリ・日本語名・型・範囲・単位が、実装と同じ値で書かれている',
    (itemKey, item) => {
      const row = table.find((candidate) => candidate.itemKey === itemKey);
      expect(row, `${itemKey} の行がある`).toBeDefined();
      expect(row?.category).toBe(CATEGORY_LABELS[item.category]);
      expect(row?.label).toBe(item.label);
      expect(row?.type).toBe(
        `${item.valueType === 'integer' ? '整数' : '数値'}（${item.min}以上）`,
      );
      expect(item.max).toBeUndefined();
      expect(row?.unit.startsWith(item.unit)).toBe(true);
    },
  );

  it('手動入力の項目のカテゴリは、すべて手動入力で選べるカテゴリ（FR-4.1）', () => {
    for (const item of MANUAL_ONLY_ITEMS) {
      expect(MANUAL_INPUT_CATEGORIES, item.itemKey).toContain(item.category);
    }
  });

  it('環境情報の行は 5.1 の環境 4 項目（温度・湿度・照度・CO2濃度）、満足度情報の行は 9 観点の 1〜5 のスター（整数）と一致する', () => {
    const environment = table.find((row) => row.category === '環境情報');
    expect(environment?.label).toBe('温度・湿度・照度・CO2濃度');
    for (const key of ['temperatureCelsius', 'humidityPercent', 'illuminanceLux', 'co2Ppm']) {
      expect(findItemDefinition(key)?.origins, key).toContain('MANUAL');
    }

    const satisfaction = table.find((row) => row.category === '満足度情報');
    expect(satisfaction?.itemKey).toContain('satisfaction.{viewpointId}');
    expect(satisfaction?.type).toBe('整数（1〜5）');
    const items = ITEM_CATALOG.filter((item) => item.category === 'SATISFACTION');
    expect(items).toHaveLength(9);
    for (const item of items) {
      expect([item.valueType, item.min, item.max, item.unit]).toEqual(['integer', 1, 5, 'スター']);
    }
  });

  it('すべての行の状態が「確定」（本システムが定める）。仮の行は残っていない', () => {
    for (const row of table) {
      expect(row.status, row.itemKey).toMatch(/^確定/);
    }
  });

  it.each(REFERENCE_KEYS)(
    '%s は、ADR-0017 のとおり「参考として残す」項目。観点の判定に使わないと書かれている（確定の対象）',
    (itemKey) => {
      const row = table.find((candidate) => candidate.itemKey === itemKey);

      expect(row?.viewpoints).toContain('参考');
      expect(row?.viewpoints).toContain('判定に使わない');
      expect(row?.status).toMatch(/^確定/);
    },
  );

  it('参考の項目以外は、使う観点が書かれている（観点の名前）', () => {
    for (const row of table) {
      if (!REFERENCE_KEYS.includes(row.itemKey)) {
        expect(row.viewpoints, row.itemKey).not.toContain('参考');
        expect(row.viewpoints.length, row.itemKey).toBeGreaterThan(0);
      }
    }
  });

  it('5.2 に、手動入力の項目が確定であること・見直しの条件が書かれ、Q-003 の TODO は残っていない', () => {
    const text = section52(dictionary);

    expect(text).toContain('本システムが定める（確定）');
    expect(text).toContain('見直す');
    expect(text).not.toContain('TODO: 入力できる項目は');
  });
});
