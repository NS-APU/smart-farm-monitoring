import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../../../src/shared/errors.ts';
import {
  decodeKeyCursor,
  encodeKeyCursor,
} from '../../../../../src/backend/infrastructure/dynamodb/key-cursor.ts';
import {
  instantKey,
  timeOfSortKey,
  timedSortKey,
  upperBoundOf,
} from '../../../../../src/backend/infrastructure/dynamodb/keys.ts';
import { mergeStreams } from '../../../../../src/backend/infrastructure/dynamodb/merge.ts';

describe('DynamoDB のキー（時刻の正規化）', () => {
  it('日時を、UTC・ミリ秒つきの固定長にする（ミリ秒なし・オフセットつきも、同じ時刻は同じ文字列）', () => {
    expect(instantKey('2026-10-09T01:00:00Z')).toBe('2026-10-09T01:00:00.000Z');
    expect(instantKey('2026-10-09T01:00:00.000Z')).toBe('2026-10-09T01:00:00.000Z');
    expect(instantKey('2026-10-09T10:00:00+09:00')).toBe('2026-10-09T01:00:00.000Z');
  });

  it('解釈できない文字列は、そのまま返す（キーの組み立てで、例外にしない）', () => {
    expect(instantKey('not-a-date')).toBe('not-a-date');
  });

  it('文字列の順が、時刻の順になる（ミリ秒の有無にかかわらず）', () => {
    const keys = ['2026-10-09T01:00:01Z', '2026-10-09T01:00:00.500Z', '2026-10-09T01:00:00Z'].map(
      instantKey,
    );

    expect([...keys].sort()).toEqual([keys[2], keys[1], keys[0]]);
  });

  it('時刻つきのソートキーは、`{日時}#{識別子}`。日時の部分を取り出せる', () => {
    const sortKey = timedSortKey('2026-10-09T01:00:00Z', 'id-1');

    expect(sortKey).toBe('2026-10-09T01:00:00.000Z#id-1');
    expect(timeOfSortKey(sortKey)).toBe('2026-10-09T01:00:00.000Z');
    expect(timeOfSortKey('2026-10-09T01:00:00.000Z')).toBe('2026-10-09T01:00:00.000Z');
  });

  it('範囲の上端は、その日時のすべてのソートキーを含み、次の日時は含まない', () => {
    const upper = upperBoundOf('2026-10-09T01:00:00.000Z');

    expect('2026-10-09T01:00:00.000Z#A' <= upper).toBe(true);
    expect('2026-10-09T01:00:00.000Z#￿' <= upper).toBe(true);
    expect('2026-10-09T01:00:00.001Z#A' <= upper).toBe(false);
  });
});

describe('DynamoDB のカーソル', () => {
  it('位置を、不透明な文字列にして、元に戻せる。省略なら undefined', () => {
    const cursor = encodeKeyCursor(['a', '2026-10-09T01:00:00.000Z#x']);

    expect(decodeKeyCursor(cursor, 2)).toEqual(['a', '2026-10-09T01:00:00.000Z#x']);
    expect(decodeKeyCursor(undefined, 2)).toBeUndefined();
  });

  it.each([
    ['base64url でない', '!!'],
    ['JSON でない', Buffer.from('abc').toString('base64url')],
    ['配列でない', Buffer.from('{"a":1}').toString('base64url')],
    ['個数が違う', Buffer.from('["a"]').toString('base64url')],
    ['文字列でない要素', Buffer.from('["a",1]').toString('base64url')],
    ['オフセットの形式', Buffer.from('-3').toString('base64url')],
  ])('不正なカーソル（%s）は、入力不正（VALIDATION_ERROR）にする', (_name, cursor) => {
    expect(() => decodeKeyCursor(cursor, 2)).toThrow(AppError);
    expect(() => decodeKeyCursor(cursor, 2)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});

async function* numbers(values: readonly number[]): AsyncGenerator<number, void, undefined> {
  for (const value of values) {
    await Promise.resolve();
    yield value;
  }
}

describe('ストリームの併合', () => {
  const ascending = (left: number, right: number): number => left - right;

  it('順序のついた複数のストリームを、1 つの順序に併合し、先頭から必要な件数だけ返す', async () => {
    const merged = await mergeStreams(
      [numbers([1, 4, 7]), numbers([2, 5]), numbers([]), numbers([3, 6, 8])],
      ascending,
      5,
    );

    expect(merged).toEqual([1, 2, 3, 4, 5]);
  });

  it('すべて読み終えたら、件数に満たなくても終わる。ストリームがなくても、空', async () => {
    expect(await mergeStreams([numbers([2]), numbers([1])], ascending, 10)).toEqual([1, 2]);
    expect(await mergeStreams([], ascending, 3)).toEqual([]);
  });

  it('必要な分だけ読み、終わったら、残りのストリームを閉じる', async () => {
    const closed = vi.fn();
    async function* tracked(values: readonly number[]): AsyncGenerator<number, void, undefined> {
      try {
        yield* numbers(values);
      } finally {
        closed();
      }
    }

    const merged = await mergeStreams([tracked([1, 3, 5]), tracked([2, 4, 6])], ascending, 2);

    expect(merged).toEqual([1, 2]);
    expect(closed).toHaveBeenCalledTimes(2);
  });
});
