import { describe, expect, it } from 'vitest';
import { toUserId } from '../../../../../src/shared/schemas/common.ts';
import {
  fromObservationItem,
  manualIndexSortKey,
  normalizedInstant,
  observationPartitionKey,
  observationSortKey,
  toObservationItem,
} from '../../../../../src/backend/infrastructure/dynamodb/observation-mapping.ts';
import { observation, ROBOT_ID } from '../../../../support/builders.ts';

describe('観測値と DynamoDB のアイテムの変換', () => {
  it('キーは、パーティション = 設備 × 項目、ソートキー = 計測日時 + 取得元（A・M）', () => {
    expect(observationPartitionKey('ROBOT-T1', 'harvestCount')).toBe('ROBOT-T1#harvestCount');
    expect(observationSortKey('2026-10-09T01:00:00.000Z', 'AUTO_IMPORT')).toBe(
      '2026-10-09T01:00:00.000Z#A',
    );
    expect(observationSortKey('2026-10-09T01:00:00.000Z', 'MANUAL')).toBe(
      '2026-10-09T01:00:00.000Z#M',
    );
    expect(manualIndexSortKey('2026-10-09T01:00:00.000Z', 'failureCount')).toBe(
      '2026-10-09T01:00:00.000Z#failureCount',
    );
  });

  it('自動取り込みの観測値: 短い属性名で、省略できる項目は持たない。元に戻せる', () => {
    const original = observation({ itemKey: 'harvestCount', value: 3 });

    const item = toObservationItem(original);

    expect(item).toEqual({
      pk: `${ROBOT_ID}#harvestCount`,
      sk: '2026-10-09T02:00:00.000Z#A',
      v: 3,
      q: original.quality,
      r: Date.parse(original.receivedAt),
    });
    expect(fromObservationItem(item)).toEqual(original);
  });

  it('手動入力の観測値: 入力者・メモ・手動入力の ID・取り込み元などを持ち、疎なインデックスのキーが付く', () => {
    const original = {
      ...observation({ itemKey: 'failureCount', value: 1, source: 'MANUAL', isDeleted: true }),
      enteredBy: toUserId('user-1'),
      note: 'メモ',
      manualEntryId: 'entry-1',
      sourceFileId: 'file.csv',
      formatProfileVersion: 'v1',
    };

    const item = toObservationItem(original);

    expect(item).toMatchObject({
      d: true,
      e: 'user-1',
      n: 'メモ',
      m: 'entry-1',
      f: 'file.csv',
      fv: 'v1',
      g2: ROBOT_ID,
      g2s: '2026-10-09T02:00:00.000Z#failureCount',
    });
    expect(fromObservationItem(item)).toEqual(original);
  });

  it('計測日時が、正規化した形と違えば、元の文字列を持ち、そのまま返す（ソートキーは正規化）', () => {
    const original = observation({
      itemKey: 'harvestCount',
      value: 3,
      observedAt: '2026-10-09T02:00:00Z',
    });

    const item = toObservationItem(original);

    expect(item).toMatchObject({ sk: '2026-10-09T02:00:00.000Z#A', ot: '2026-10-09T02:00:00Z' });
    expect(fromObservationItem(item).observedAt).toBe('2026-10-09T02:00:00Z');
  });

  it('カテゴリは、項目カタログから導けるときは持たない。導けない（カタログにない・違う）ときは持つ', () => {
    const inCatalog = toObservationItem(observation({ itemKey: 'harvestCount', value: 1 }));
    const unknown = toObservationItem({
      ...observation({ itemKey: 'harvestCount', value: 1 }),
      itemKey: 'unknownItem',
      category: 'SAFETY',
    });
    const different = toObservationItem({
      ...observation({ itemKey: 'harvestCount', value: 1 }),
      category: 'SAFETY',
    });

    expect(inCatalog).not.toHaveProperty('c');
    expect(unknown).toMatchObject({ c: 'SAFETY' });
    expect(different).toMatchObject({ c: 'SAFETY' });
    expect(fromObservationItem(unknown)).toMatchObject({
      itemKey: 'unknownItem',
      category: 'SAFETY',
    });
    expect(fromObservationItem(different).category).toBe('SAFETY');
  });

  it('値は、数値・文字列・欠損（null）。ステータスコードは、文字列', () => {
    const roundTrip = (value: number | string | null) =>
      fromObservationItem(toObservationItem(observation({ itemKey: 'harvestCount', value }))).value;

    expect(roundTrip(0)).toBe(0);
    expect(roundTrip('RUNNING')).toBe('RUNNING');
    expect(roundTrip(null)).toBeNull();
  });

  it('日時として解釈できない計測日時・受信日時は、保存の前に、例外にする', () => {
    const bad = observation({ itemKey: 'harvestCount', value: 1 });

    expect(() => toObservationItem({ ...bad, observedAt: 'x' })).toThrow('計測日時');
    expect(() => toObservationItem({ ...bad, receivedAt: 'x' })).toThrow('受信日時');
  });

  it('形式が不正なアイテム（取得元の符号・カテゴリが分からない）は、読み込みで例外にする', () => {
    const item = toObservationItem(observation({ itemKey: 'harvestCount', value: 1 }));

    expect(() => fromObservationItem({ ...item, sk: '2026-10-09T02:00:00.000Z#X' })).toThrow(
      '形式',
    );
    expect(() => fromObservationItem({ ...item, pk: `${ROBOT_ID}#unknownItem` })).toThrow('形式');
  });

  it('日時の正規化: 解釈できなければ undefined', () => {
    expect(normalizedInstant('2026-10-09T01:00:00Z')).toBe('2026-10-09T01:00:00.000Z');
    expect(normalizedInstant('x')).toBeUndefined();
  });
});
