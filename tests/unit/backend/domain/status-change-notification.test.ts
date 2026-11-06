/**
 * 状態の変化の通知の判定（Issue #236。ADR-0019 の D-37・D-38・D-42）の単体テスト。
 * 観点の最終ステータスが「注意」「異常」に変わるとき、通知するかを、状態の変化の履歴から判定する。
 * - 「不明」は、状態の変化とみなさない（直前の「不明でない」状態と比べる）
 * - 「正常が一定時間（既定 15 分）続いたあとの悪化」を、新しい出来事として通知する。短い行き来は、同じ出来事
 * - 同じ出来事の中では、それまでに通知した重大度より重いときだけ通知する（改善は、通知しない）
 */

import { describe, expect, it } from 'vitest';
import type { EvaluationStatus } from '@smart-farm/shared/constants/status';
import {
  DEFAULT_RECURRENCE_AFTER_NORMAL_MINUTES,
  isNotifiableStatusChange,
} from '../../../../src/backend/domain/notification-rules.ts';

type Entry = readonly [EvaluationStatus, string];

/** 履歴の 1 件（時刻は、同じ日の「時:分」）。 */
function history(...entries: Entry[]) {
  return entries.map(([status, time]) => ({
    status,
    changedAt: `2026-10-09T${time}:00.000Z`,
  }));
}

function decide(entries: Entry[], next: EvaluationStatus, now: string, recurrenceMinutes?: number) {
  return isNotifiableStatusChange({
    history: history(...entries),
    next,
    now: new Date(`2026-10-09T${now}:00.000Z`),
    ...(recurrenceMinutes === undefined ? {} : { recurrenceMinutes }),
  });
}

describe('既定値', () => {
  it('正常が続いた時間の既定は、15 分（評価の周期 5 分の 3 回分）', () => {
    expect(DEFAULT_RECURRENCE_AFTER_NORMAL_MINUTES).toBe(15);
  });
});

describe('通知の対象になる状態', () => {
  it.each(['NORMAL', 'UNKNOWN'] as const)('新しい状態が「%s」のときは、通知しない', (next) => {
    expect(decide([['ERROR', '10:00']], next, '10:30')).toBe(false);
    expect(decide([], next, '10:30')).toBe(false);
  });

  it.each(['CAUTION', 'ERROR'] as const)(
    '履歴がない（最初の評価が「%s」）ときは、通知する',
    (next) => {
      expect(decide([], next, '10:00')).toBe(true);
    },
  );

  it('履歴が「不明」だけのときも、履歴がないのと同じ（通知する）', () => {
    expect(decide([['UNKNOWN', '09:00']], 'ERROR', '10:00')).toBe(true);
  });
});

describe('改善・悪化', () => {
  it('異常 → 注意（改善）は、通知しない', () => {
    expect(decide([['ERROR', '10:00']], 'CAUTION', '10:10')).toBe(false);
  });

  it('注意 → 異常（悪化）は、通知する', () => {
    expect(decide([['CAUTION', '10:00']], 'ERROR', '10:10')).toBe(true);
  });

  it('同じ状態が続くとき（注意 → 注意、異常 → 異常）は、通知しない', () => {
    expect(decide([['CAUTION', '10:00']], 'CAUTION', '10:10')).toBe(false);
    expect(decide([['ERROR', '10:00']], 'ERROR', '10:10')).toBe(false);
  });
});

describe('「不明」は、状態の変化とみなさない（D-37）', () => {
  it('異常 → 不明 → 異常 は、継続とみなし、通知しない', () => {
    expect(
      decide(
        [
          ['ERROR', '10:00'],
          ['UNKNOWN', '10:10'],
        ],
        'ERROR',
        '10:20',
      ),
    ).toBe(false);
  });

  it('異常 → 不明 → 正常（20 分）→ 異常 は、正常を挟むので、新しい悪化として通知する', () => {
    expect(
      decide(
        [
          ['ERROR', '10:00'],
          ['UNKNOWN', '10:05'],
          ['NORMAL', '10:10'],
        ],
        'ERROR',
        '10:30',
      ),
    ).toBe(true);
  });

  it('異常 → 不明 → 注意 は、直前の「不明でない」状態（異常）との比較で、改善とみなし、通知しない', () => {
    expect(
      decide(
        [
          ['ERROR', '10:00'],
          ['UNKNOWN', '10:10'],
        ],
        'CAUTION',
        '10:20',
      ),
    ).toBe(false);
  });
});

describe('再発（正常が一定時間続いたあとの悪化。D-38）', () => {
  const recovered: Entry[] = [
    ['ERROR', '10:00'],
    ['NORMAL', '10:20'],
  ];

  it('異常 → 正常（20 分）→ 異常 は、新しい出来事として通知する', () => {
    expect(decide(recovered, 'ERROR', '10:40')).toBe(true);
  });

  it('異常 → 正常（10 分）→ 異常 は、同じ出来事として通知しない', () => {
    expect(decide(recovered, 'ERROR', '10:30')).toBe(false);
  });

  it('正常が、ちょうど 15 分続いたときは、通知する（境界）。14 分のときは、通知しない', () => {
    expect(decide(recovered, 'ERROR', '10:35')).toBe(true);
    expect(decide(recovered, 'ERROR', '10:34')).toBe(false);
  });

  it('正常が続いた時間は、指定できる（既定を変える）', () => {
    expect(decide(recovered, 'ERROR', '10:30', 10)).toBe(true);
    expect(decide(recovered, 'ERROR', '10:40', 30)).toBe(false);
  });

  it('正常が長く続いたあとの「注意」も、新しい出来事として通知する', () => {
    expect(decide(recovered, 'CAUTION', '10:40')).toBe(true);
  });
});

describe('同じ出来事の中の行き来（注意 ⇄ 異常。D-38・D-42）', () => {
  it('注意 → 異常 → 注意 → 異常 は、2 回目の「異常」を通知しない（この出来事で、異常は通知済み）', () => {
    expect(
      decide(
        [
          ['CAUTION', '10:00'],
          ['ERROR', '10:10'],
          ['CAUTION', '10:20'],
        ],
        'ERROR',
        '10:30',
      ),
    ).toBe(false);
  });

  it('注意の出来事のあと、正常が短く続いて、異常になったときは、重くなったので通知する', () => {
    expect(
      decide(
        [
          ['CAUTION', '10:00'],
          ['NORMAL', '10:05'],
        ],
        'ERROR',
        '10:15',
      ),
    ).toBe(true);
  });

  it('異常の出来事のあと、正常が短く続いて、注意になったときは、軽いので通知しない', () => {
    expect(
      decide(
        [
          ['ERROR', '10:00'],
          ['NORMAL', '10:05'],
        ],
        'CAUTION',
        '10:15',
      ),
    ).toBe(false);
  });

  it('出来事の区切り（15 分以上の正常）より前の「異常」は、いまの出来事に数えない', () => {
    const entries: Entry[] = [
      ['ERROR', '09:00'],
      ['NORMAL', '09:10'],
      ['CAUTION', '10:00'],
      ['NORMAL', '10:05'],
    ];

    // いまの出来事は、10:00 の「注意」から。異常は、まだ出ていないので、通知する
    expect(decide(entries, 'ERROR', '10:12')).toBe(true);
    // 注意は、いまの出来事で、通知済み
    expect(decide(entries, 'CAUTION', '10:12')).toBe(false);
  });
});
