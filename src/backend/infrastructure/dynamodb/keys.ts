/** DynamoDB のキーの組み立て（ADR-0007）。時刻は、ミリ秒つきの UTC に正規化して、文字列の順を、時刻の順にする。 */

/** 日時（ISO 8601）を、UTC・ミリ秒つきの固定長（`2026-10-15T01:02:03.000Z`）にする。解釈できなければ、そのまま返す。 */
export function instantKey(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toISOString();
}

/**
 * ソートキーが `{日時}#…` の形のとき、その日時以前（その日時を含む）の、範囲の上端。
 * `#` の次の文字（`$`）にすると、`{日時}#…` のすべてが、範囲に入る。
 */
export function upperBoundOf(instant: string): string {
  return `${instant}$`;
}

/** 日時に続く識別子つきのソートキー（`{日時}#{識別子}`）。同じ日時のものは、識別子の順。 */
export function timedSortKey(iso: string, id: string): string {
  return `${instantKey(iso)}#${id}`;
}

/** ソートキー（`{日時}#…`）の、日時の部分。 */
export function timeOfSortKey(sortKey: string): string {
  const separator = sortKey.indexOf('#');
  return separator < 0 ? sortKey : sortKey.slice(0, separator);
}
