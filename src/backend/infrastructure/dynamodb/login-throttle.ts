/**
 * ログインの試行回数の制限の DynamoDB 実装（LoginThrottlePort。FR-9.2）。Lambda の複数の実行環境で、制限を共有する。
 *
 * 接続元（IP アドレスに由来する値）は、ハッシュにして、キーにする（個人に結びつく値を、そのまま保存しない）。
 * 項目: `LOGINFAIL` / `{接続元のハッシュ}`、`at` = 直近の失敗の時刻（エポックミリ秒。制限の回数まで）、
 * `ttl` = 記録が不要になる時刻（エポック秒。TTL の設定で、自動で消える。読み取りでも、期限を過ぎたものは、数えない）。
 * 同じ接続元から、同時に失敗が重なったときは、記録が 1 回分、数えられないことがある（読んでから書く）。
 * 試行回数の上限は、Cognito 自身の、ユーザーごとの一時的なロックも、働くため、目安として十分とする（ADR-0008）。
 */

import { createHash } from 'node:crypto';
import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import type { ClockPort } from '../../application/ports/clock-port.ts';
import type { LoginThrottlePort } from '../../application/ports/login-throttle-port.ts';
import { LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MINUTES } from '../common/auth-policy.ts';
import { deleteItem, getItem, putItem, type Database } from './operations.ts';

const PARTITION = 'LOGINFAIL';
const WINDOW_MS = LOGIN_FAILURE_WINDOW_MINUTES * MS_PER_MINUTE;

function sortKeyOf(clientKey: string): string {
  return createHash('sha256').update(clientKey).digest('hex');
}

export function createLoginThrottle(db: Database, clock: ClockPort): LoginThrottlePort {
  const table = db.tables.main;

  /** 制限の時間内の失敗の時刻。 */
  async function recentFailures(sortKey: string): Promise<number[]> {
    const item = await getItem(db, table, { pk: PARTITION, sk: sortKey });
    const threshold = clock.now().getTime() - WINDOW_MS;
    const recorded: unknown = item?.at;
    return Array.isArray(recorded)
      ? recorded.filter((at): at is number => typeof at === 'number' && at > threshold)
      : [];
  }

  return {
    async isLocked(clientKey) {
      return (await recentFailures(sortKeyOf(clientKey))).length >= LOGIN_FAILURE_LIMIT;
    },
    async recordFailure(clientKey) {
      const sortKey = sortKeyOf(clientKey);
      const nowMs = clock.now().getTime();
      const failures = [...(await recentFailures(sortKey)), nowMs].slice(-LOGIN_FAILURE_LIMIT);
      await putItem(db, table, {
        pk: PARTITION,
        sk: sortKey,
        at: failures,
        ttl: Math.ceil((nowMs + WINDOW_MS) / 1000),
      });
    },
    reset: (clientKey) => deleteItem(db, table, { pk: PARTITION, sk: sortKeyOf(clientKey) }),
  };
}
