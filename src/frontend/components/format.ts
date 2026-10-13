/** 表示用の整形。API は UTC（ISO 8601）で扱い、画面は日本時間（Asia/Tokyo）で表示する。 */

import { TIME_ZONE_JST } from '@smart-farm/shared/time';
import { MESSAGES } from '../i18n/messages.ts';

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TIME_ZONE_JST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 日時を「2026/10/09 12:34:56」の形式（日本時間）にする。欠損は「—」。 */
export function formatDateTimeJst(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) {
    return MESSAGES.common.missingValue;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? MESSAGES.common.missingValue
    : DATE_TIME_FORMAT.format(date);
}
