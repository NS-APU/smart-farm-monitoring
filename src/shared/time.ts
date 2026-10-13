/**
 * 時間の単位換算とタイムゾーンの定数。時刻は UTC で扱い、画面に表示するときにのみ日本時間へ変換する
 * （coding-standards.md「型とデータ」）。
 */

export const SECONDS_PER_HOUR = 3600;
export const MINUTES_PER_HOUR = 60;
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** 日本時間（画面の表示と、日単位の集計の区切りに使う）。 */
export const TIME_ZONE_JST = 'Asia/Tokyo';
/** 日本時間の UTC からの差（分）。 */
export const JST_OFFSET_MINUTES = 9 * MINUTES_PER_HOUR;
/** 日本時間の UTC からの差（ISO 8601 の表記）。 */
export const JST_OFFSET_ISO = '+09:00';

/**
 * ISO 8601（UTC）の2つの日時の前後を比べる（負: left が前／0: 同時刻／正: left が後）。
 * 表記の長さが同じなら、文字列の比較（高速）。違う場合（ミリ秒の有無。`...:00Z` と `...:00.000Z`）は、
 * 文字列のままでは、同じ時刻でも順序がずれる（`Z` は `.` より後ろ）ため、日時として比べる（V-088）。
 */
export function compareIsoInstants(left: string, right: string): number {
  if (left.length === right.length) {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return Date.parse(left) - Date.parse(right);
}

/** 日時（Date）を、ISO 8601（UTC）の文字列にする。値がない（null）ときは null のまま。 */
export function toIsoOrNull(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}
