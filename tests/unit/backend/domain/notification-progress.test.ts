/**
 * 通知の経過・回復日時の導出（Issue #238。ADR-0019 の D-42）の単体テスト。
 * 通知ごとに、通知の時点から、同じ観点・設備の次の通知（なければ現在）までの、状態の変化（経過）と、
 * 最初に「正常」に戻った日時（回復日時）を、状態の変化の履歴から導出する。「不明」は、経過に出さない（D-37）。
 */

import { describe, expect, it } from 'vitest';
import type { EvaluationStatus } from '@smart-farm/shared/constants/status';
import { buildNotificationProgress } from '../../../../src/backend/domain/notification-progress.ts';

type Entry = readonly [EvaluationStatus, string];

const at = (time: string): string => `2026-10-09T${time}:00.000Z`;

function history(...entries: Entry[]) {
  return entries.map(([status, time]) => ({ status, changedAt: at(time) }));
}

function progressOf(
  entries: Entry[],
  notifiedAt: string,
  nextNotifiedAt: string | null,
  now = '12:00',
) {
  return buildNotificationProgress({
    history: history(...entries),
    notifiedAt: new Date(at(notifiedAt)),
    nextNotifiedAt: nextNotifiedAt === null ? null : new Date(at(nextNotifiedAt)),
    now: new Date(at(now)),
  });
}

describe('経過（状態の変化）', () => {
  it('通知の時点から、次の通知の時点までの変化を、古い順に返す（10:00 異常 → 10:20 正常 → 10:40 異常）', () => {
    const progress = progressOf(
      [
        ['ERROR', '10:00'],
        ['NORMAL', '10:20'],
        ['ERROR', '10:40'],
      ],
      '10:00',
      '10:40',
    );

    expect(progress?.changes).toEqual([
      { status: 'ERROR', changedAt: at('10:00') },
      { status: 'NORMAL', changedAt: at('10:20') },
      { status: 'ERROR', changedAt: at('10:40') },
    ]);
  });

  it('次の通知がなければ、現在までの変化を返す。変化がなければ、通知の時点の状態だけ', () => {
    const entries: Entry[] = [
      ['ERROR', '10:40'],
      ['NORMAL', '11:10'],
    ];

    expect(progressOf(entries, '10:40', null, '11:30')?.changes.map((item) => item.status)).toEqual(
      ['ERROR', 'NORMAL'],
    );
    expect(progressOf([['ERROR', '10:40']], '10:40', null, '11:30')?.changes).toEqual([
      { status: 'ERROR', changedAt: at('10:40') },
    ]);
  });

  it('次の通知より後の変化は、含めない。通知より前の変化も、含めない', () => {
    const entries: Entry[] = [
      ['NORMAL', '09:00'],
      ['ERROR', '10:00'],
      ['NORMAL', '10:20'],
      ['ERROR', '10:40'],
      ['NORMAL', '11:00'],
    ];

    const first = progressOf(entries, '10:00', '10:40');
    const second = progressOf(entries, '10:40', null);

    expect(first?.changes.map((item) => item.changedAt)).toEqual([
      at('10:00'),
      at('10:20'),
      at('10:40'),
    ]);
    expect(second?.changes.map((item) => item.changedAt)).toEqual([at('10:40'), at('11:00')]);
  });

  it('次の通知の時点ちょうどの変化は含め、1 分後の変化は含めない', () => {
    const entries: Entry[] = [
      ['CAUTION', '10:00'],
      ['ERROR', '10:30'],
      ['NORMAL', '10:31'],
    ];

    expect(progressOf(entries, '10:00', '10:30')?.changes.map((item) => item.status)).toEqual([
      'CAUTION',
      'ERROR',
    ]);
  });

  it('「不明」は、経過に出さない。不明を挟んで、同じ状態が続くものは、1 件にまとめる（異常 → 不明 → 異常）', () => {
    const progress = progressOf(
      [
        ['ERROR', '10:00'],
        ['UNKNOWN', '10:10'],
        ['ERROR', '10:20'],
        ['NORMAL', '10:30'],
      ],
      '10:00',
      null,
    );

    expect(progress?.changes).toEqual([
      { status: 'ERROR', changedAt: at('10:00') },
      { status: 'NORMAL', changedAt: at('10:30') },
    ]);
  });

  it('通知の作成日時が、変化の日時より、ミリ秒だけ後でも、その変化を通知の時点の状態とする', () => {
    const progress = buildNotificationProgress({
      history: history(['ERROR', '10:00']),
      notifiedAt: new Date('2026-10-09T10:00:00.050Z'),
      nextNotifiedAt: null,
      now: new Date(at('11:00')),
    });

    expect(progress?.changes).toEqual([{ status: 'ERROR', changedAt: at('10:00') }]);
  });

  it('履歴が順不同でも、古い順に返す', () => {
    const progress = progressOf(
      [
        ['NORMAL', '10:20'],
        ['ERROR', '10:00'],
      ],
      '10:00',
      null,
    );

    expect(progress?.changes.map((item) => item.status)).toEqual(['ERROR', 'NORMAL']);
  });
});

describe('回復日時', () => {
  it('経過の中で、最初に「正常」に戻った日時と、通知の時点からの経過時間（秒）を返す', () => {
    const progress = progressOf(
      [
        ['ERROR', '10:00'],
        ['NORMAL', '10:20'],
        ['ERROR', '10:40'],
        ['NORMAL', '11:00'],
      ],
      '10:00',
      '10:40',
    );

    expect(progress?.recovery).toEqual({ recoveredAt: at('10:20'), elapsedSeconds: 1200 });
  });

  it('注意 → 異常 → 正常 は、最初に「正常」に戻った日時（通知の時点から 30 分）', () => {
    const progress = progressOf(
      [
        ['CAUTION', '10:00'],
        ['ERROR', '10:10'],
        ['NORMAL', '10:30'],
      ],
      '10:00',
      null,
    );

    expect(progress?.recovery).toEqual({ recoveredAt: at('10:30'), elapsedSeconds: 1800 });
  });

  it('経過に「正常」がなければ、未回復（null）', () => {
    expect(
      progressOf(
        [
          ['CAUTION', '10:00'],
          ['ERROR', '10:10'],
          ['CAUTION', '10:20'],
        ],
        '10:00',
        null,
      )?.recovery,
    ).toBeNull();
    expect(progressOf([['ERROR', '10:00']], '10:00', null)?.recovery).toBeNull();
  });

  it('経過時間は、秒（端数は切り捨て）', () => {
    const progress = buildNotificationProgress({
      history: [
        { status: 'ERROR', changedAt: '2026-10-09T10:00:00.000Z' },
        { status: 'NORMAL', changedAt: '2026-10-09T10:01:30.900Z' },
      ],
      notifiedAt: new Date('2026-10-09T10:00:00.000Z'),
      nextNotifiedAt: null,
      now: new Date(at('11:00')),
    });

    expect(progress?.recovery?.elapsedSeconds).toBe(90);
  });

  it('次の通知より後に正常に戻っても、その通知の回復には数えない（未回復）', () => {
    const progress = progressOf(
      [
        ['ERROR', '10:00'],
        ['ERROR', '10:30'],
        ['NORMAL', '11:00'],
      ],
      '10:00',
      '10:30',
    );

    expect(progress?.recovery).toBeNull();
  });
});

describe('経過を示せない（null）', () => {
  it('履歴がない（設備を削除した、など）', () => {
    expect(progressOf([], '10:00', null)).toBeNull();
  });

  it('履歴が「不明」だけ', () => {
    expect(progressOf([['UNKNOWN', '09:00']], '10:00', null)).toBeNull();
  });

  it('通知の時点以前の、「不明」でない履歴がない（すべて、通知より後）', () => {
    expect(progressOf([['ERROR', '10:30']], '10:00', null)).toBeNull();
  });
});
