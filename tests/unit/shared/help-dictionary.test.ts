/**
 * 用語辞書（指標の説明・入力項目の説明・カテゴリの説明。Issue #154 の PR2）の単体テスト。
 * 説明は、既存の設計（viewpoint・data-dictionary・glossary・ADR）の定義から書く。定義のない項目には、説明を付けない。
 */

import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  ITEM_CATALOG,
  findItemDefinition,
} from '../../../src/shared/constants/items.ts';
import {
  CATEGORY_HELP,
  findItemHelp,
  ITEM_HELP_KEYS,
} from '../../../src/shared/constants/item-help.ts';
import { getMetricMeta, STATUS_INDICATOR_ID } from '../../../src/shared/constants/metrics.ts';

describe('指標の説明（getMetricMeta の help）', () => {
  it.each([
    ['mttrHours', '平均修復時間（MTTR）', '復旧'],
    ['mtbfHours', '平均故障間隔（MTBF）', '故障'],
    ['travelStoppedRatePercent', '走行停止率', '走行が止まっていた'],
    ['dataCoveragePercent', 'データ連携率', '全データ数'],
    ['marketableFruitRatePercent', '可販果率', '誤収穫'],
    ['overallSatisfaction', '総合満足度', '平均'],
    [STATUS_INDICATOR_ID, 'ステータス', 'ステータスコード'],
  ])('%s は、表示名「%s」と、説明（「%s」を含む）を持つ', (metricId, label, keyword) => {
    const meta = getMetricMeta(metricId);

    expect(meta.label).toBe(label);
    expect(meta.help).toContain(keyword);
  });

  it('説明は、画面で使わない内部用語（メトリクス・論理削除）を含まない', () => {
    for (const metricId of [
      'mttrHours',
      'travelStoppedRatePercent',
      'dataCoveragePercent',
      'availabilityPercent',
      'nearMissPerHour',
    ]) {
      const help = getMetricMeta(metricId).help ?? '';
      expect(help).not.toContain('メトリクス');
      expect(help).not.toContain('論理削除');
    }
  });

  it('定義が別の Issue で決まる・書かれていない指標には、説明を付けない（運用コストは D-20、取得数は説明が長い）', () => {
    for (const metricId of [
      'operatingCostYen',
      'robotDataCount',
      'sensorDataCount',
      'manualDataCount',
      'totalDataCount',
      'temperatureCelsius',
    ]) {
      expect(getMetricMeta(metricId).help, metricId).toBeUndefined();
    }
  });

  it('項目カタログから補う指標・未定義の指標は、説明を持たない', () => {
    expect(getMetricMeta('harvestCount').help).toBeUndefined();
    expect(getMetricMeta('unknownMetric').help).toBeUndefined();
  });
});

describe('入力項目の説明（findItemHelp）', () => {
  it('説明のある項目は、すべて項目カタログにあり、手動入力で入力できる', () => {
    for (const itemKey of ITEM_HELP_KEYS) {
      const item = findItemDefinition(itemKey);
      expect(item, itemKey).toBeDefined();
      expect(item?.origins, itemKey).toContain('MANUAL');
    }
  });

  it('環境の項目・1 果実あたりの収穫時間は、意味と入力例を持つ。入力例は、保存できる範囲に収まる', () => {
    for (const itemKey of [
      'temperatureCelsius',
      'humidityPercent',
      'illuminanceLux',
      'co2Ppm',
      'harvestSecondsPerFruit',
    ]) {
      const help = findItemHelp(itemKey);
      const item = findItemDefinition(itemKey);
      expect(help?.help, itemKey).toBeTruthy();
      const example = Number(help?.example);
      expect(Number.isFinite(example), itemKey).toBe(true);
      expect(example).toBeGreaterThanOrEqual(item?.min ?? Number.NEGATIVE_INFINITY);
      expect(example).toBeLessThanOrEqual(item?.manualMax ?? item?.max ?? Number.POSITIVE_INFINITY);
    }
  });

  it('ヒヤリハットの説明は、設計の定義（緊急停止を伴う出来事は、数えない）を使う', () => {
    const help = findItemHelp('nearMissCount')?.help ?? '';

    expect(help).toContain('ヒヤリハット');
    expect(help).toContain('緊急停止');
  });

  it('D-20（コスト 4 項目の単位）・D-21（復旧時間）・D-22（操作性）の項目には、説明を付けない（別の Issue で行う）', () => {
    const excluded = [
      // D-20: コスト情報
      ...ITEM_CATALOG.filter((item) => item.category === 'COST').map((item) => item.itemKey),
      // D-21: 故障情報（復旧に要した時間・故障回数）
      ...ITEM_CATALOG.filter((item) => item.category === 'FAILURE').map((item) => item.itemKey),
      // D-22: 操作情報
      ...ITEM_CATALOG.filter((item) => item.category === 'OPERABILITY').map((item) => item.itemKey),
    ];

    expect(excluded.length).toBeGreaterThan(5);
    for (const itemKey of excluded) {
      expect(findItemHelp(itemKey), itemKey).toBeUndefined();
    }
  });

  it('D-26 の合計の項目（自動取り込みの 5 項目）は、値の意味（今日これまでの累計）と、自動取り込みの値がある期間の扱いを説明する（#162）', () => {
    const totals = [
      'harvestCount',
      'operatingHours',
      'standbyHours',
      'harvestOperatingHours',
      'travelStoppedHours',
    ];

    for (const itemKey of totals) {
      const help = findItemHelp(itemKey)?.help ?? '';
      expect(help, itemKey).toContain('今日これまでの累計');
      expect(help, itemKey).toContain('自動取り込みの値がある期間は、評価に使われません');
      expect(findItemDefinition(itemKey)?.aggregation, itemKey).toBe('CUMULATIVE');
    }
  });

  it('満足度の項目・未定義の項目には、説明がない', () => {
    expect(findItemHelp('satisfaction.harvestAccuracy')).toBeUndefined();
    expect(findItemHelp('unlisted')).toBeUndefined();
  });
});

describe('カテゴリの説明（CATEGORY_HELP。data-dictionary.md 4 章）', () => {
  it('すべてのカテゴリに、説明がある', () => {
    for (const category of CATEGORIES) {
      expect(CATEGORY_HELP[category], category).toBeTruthy();
    }
  });
});
