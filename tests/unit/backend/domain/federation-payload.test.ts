/** 連携の項目の分割（#205。1 項目の大きさの上限への対応）の単体テスト。 */

import { describe, expect, it } from 'vitest';
import {
  MAX_OBSERVATIONS_PER_FEDERATION_ITEM,
  splitObservationPayload,
} from '../../../../src/backend/domain/federation-payload.ts';

const observations = (count: number) => Array.from({ length: count }, (_, index) => ({ index }));

describe('splitObservationPayload（観測値の連携の項目の分割）', () => {
  it('上限以下の件数は、分割せず、そのまま 1 項目にする（内容・参照を変えない）', () => {
    const payload = { sourceId: 'robot', fileId: 'f-1', observations: observations(1000) };

    const parts = splitObservationPayload('robot#f-1', payload);

    expect(MAX_OBSERVATIONS_PER_FEDERATION_ITEM).toBe(1000);
    expect(parts).toEqual([{ targetRef: 'robot#f-1', payload }]);
  });

  it('上限を超えたら、上限の件数ごとに分け、順序を保つ。参照に連番を付け、元の項目の情報と、何番目か（part）を持たせる', () => {
    const all = observations(2500);

    const parts = splitObservationPayload('robot#f-1', {
      sourceId: 'robot',
      fileId: 'f-1',
      observations: all,
    });

    expect(parts.map((part) => part.targetRef)).toEqual([
      'robot#f-1#part-1-of-3',
      'robot#f-1#part-2-of-3',
      'robot#f-1#part-3-of-3',
    ]);
    expect(parts.map((part) => (part.payload.observations as unknown[]).length)).toEqual([
      1000, 1000, 500,
    ]);
    expect(parts.map((part) => part.payload.part)).toEqual([
      { index: 1, total: 3 },
      { index: 2, total: 3 },
      { index: 3, total: 3 },
    ]);
    expect(parts.every((part) => part.payload.sourceId === 'robot')).toBe(true);
    expect(parts.every((part) => part.payload.fileId === 'f-1')).toBe(true);
    expect(parts.flatMap((part) => part.payload.observations as unknown[])).toEqual(all);
  });

  it('観測値の配列を持たない内容（評価結果など）は、そのまま 1 項目にする', () => {
    const payload = { viewpointId: 'safety', status: 'ERROR' };

    expect(splitObservationPayload('evaluation#1', payload)).toEqual([
      { targetRef: 'evaluation#1', payload },
    ]);
  });

  it('境界: 上限ちょうど +1 件は、2 項目（1000 件と 1 件）になる', () => {
    const parts = splitObservationPayload('r#f', { observations: observations(1001) });

    expect(parts.map((part) => (part.payload.observations as unknown[]).length)).toEqual([1000, 1]);
  });
});
