/**
 * 時計の実装（ClockPort）。
 * - システム時計: 実際の時刻・実際の待機
 * - 操作できる時計: 時刻の固定・進行（E2E・負荷テスト・手動の検証で、時間の経過を再現する）
 */

import type { ClockPort } from '../../application/ports/clock-port.ts';

/** 実際の時間で待つ。 */
function realSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function createSystemClock(): ClockPort {
  return {
    now: () => new Date(),
    sleep: realSleep,
  };
}

export interface ControllableClock extends ClockPort {
  /** 時刻を指定した日時にする。固定中は固定したまま、動作中は以降も実時間で進む。 */
  set(date: Date): void;
  /** 時刻を固定する（日時を省略すると、現在の時刻で固定）。固定中の sleep は、待たずに時刻だけを進める。 */
  freeze(date?: Date): void;
  /** 固定を解除し、実時間で進める。 */
  unfreeze(): void;
  /** 時刻を進める。 */
  advance(milliseconds: number): void;
  isFrozen(): boolean;
}

export function createControllableClock(initial?: Date): ControllableClock {
  let frozenMs: number | undefined;
  let offsetMs = 0;

  function nowMs(): number {
    return frozenMs ?? Date.now() + offsetMs;
  }

  const clock: ControllableClock = {
    now: () => new Date(nowMs()),
    set(date) {
      if (frozenMs === undefined) {
        offsetMs = date.getTime() - Date.now();
      } else {
        frozenMs = date.getTime();
      }
    },
    freeze(date) {
      frozenMs = date === undefined ? nowMs() : date.getTime();
    },
    unfreeze() {
      if (frozenMs !== undefined) {
        offsetMs = frozenMs - Date.now();
        frozenMs = undefined;
      }
    },
    advance(milliseconds) {
      if (frozenMs === undefined) {
        offsetMs += milliseconds;
      } else {
        frozenMs += milliseconds;
      }
    },
    isFrozen: () => frozenMs !== undefined,
    sleep(milliseconds) {
      if (frozenMs !== undefined) {
        frozenMs += milliseconds;
        return Promise.resolve();
      }
      return realSleep(milliseconds);
    },
  };
  if (initial !== undefined) {
    clock.freeze(initial);
  }
  return clock;
}
