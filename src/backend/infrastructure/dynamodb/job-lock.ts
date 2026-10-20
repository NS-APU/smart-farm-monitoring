/**
 * ジョブの排他（リース式ロック）の DynamoDB 実装（JobLockPort。Issue #76。ADR-0011）。Lambda の複数の実行環境で、排他する。
 *
 * 項目: `JOBLOCK` / `{ロックの名前}`、`owner` = 取得した実行の識別子、`expiresAt` = ロックの期限（エポックミリ秒）、
 * `ttl` = 項目が不要になる時刻（エポック秒。TTL の設定で、自動で消える。期限の 1 時間後）。
 * 取得は、「項目がない、または、期限が過ぎている」ときだけ成功する条件つきの書き込み（同時に取りに来ても、1 つだけが成功する）。
 * 解放は、「自分が取ったロック」のときだけ、期限を 0 にする（期限が過ぎて、別の実行に取られていたら、何もしない）。
 */

import { randomUUID } from 'node:crypto';
import type { ClockPort } from '../../application/ports/clock-port.ts';
import type { JobLockPort } from '../../application/ports/job-lock-port.ts';
import { updateItemIf, type Database } from './operations.ts';

const PARTITION = 'JOBLOCK';
/** 項目を消す（TTL）までの、期限からの猶予（秒）。期限の前に、消えないようにする。 */
const TTL_GRACE_SECONDS = 60 * 60;

export function createJobLock(db: Database, clock: ClockPort): JobLockPort {
  const table = db.tables.main;

  return {
    async tryAcquire(key, leaseMs) {
      const nowMs = clock.now().getTime();
      const owner = randomUUID();
      const expiresAt = nowMs + leaseMs;
      const acquired = await updateItemIf(db, table, {
        key: { pk: PARTITION, sk: key },
        update: 'SET #owner = :owner, expiresAt = :expiresAt, #ttl = :ttl',
        condition: 'attribute_not_exists(pk) OR expiresAt <= :now',
        names: { '#owner': 'owner', '#ttl': 'ttl' },
        values: {
          ':owner': owner,
          ':expiresAt': expiresAt,
          ':ttl': Math.ceil(expiresAt / 1000) + TTL_GRACE_SECONDS,
          ':now': nowMs,
        },
      });
      if (!acquired) {
        return null;
      }
      return {
        async release() {
          await updateItemIf(db, table, {
            key: { pk: PARTITION, sk: key },
            update: 'SET expiresAt = :released',
            condition: '#owner = :owner',
            names: { '#owner': 'owner' },
            values: { ':owner': owner, ':released': 0 },
          });
        },
      };
    },
  };
}
