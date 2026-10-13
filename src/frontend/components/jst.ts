/**
 * 日本時間（Asia/Tokyo）の日付・日時の入力と、API の日時（UTC。ISO 8601）の変換。
 * 画面の入力（日付・日時）は、ブラウザの時差に関わらず、日本時間として扱う（functional-specification.md 1.2）。
 */

import { JST_OFFSET_ISO, TIME_ZONE_JST } from '@smart-farm/shared/time';

const PART_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE_JST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function partsOf(date: Date): Record<string, string> {
  return Object.fromEntries(PART_FORMAT.formatToParts(date).map((part) => [part.type, part.value]));
}

/** 日本時間の日付（`2026-10-09`）の、開始（0:00:00.000）または終了（23:59:59.999）の日時（UTC）。不正なら null。 */
export function jstDateToIso(date: string, edge: 'start' | 'end'): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  const time = edge === 'start' ? '00:00:00.000' : '23:59:59.999';
  const value = new Date(`${date}T${time}${JST_OFFSET_ISO}`);
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

/** 日本時間の日時の入力（`2026-10-09T12:34`）を、日時（UTC）にする。不正なら null。 */
export function jstDateTimeToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}:00${JST_OFFSET_ISO}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 日時（UTC）を、日本時間の日時の入力の形式（`2026-10-09T12:34`）にする。 */
export function isoToJstDateTimeInput(iso: string): string {
  const parts = partsOf(new Date(iso));
  return `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}T${parts.hour ?? ''}:${parts.minute ?? ''}`;
}
