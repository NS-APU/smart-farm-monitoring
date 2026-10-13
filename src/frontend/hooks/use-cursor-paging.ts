/**
 * カーソル（不透明な文字列）によるページ分割の状態。前のページへ戻れるよう、カーソルを積む。
 * 絞り込み・並べ替えの条件（resetKey）が変わったら、先頭のページに戻る。
 */

import { useCallback, useMemo, useState } from 'react';

export interface CursorPaging {
  /** 現在のページのカーソル（先頭のページは undefined）。 */
  readonly cursor: string | undefined;
  /** 現在のページの番号（1 から）。 */
  readonly pageNumber: number;
  readonly hasPrevious: boolean;
  readonly goNext: (nextCursor: string) => void;
  readonly goPrevious: () => void;
}

interface Stack {
  readonly key: string;
  readonly cursors: readonly (string | undefined)[];
}

export function useCursorPaging(resetKey: string): CursorPaging {
  const [stack, setStack] = useState<Stack>({ key: resetKey, cursors: [undefined] });
  const cursors = useMemo(
    () => (stack.key === resetKey ? stack.cursors : [undefined]),
    [stack, resetKey],
  );

  const goNext = useCallback(
    (nextCursor: string) => {
      setStack({ key: resetKey, cursors: [...cursors, nextCursor] });
    },
    [resetKey, cursors],
  );
  const goPrevious = useCallback(() => {
    setStack({ key: resetKey, cursors: cursors.slice(0, -1) });
  }, [resetKey, cursors]);

  return {
    cursor: cursors.at(-1),
    pageNumber: cursors.length,
    hasPrevious: cursors.length > 1,
    goNext,
    goPrevious,
  };
}
