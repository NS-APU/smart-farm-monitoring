/**
 * ジョブの排他のメモリ実装（JobLockPort）。1 つのプロセスの中だけで、排他する
 * （ローカル・テスト用。Lambda のように、複数の実行環境が、同じジョブを起動しうるときは、DynamoDB の実装を使う）。
 */

import type { ClockPort } from '../../application/ports/clock-port.ts';
import type { JobLockPort } from '../../application/ports/job-lock-port.ts';

interface Holder {
  readonly token: symbol;
  readonly expiresAt: number;
}

export function createInMemoryJobLock(clock: ClockPort): JobLockPort {
  const holders = new Map<string, Holder>();

  return {
    tryAcquire(key, leaseMs) {
      const nowMs = clock.now().getTime();
      const current = holders.get(key);
      if (current !== undefined && current.expiresAt > nowMs) {
        return Promise.resolve(null);
      }
      const token = Symbol(key);
      holders.set(key, { token, expiresAt: nowMs + leaseMs });
      return Promise.resolve({
        release() {
          // 期限が過ぎて、別の実行に取られていたら、消さない
          if (holders.get(key)?.token === token) {
            holders.delete(key);
          }
          return Promise.resolve();
        },
      });
    },
  };
}
