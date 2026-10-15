/** 順序のついた複数のストリームを、先頭の値だけを読みながら、1 つの順序に併合する。 */

/**
 * 各ストリームは、比較関数の順に並んでいる。併合した先頭から、take 件を返す。
 * ストリームは、必要な分だけ読む（先頭の値を、最初に並列で読む）。終わったら、残りのストリームを閉じる。
 */
export async function mergeStreams<Value>(
  streams: readonly AsyncGenerator<Value, void, undefined>[],
  compare: (left: Value, right: Value) => number,
  take: number,
): Promise<Value[]> {
  const heads = await Promise.all(streams.map((stream) => stream.next()));
  const merged: Value[] = [];
  try {
    while (merged.length < take) {
      let best = -1;
      for (const [index, head] of heads.entries()) {
        if (head.done !== true) {
          const current = heads[best];
          if (
            current === undefined ||
            current.done === true ||
            compare(head.value, current.value) < 0
          ) {
            best = index;
          }
        }
      }
      const chosen = heads[best];
      const stream = streams[best];
      if (chosen === undefined || chosen.done === true || stream === undefined) {
        break;
      }
      merged.push(chosen.value);
      if (merged.length < take) {
        // 必要な件数に達したら、次の値は読まない
        heads[best] = await stream.next();
      }
    }
  } finally {
    await Promise.all(streams.map((stream) => stream.return()));
  }
  return merged;
}
