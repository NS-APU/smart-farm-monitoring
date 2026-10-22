/**
 * ログインの試行回数の制限のメモリ実装（LoginThrottlePort）。1 つのプロセスの中だけで、制限を持つ
 * （ローカル・テスト用。Lambda のように、複数の実行環境で共有する必要があるときは、DynamoDB の実装を使う）。
 */

import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import type { ClockPort } from '../../application/ports/clock-port.ts';
import type { LoginThrottlePort } from '../../application/ports/login-throttle-port.ts';
import { LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MINUTES } from '../common/auth-policy.ts';

export function createInMemoryLoginThrottle(clock: ClockPort): LoginThrottlePort {
  const failures = new Map<string, number[]>();

  function recent(clientKey: string): number[] {
    const threshold = clock.now().getTime() - LOGIN_FAILURE_WINDOW_MINUTES * MS_PER_MINUTE;
    return (failures.get(clientKey) ?? []).filter((at) => at > threshold);
  }

  return {
    isLocked: (clientKey) => Promise.resolve(recent(clientKey).length >= LOGIN_FAILURE_LIMIT),
    recordFailure(clientKey) {
      failures.set(clientKey, [...recent(clientKey), clock.now().getTime()]);
      return Promise.resolve();
    },
    reset(clientKey) {
      failures.delete(clientKey);
      return Promise.resolve();
    },
  };
}
