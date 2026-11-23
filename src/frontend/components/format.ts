/** 表示用の整形。API は UTC（ISO 8601）で扱い、画面は日本時間（Asia/Tokyo）で表示する。 */

import {
  JST_OFFSET_MINUTES,
  MINUTES_PER_HOUR,
  MS_PER_MINUTE,
  TIME_ZONE_JST,
} from '@smart-farm/shared/time';
import { MESSAGES } from '../i18n/messages.ts';

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

const DATE_TIME_MINUTES_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: TIME_ZONE_JST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  ...DATE_TIME_MINUTES_OPTIONS,
  second: '2-digit',
});

const DATE_TIME_MINUTES_FORMAT = new Intl.DateTimeFormat('ja-JP', DATE_TIME_MINUTES_OPTIONS);

function formatWith(format: Intl.DateTimeFormat, iso: string | null | undefined): string {
  if (iso === null || iso === undefined) {
    return MESSAGES.common.missingValue;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? MESSAGES.common.missingValue : format.format(date);
}

/** 日時を「2026/10/09 12:34:56」の形式（日本時間）にする。欠損は「—」。 */
export function formatDateTimeJst(iso: string | null | undefined): string {
  return formatWith(DATE_TIME_FORMAT, iso);
}

/** 日時を「2026/10/09 12:34」の形式（日本時間。秒は省く）にする。欠損は「—」。ダッシュボードの、判定の対象期間に使う。 */
export function formatDateTimeMinutesJst(iso: string | null | undefined): string {
  return formatWith(DATE_TIME_MINUTES_FORMAT, iso);
}

/** 日本時間の、日付（月・日）と時刻（時・分）の部分。 */
function jstParts(iso: string): { date: string; time: string } | undefined {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return undefined;
  }
  const shifted = new Date(ms + JST_OFFSET_MINUTES * MS_PER_MINUTE);
  const two = (value: number): string => String(value).padStart(2, '0');
  return {
    date: `${two(shifted.getUTCMonth() + 1)}/${two(shifted.getUTCDate())}`,
    time: `${two(shifted.getUTCHours())}:${two(shifted.getUTCMinutes())}`,
  };
}

/**
 * 日時を、基準の日時（通知の日時など）と同じ日（日本時間）なら「11:20」、違う日なら「10/10 02:20」にする（経過の表示用）。
 * 解釈できない日時は「—」。
 */
export function formatShortDateTimeJst(iso: string, baseIso: string): string {
  const target = jstParts(iso);
  if (target === undefined) {
    return MESSAGES.common.missingValue;
  }
  return target.date === jstParts(baseIso)?.date ? target.time : `${target.date} ${target.time}`;
}

/** 経過時間（秒）を「1 分未満」「20 分」「1 時間 30 分」「1 日 1 時間」にする（0 の単位は省く）。 */
export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < 1) {
    return '1 分未満';
  }
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const hours = Math.floor((minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  if (days > 0) {
    return hours > 0 ? `${String(days)} 日 ${String(hours)} 時間` : `${String(days)} 日`;
  }
  if (hours > 0) {
    return rest > 0 ? `${String(hours)} 時間 ${String(rest)} 分` : `${String(hours)} 時間`;
  }
  return `${String(rest)} 分`;
}
