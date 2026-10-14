/**
 * 負荷テストの、手動入力の計測日時（画面の入力欄の形式。日本時間・分単位）の補助。
 * 同じ設備・項目・計測日時の手動入力は、1つだけ（重複は 409）。呼ぶたびに、1分ずつ遡る日時を返す。
 * 基準の時刻は、最初に固定する。呼ぶたびに現在の時刻を読むと、呼び出しの間隔が約1分のとき、前の呼び出しと同じ分になり、重複する。
 */

/** 日本時間の「yyyy-MM-ddTHH:mm」（datetime-local の入力欄の形式）。 */
export function jstInput(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}T${parts.hour ?? ''}:${parts.minute ?? ''}`;
}

/**
 * 計測日時を返す関数を作る。`baseMs` の `startOffsetMinutes` 分前から、呼ぶたびに、1分ずつ遡る。
 * 利用者（並行して操作する人）ごとに、`startOffsetMinutes` を、十分に離す（呼ぶ回数より大きく）。
 */
export function createObservedAtSource(baseMs: number, startOffsetMinutes: number): () => string {
  let offsetMinutes = startOffsetMinutes;
  return () => {
    offsetMinutes += 1;
    return jstInput(new Date(baseMs - offsetMinutes * 60_000));
  };
}
