/**
 * 収穫ロボットのデータ定義（確定。docs/10_design/data/robot-data-definition.md。Issue #299・#301）の確認。
 * 文書の項目の表・サンプル（合成データ）が、実際の形式定義（`robot-json`）・項目の定義（範囲・単位・集計の種類）と
 * 食い違わないこと、文書のサンプルが取り込めることを確かめる。実データは使わない。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findItemDefinition } from '@smart-farm/shared/constants/items';
import type { StatusCodeDefinition } from '@smart-farm/shared/schemas/status-code';
import { classifyValue } from '../../../../src/backend/domain/observation-quality.ts';
import { createDefaultFormatProfileRegistry } from '../../../../src/backend/infrastructure/format-profiles/declarative-profile.ts';
import { FIXTURES_DIRECTORY } from '../../../support/fixtures-path.ts';

const DEFINITION_PATH = 'docs/10_design/data/robot-data-definition.md';
const PROFILE_PATH = 'src/backend/infrastructure/format-profiles/robot-json.profile.json';
const ITEM_KEYS = [
  'harvestCount',
  'harvestSecondsPerFruit',
  'operatingHours',
  'standbyHours',
  'harvestOperatingHours',
  'travelStoppedHours',
  'statusCode',
] as const;
/** 合計の 5 項目（累積の値。期間の値は、期間内の増分の合計。D-26）。 */
const CUMULATIVE_KEYS = [
  'harvestCount',
  'operatingHours',
  'standbyHours',
  'harvestOperatingHours',
  'travelStoppedHours',
] as const;

const registry = createDefaultFormatProfileRegistry();
const profile = registry.get('robot-json');
if (profile === undefined) {
  throw new Error('テストの前提: ロボットの FormatProfile がある');
}

const definition = readFileSync(DEFINITION_PATH, 'utf8');

/** 文書の、```json のコードブロックを、順に取り出す。 */
function jsonBlocksOf(markdown: string): unknown[] {
  return [...markdown.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(
    (match) => JSON.parse(match[1] ?? '') as unknown,
  );
}

/** 文書の「2. 項目」の章（次の章の見出しの手前まで）。 */
function itemsSection(markdown: string): string {
  const start = markdown.indexOf('\n## 2. ');
  const end = markdown.indexOf('\n## 3. ');
  if (start < 0 || end < 0) {
    throw new Error('テストの前提: 文書に 2 章・3 章がある');
  }
  return markdown.slice(start, end);
}

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIRECTORY, 'file-server/robot', name), 'utf8');
}

function statusCode(code: string, isDeleted = false): StatusCodeDefinition {
  return { code, name: code, category: 'NORMAL', isDeleted };
}

/** 検証の文脈（受信は、サンプルの計測日時より後。ステータスコードは、登録済みの 2 つ）。 */
const CONTEXT = {
  observedAt: new Date('2026-10-09T02:00:00Z'),
  receivedAt: new Date('2026-10-09T03:00:00Z'),
  lateAfterMinutes: 60,
  futureToleranceMinutes: 5,
  statusCodes: new Map([
    ['HARVESTING', statusCode('HARVESTING')],
    ['STANDBY', statusCode('STANDBY')],
    ['OLD_CODE', statusCode('OLD_CODE', true)],
  ]),
};

describe('ロボットのデータ定義: 形式定義（FormatProfile）', () => {
  it('状態は「確定」、版は 1.0.0。解釈に使った版の表記は、ロボット JSON の確定の版になる', () => {
    expect(profile).toMatchObject({
      profileId: 'robot-json',
      version: '1.0.0',
      status: 'CONFIRMED',
      versionLabel: 'robot-json@1.0.0(CONFIRMED)',
    });
  });

  it('根拠（basis）は、確定の位置づけと、専用文書の名前を示し、累積の基準が想定であることを残す', () => {
    const config = JSON.parse(readFileSync(PROFILE_PATH, 'utf8')) as { basis: string };

    expect(config.basis).toContain('確定');
    expect(config.basis).toContain('robot-data-definition.md');
    expect(config.basis).toContain('版を上げる');
    expect(config.basis).toContain('累積の基準');
  });
});

describe('ロボットのデータ定義: 文書と実装の一致', () => {
  it.each(ITEM_KEYS)(
    '項目の表に、%s の、ファイルの項目名（識別子と同じ）・日本語名・単位・値の範囲が、実装と同じ値で書かれている',
    (itemKey) => {
      const item = findItemDefinition(itemKey);
      if (item === undefined) {
        throw new Error('テストの前提: 項目の定義がある');
      }
      const row = itemsSection(definition)
        .split(/\r?\n/)
        .find((line) => line.startsWith('|') && line.includes(`\`${itemKey}\``));

      expect(row, `${itemKey} の行がある`).toBeDefined();
      expect(row).toContain(item.label);
      if (item.unit !== '') {
        expect(row).toContain(item.unit);
      }
      // 範囲は、桁区切りのカンマつきでも、なしでも書ける
      const compact = (row ?? '').replaceAll(',', '');
      if (item.max !== undefined) {
        expect(compact).toContain(`${item.min}〜${item.max}`);
      } else if (item.min !== undefined) {
        expect(compact).toContain(`${item.min} 以上`);
      }
      if (item.manualMax !== undefined) {
        expect(compact).toContain(`手動入力は ${item.min}〜${item.manualMax}`);
      }
    },
  );

  it('合計の 5 項目は、項目の定義でも、累積（CUMULATIVE）。文書の表でも、累積と書かれている。1 果実あたりの収穫時間は、その時点の値（LEVEL）', () => {
    for (const itemKey of CUMULATIVE_KEYS) {
      expect(findItemDefinition(itemKey)?.aggregation, itemKey).toBe('CUMULATIVE');
      const row = itemsSection(definition)
        .split(/\r?\n/)
        .find((line) => line.startsWith('|') && line.includes(`\`${itemKey}\``));
      expect(row, itemKey).toContain('累積');
    }
    expect(findItemDefinition('harvestSecondsPerFruit')?.aggregation).toBe('LEVEL');
  });

  it('時間の項目の単位は「時間」（小数）。文書に、単位の確認したい点が残っている', () => {
    for (const itemKey of [
      'operatingHours',
      'standbyHours',
      'harvestOperatingHours',
      'travelStoppedHours',
    ]) {
      expect(findItemDefinition(itemKey)?.unit, itemKey).toBe('時間');
    }
    expect(definition).toContain('時間の単位');
  });

  it('形式定義の項目は、文書の 7 項目と同じ（追加なし）。ファイルの項目名は、システム内の識別子と同じ。レイアウトは、計測日時のキーだけ（設備の識別子・記録の配列は持たない）', () => {
    const config = JSON.parse(readFileSync(PROFILE_PATH, 'utf8')) as {
      fields: { source: string; itemKey: string }[];
      layout: Record<string, string>;
    };

    expect(config.fields.map((field) => field.itemKey)).toEqual([...ITEM_KEYS]);
    expect(config.fields.map((field) => field.source)).toEqual([...ITEM_KEYS]);
    expect(config.layout).toEqual({ timestampField: 'timestamp' });
  });

  it('文書は、確定の位置づけ・版・提供元の定義が示されたときの扱い・累積の値の扱い・ステータスコード・確認したい点・運用の仮定・設備への割り付け（ファイルのパス）を、示している', () => {
    for (const text of [
      '確定',
      'robot-json@1.0.0',
      '版を上げる',
      '確認したい点',
      '運用の仮定',
      '欠損・異常値・遅延',
      '累積',
      '増分の合計',
      '累積の基準',
      'ステータスコード',
      '未登録',
      'sourceFilePath',
      '1 設備 = 1 ファイル',
      'スナップショット',
    ]) {
      expect(definition, text).toContain(text);
    }
    // ファイルの中に、設備の識別子・記録の配列は持たない（旧構造のキーは、構造の表に載せない）
    expect(definition).not.toContain('`robotId`');
    expect(definition).not.toContain('`records`');
  });

  it('文書に、累積か増分かで食い違う記述がない（合計の項目を「増分」の値と書いていない）', () => {
    expect(definition).not.toContain('増分と仮定');
    expect(definition).not.toMatch(/その時間帯の増分/);
  });
});

describe('ロボットのデータ定義: 文書のサンプル（合成データ）', () => {
  const blocks = jsonBlocksOf(definition);

  it('文書のサンプルは、テストの合成データ（fixture）と同じ内容', () => {
    expect(blocks[0]).toEqual(JSON.parse(fixture('robot-definition-sample-001.json')));
    expect(blocks[1]).toEqual(JSON.parse(fixture('robot-definition-sample-002-partial.json')));
  });

  it('サンプル 1（通常）: 7 項目とも読め、すべて有効な値になる。設備の識別子は、ファイルにない', () => {
    const parsed = profile.parse(fixture('robot-definition-sample-001.json'));

    expect(parsed.rejectedCount).toBe(0);
    expect(parsed.record).toEqual({
      observedAt: '2026-10-09T02:00:00Z',
      fields: {
        harvestCount: 128,
        harvestSecondsPerFruit: 42.5,
        operatingHours: 3.25,
        standbyHours: 0.5,
        harvestOperatingHours: 2.5,
        travelStoppedHours: 0.125,
        statusCode: 'HARVESTING',
      },
    });
    for (const itemKey of ITEM_KEYS) {
      expect(classifyValue(itemKey, parsed.record?.fields[itemKey], CONTEXT).quality, itemKey).toBe(
        'VALID',
      );
    }
  });

  it('サンプル 2（欠損・タイムゾーンなし・項目の省略）: null は欠損、日時は日本時間、省略した項目は含めない', () => {
    const parsed = profile.parse(fixture('robot-definition-sample-002-partial.json'));

    expect(parsed.rejectedCount).toBe(0);
    // タイムゾーンのない日時（11:10）は、日本時間として、UTC の 02:10 になる
    expect(parsed.record?.observedAt).toBe('2026-10-09T02:10:00.000Z');
    expect(parsed.record?.fields.harvestSecondsPerFruit).toBeNull();
    expect(classifyValue('harvestSecondsPerFruit', null, CONTEXT).quality).toBe('MISSING');
    expect(Object.keys(parsed.record?.fields ?? {})).toEqual([
      'harvestCount',
      'harvestSecondsPerFruit',
      'operatingHours',
      'standbyHours',
      'harvestOperatingHours',
      'statusCode',
    ]);
  });

  it('累積の項目は、ファイルの値（累積のスナップショット）のまま読む（増分に変えない）。同じ項目で、2 つのファイルの値が増えている', () => {
    const first = profile.parse(fixture('robot-definition-sample-001.json')).record?.fields;
    const second = profile.parse(fixture('robot-definition-sample-002-partial.json')).record
      ?.fields;

    for (const itemKey of ['harvestCount', 'operatingHours', 'harvestOperatingHours'] as const) {
      expect(Number(second?.[itemKey]), itemKey).toBeGreaterThan(Number(first?.[itemKey]));
    }
    expect(first?.harvestCount).toBe(128);
    expect(second?.harvestCount).toBe(130);
  });
});

describe('ロボットのデータ定義: 値の範囲と、欠損・異常値の扱い', () => {
  it.each([
    ['harvestCount', 0, 'VALID'],
    ['harvestCount', 1_000_000, 'VALID'],
    ['harvestCount', -1, 'INVALID'],
    ['harvestCount', 12.5, 'INVALID'],
    ['harvestSecondsPerFruit', 0, 'VALID'],
    ['harvestSecondsPerFruit', 3600, 'VALID'],
    ['harvestSecondsPerFruit', 3600.1, 'INVALID'],
    ['harvestSecondsPerFruit', -0.1, 'INVALID'],
    ['operatingHours', 0, 'VALID'],
    ['operatingHours', 8760.5, 'VALID'],
    ['operatingHours', -0.01, 'INVALID'],
    ['standbyHours', 0.02, 'VALID'],
    ['standbyHours', -1, 'INVALID'],
    ['harvestOperatingHours', 2.5, 'VALID'],
    ['harvestOperatingHours', -1, 'INVALID'],
    ['travelStoppedHours', 0.003, 'VALID'],
    ['travelStoppedHours', -1, 'INVALID'],
    ['operatingHours', '3.25', 'INVALID'],
    ['harvestCount', '128', 'INVALID'],
    ['harvestSecondsPerFruit', null, 'MISSING'],
    ['operatingHours', null, 'MISSING'],
  ] as const)('%s = %s は %s', (itemKey, value, expected) => {
    expect(classifyValue(itemKey, value, CONTEXT).quality).toBe(expected);
  });

  it('ステータスコード: 登録済みの値は有効。未登録の値・論理削除の値・文字列でない値は不正。null は欠損', () => {
    expect(classifyValue('statusCode', 'HARVESTING', CONTEXT).quality).toBe('VALID');
    expect(classifyValue('statusCode', 'UNDEFINED_CODE', CONTEXT).quality).toBe('INVALID');
    expect(classifyValue('statusCode', 'OLD_CODE', CONTEXT).quality).toBe('INVALID');
    expect(classifyValue('statusCode', 3, CONTEXT).quality).toBe('INVALID');
    expect(classifyValue('statusCode', null, CONTEXT).quality).toBe('MISSING');
  });

  it('受信が計測から 60 分を超えて遅れた値は、遅延（評価に使う）。計測日時が受信より 5 分を超えて未来なら、不正', () => {
    expect(
      classifyValue('operatingHours', 3.25, {
        ...CONTEXT,
        observedAt: new Date('2026-10-09T01:00:00Z'),
        receivedAt: new Date('2026-10-09T02:01:00Z'),
      }).quality,
    ).toBe('LATE');
    expect(
      classifyValue('operatingHours', 3.25, {
        ...CONTEXT,
        observedAt: new Date('2026-10-09T03:06:00Z'),
        receivedAt: new Date('2026-10-09T03:00:00Z'),
      }).quality,
    ).toBe('INVALID');
  });

  it('値のない項目を 0 で代用しない: null は、欠損のまま渡る', () => {
    const parsed = profile.parse('{"timestamp":"2026-10-09T02:00:00Z","harvestCount":null}');

    expect(parsed.record?.fields.harvestCount).toBeNull();
  });

  it('タイムゾーンのない日時は日本時間、オフセットつき・UTC はそのまま。読めない日時は、読み取れなかった記録', () => {
    expect(
      profile.parse('{"timestamp":"2026-10-09T11:00:00","harvestCount":1}').record?.observedAt,
    ).toBe('2026-10-09T02:00:00.000Z');
    expect(
      profile.parse('{"timestamp":"2026-10-09T11:00:00+09:00","harvestCount":1}').record
        ?.observedAt,
    ).toBe('2026-10-09T11:00:00+09:00');
    expect(profile.parse('{"timestamp":"Oct 9 2026","harvestCount":1}')).toEqual({
      record: undefined,
      rejectedCount: 1,
    });
  });
});
