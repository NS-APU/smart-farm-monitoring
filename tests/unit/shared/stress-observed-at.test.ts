/**
 * 負荷テストの、手動入力の計測日時の補助（tests/stress/support/observed-at.ts）の単体テスト。
 * 不具合: 呼ぶたびに現在の時刻を読んでいたため、呼び出しの間隔が約1分のとき、前の呼び出しと同じ分になり、手動入力が 409（重複）になった。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createObservedAtSource, jstInput } from '../../stress/support/observed-at.ts';

const BASE_MS = Date.parse('2026-10-12T10:00:00Z');

describe('jstInput', () => {
  it('日時を、日本時間の「yyyy-MM-ddTHH:mm」（datetime-local の形式）にする', () => {
    expect(jstInput(new Date('2026-10-12T01:05:30Z'))).toBe('2026-10-12T10:05');
    expect(jstInput(new Date('2026-10-12T15:00:00Z'))).toBe('2026-10-13T00:00');
  });
});

describe('createObservedAtSource', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('基準の時刻の、開始の分数 + 1 分前から、呼ぶたびに、1分ずつ遡る', () => {
    const next = createObservedAtSource(BASE_MS, 20);

    expect([next(), next(), next()]).toEqual([
      '2026-10-12T18:39',
      '2026-10-12T18:38',
      '2026-10-12T18:37',
    ]);
  });

  it('呼び出しの間に、ちょうど1分経っても、前の呼び出しと同じ日時にならない（現在の時刻を読み直さない）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    const next = createObservedAtSource(Date.now(), 20);

    const first = next();
    vi.advanceTimersByTime(60_000);
    const second = next();
    vi.advanceTimersByTime(60_000);
    const third = next();

    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('利用者ごとに開始を 30 分離せば、2ラウンドで、利用者の間でも重複しない', () => {
    const users = Array.from({ length: 10 }, (_, index) =>
      createObservedAtSource(BASE_MS, 120 + index * 30),
    );

    const all = users.flatMap((next) => [next(), next()]);

    expect(new Set(all).size).toBe(20);
  });
});
