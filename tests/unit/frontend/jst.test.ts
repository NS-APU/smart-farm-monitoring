import { describe, expect, it } from 'vitest';
import {
  isoToJstDateTimeInput,
  jstDateTimeToIso,
  jstDateToIso,
} from '../../../src/frontend/components/jst.ts';

describe('日本時間の日付・日時の変換', () => {
  it('日本時間の日付の、開始・終了を、UTC の日時にする', () => {
    expect(jstDateToIso('2026-10-09', 'start')).toBe('2026-10-08T15:00:00.000Z');
    expect(jstDateToIso('2026-10-09', 'end')).toBe('2026-10-09T14:59:59.999Z');
  });

  it('形式が不正な日付・存在しない日付（13 月）は、null', () => {
    expect(jstDateToIso('2026/10/09', 'start')).toBeNull();
    expect(jstDateToIso('', 'end')).toBeNull();
    expect(jstDateToIso('2026-13-45', 'start')).toBeNull();
  });

  it('日本時間の日時の入力を、UTC の日時にする。形式が不正・存在しない日時は null', () => {
    expect(jstDateTimeToIso('2026-10-09T12:34')).toBe('2026-10-09T03:34:00.000Z');
    expect(jstDateTimeToIso('2026-10-09 12:34')).toBeNull();
    expect(jstDateTimeToIso('2026-13-45T25:61')).toBeNull();
  });

  it('UTC の日時を、日本時間の日時の入力の形式にする（日付をまたぐ・0 時・23 時 59 分）', () => {
    expect(isoToJstDateTimeInput('2026-10-09T03:34:00.000Z')).toBe('2026-10-09T12:34');
    expect(isoToJstDateTimeInput('2026-10-09T15:00:00.000Z')).toBe('2026-10-10T00:00');
    expect(isoToJstDateTimeInput('2026-10-09T14:59:00.000Z')).toBe('2026-10-09T23:59');
  });
});
