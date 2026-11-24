/**
 * 環境センサーのデータ定義（確定。docs/10_design/data/environment-sensor-data-definition.md。Issue #300・#302）の確認。
 * 文書の項目の表・サンプル（合成データ）が、実際の形式定義（`environment-sensor-json`）・項目の定義（範囲・単位）と
 * 食い違わないこと、文書のサンプルが取り込めることを確かめる。実データは使わない。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findItemDefinition } from '@smart-farm/shared/constants/items';
import { classifyValue } from '../../../../src/backend/domain/observation-quality.ts';
import { createDefaultFormatProfileRegistry } from '../../../../src/backend/infrastructure/format-profiles/declarative-profile.ts';
import { FIXTURES_DIRECTORY } from '../../../support/fixtures-path.ts';

const DEFINITION_PATH = 'docs/10_design/data/environment-sensor-data-definition.md';
const ITEM_KEYS = ['temperatureCelsius', 'humidityPercent', 'illuminanceLux', 'co2Ppm'] as const;

const registry = createDefaultFormatProfileRegistry();
const profile = registry.get('environment-sensor-json');
if (profile === undefined) {
  throw new Error('テストの前提: 環境センサーの FormatProfile がある');
}

const definition = readFileSync(DEFINITION_PATH, 'utf8');

/** 文書の、```json のコードブロックを、順に取り出す。 */
function jsonBlocksOf(markdown: string): unknown[] {
  return [...markdown.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(
    (match) => JSON.parse(match[1] ?? '') as unknown,
  );
}

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIRECTORY, 'file-server/environment-sensor', name), 'utf8');
}

/** 検証の文脈（受信は、サンプルの計測日時より後。ステータスコードは使わない）。 */
const CONTEXT = {
  observedAt: new Date('2026-10-09T02:00:00Z'),
  receivedAt: new Date('2026-10-09T03:00:00Z'),
  lateAfterMinutes: 60,
  futureToleranceMinutes: 5,
  statusCodes: new Map(),
};

describe('環境センサーのデータ定義: 形式定義（FormatProfile）', () => {
  it('状態は「確定」、版は 1.0.0。解釈に使った版の表記は、環境センサー JSON の確定の版になる', () => {
    expect(profile).toMatchObject({
      profileId: 'environment-sensor-json',
      version: '1.0.0',
      status: 'CONFIRMED',
      versionLabel: 'environment-sensor-json@1.0.0(CONFIRMED)',
    });
  });

  it('根拠（basis）は、確定の位置づけと、専用文書の名前を示す', () => {
    const config = JSON.parse(
      readFileSync(
        'src/backend/infrastructure/format-profiles/environment-sensor-json.profile.json',
        'utf8',
      ),
    ) as { basis: string };

    expect(config.basis).toContain('確定');
    expect(config.basis).toContain('environment-sensor-data-definition.md');
  });
});

describe('環境センサーのデータ定義: 文書と実装の一致', () => {
  it.each(ITEM_KEYS)(
    '項目の表に、%s の識別子・日本語名・単位・範囲が、項目の定義（実装）と同じ値で書かれている',
    (itemKey) => {
      const item = findItemDefinition(itemKey);
      if (item?.min === undefined || item.max === undefined) {
        throw new Error('テストの前提: 項目の定義に範囲がある');
      }
      const row = definition
        .split(/\r?\n/)
        .find((line) => line.startsWith('|') && line.includes(`\`${itemKey}\``));

      expect(row, `${itemKey} の行がある`).toBeDefined();
      expect(row).toContain(item.label);
      expect(row).toContain(item.unit);
      // 範囲は、桁区切りのカンマつきでも、なしでも書ける
      const compact = (row ?? '').replaceAll(',', '').replaceAll('−', '-');
      expect(compact).toContain(`${item.min}〜${item.max}`);
    },
  );

  it('形式定義の項目は、文書の 4 項目と同じ（追加・変更なし）', () => {
    const config = JSON.parse(
      readFileSync(
        'src/backend/infrastructure/format-profiles/environment-sensor-json.profile.json',
        'utf8',
      ),
    ) as { fields: { source: string; itemKey: string }[] };

    expect(config.fields.map((field) => field.itemKey)).toEqual([...ITEM_KEYS]);
    expect(config.fields.every((field) => field.source === field.itemKey)).toBe(true);
  });

  it('文書は、確定の位置づけ・版・提供元の定義が示されたときの扱い・確認したい点・運用の仮定を、示している', () => {
    for (const text of [
      '確定',
      'environment-sensor-json@1.0.0',
      '版を上げる',
      '確認したい点',
      '運用の仮定',
      '欠損・異常値・遅延',
      'externalId',
    ]) {
      expect(definition, text).toContain(text);
    }
  });
});

describe('環境センサーのデータ定義: 文書のサンプル（合成データ）', () => {
  const blocks = jsonBlocksOf(definition);

  it('文書のサンプルは、テストの合成データ（fixture）と同じ内容', () => {
    expect(blocks[0]).toEqual(JSON.parse(fixture('sensor-definition-sample-001.json')));
    expect(blocks[1]).toEqual(JSON.parse(fixture('sensor-definition-sample-002-partial.json')));
  });

  it('サンプル 1（通常）: 記録ごとに、4 項目とも読め、すべて有効な値になる', () => {
    const parsed = profile.parse(fixture('sensor-definition-sample-001.json'));

    expect(parsed.rejectedCount).toBe(0);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]).toMatchObject({
      externalId: 'SENSOR-SAMPLE-01',
      observedAt: '2026-10-09T02:00:00Z',
      fields: { temperatureCelsius: 24.5, humidityPercent: 62, illuminanceLux: 48000, co2Ppm: 650 },
    });
    for (const record of parsed.records) {
      for (const itemKey of ITEM_KEYS) {
        expect(
          classifyValue(itemKey, record.fields[itemKey], CONTEXT).quality,
          `${record.observedAt} ${itemKey}`,
        ).toBe('VALID');
      }
    }
  });

  it('サンプル 2（欠損・タイムゾーンなし・項目の省略）: null は欠損、日時は日本時間、省略した項目は含めない', () => {
    const parsed = profile.parse(fixture('sensor-definition-sample-002-partial.json'));

    expect(parsed.rejectedCount).toBe(0);
    // タイムゾーンのない日時（11:10）は、日本時間として、UTC の 02:10 になる
    expect(parsed.records.map((record) => record.observedAt)).toEqual([
      '2026-10-09T02:10:00.000Z',
      '2026-10-09T02:15:00.000Z',
    ]);
    expect(parsed.records[0]?.fields.humidityPercent).toBeNull();
    expect(classifyValue('humidityPercent', null, CONTEXT).quality).toBe('MISSING');
    expect(Object.keys(parsed.records[1]?.fields ?? {})).toEqual([
      'temperatureCelsius',
      'humidityPercent',
      'illuminanceLux',
    ]);
  });
});

describe('環境センサーのデータ定義: 値の範囲（ADR-0016 の D-10）と、欠損・異常値の扱い', () => {
  it.each([
    ['temperatureCelsius', -50, 'VALID'],
    ['temperatureCelsius', 100, 'VALID'],
    ['temperatureCelsius', -50.1, 'INVALID'],
    ['temperatureCelsius', 100.1, 'INVALID'],
    ['humidityPercent', 0, 'VALID'],
    ['humidityPercent', 100, 'VALID'],
    ['humidityPercent', -0.1, 'INVALID'],
    ['humidityPercent', 100.1, 'INVALID'],
    ['illuminanceLux', 0, 'VALID'],
    ['illuminanceLux', 200_000, 'VALID'],
    ['illuminanceLux', 200_001, 'INVALID'],
    ['co2Ppm', 0, 'VALID'],
    ['co2Ppm', 10_000, 'VALID'],
    ['co2Ppm', 10_001, 'INVALID'],
    ['co2Ppm', -1, 'INVALID'],
    ['temperatureCelsius', '24.5', 'INVALID'],
    ['temperatureCelsius', null, 'MISSING'],
  ] as const)('%s = %s は %s', (itemKey, value, expected) => {
    expect(classifyValue(itemKey, value, CONTEXT).quality).toBe(expected);
  });

  it('受信が計測から 60 分を超えて遅れた値は、遅延（評価に使う）', () => {
    expect(
      classifyValue('temperatureCelsius', 24.5, {
        ...CONTEXT,
        observedAt: new Date('2026-10-09T01:00:00Z'),
        receivedAt: new Date('2026-10-09T02:01:00Z'),
      }).quality,
    ).toBe('LATE');
  });

  it('記録がなければ空の配列でよい（記録は 0 件。読み取れなかった記録もない）', () => {
    expect(profile.parse('{"sensorId":"S","records":[]}')).toEqual({
      records: [],
      rejectedCount: 0,
    });
  });

  it('値のない項目を 0 で代用しない: null は、欠損のまま渡る', () => {
    const parsed = profile.parse(
      '{"sensorId":"S","records":[{"timestamp":"2026-10-09T02:00:00Z","co2Ppm":null}]}',
    );

    expect(parsed.records[0]?.fields.co2Ppm).toBeNull();
  });
});
