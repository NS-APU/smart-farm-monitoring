/**
 * ジョブの排他（JobLockPort）の契約テスト（Issue #76。ADR-0011）。メモリの実装と、DynamoDB の実装（DynamoDB Local）に、
 * 同じシナリオを適用する。DynamoDB は、条件つきの書き込みで、同時に取りに来ても、1 つだけが成功することを確認する。
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { ClockPort } from '../../src/backend/application/ports/clock-port.ts';
import type { JobLockPort } from '../../src/backend/application/ports/job-lock-port.ts';
import { createJobLock } from '../../src/backend/infrastructure/dynamodb/job-lock.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createInMemoryJobLock } from '../../src/backend/infrastructure/local/in-memory-job-lock.ts';
import {
  createDynamoTestDatabase,
  dropDynamoTestTables,
} from '../support/dynamodb-test-database.ts';

afterAll(dropDynamoTestTables);

const NOW = new Date('2026-10-20T03:00:00.000Z');
const LEASE_MS = 6 * 60_000;

type LockFactory = (clock: ClockPort) => Promise<JobLockPort>;

const IMPLEMENTATIONS: readonly (readonly [string, LockFactory])[] = [
  ['メモリ', (clock) => Promise.resolve(createInMemoryJobLock(clock))],
  [
    'DynamoDB',
    async (clock) => {
      const database = createDynamoTestDatabase();
      await database.ready;
      return createJobLock({ client: database.client, tables: database.tables }, clock);
    },
  ],
];

describe.each(IMPLEMENTATIONS)('ジョブの排他の契約: %s', (_name, create) => {
  async function setup() {
    const clock = createControllableClock(NOW);
    clock.freeze(NOW);
    return { clock, lock: await create(clock) };
  }

  it('ロックを取れる。同じ名前を、続けて取ると、取れない（待たずに null）。別の名前は、独立している', async () => {
    const { lock } = await setup();

    const first = await lock.tryAcquire('job:JB-04', LEASE_MS);
    const second = await lock.tryAcquire('job:JB-04', LEASE_MS);
    const other = await lock.tryAcquire('job:JB-03', LEASE_MS);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(other).not.toBeNull();
  });

  it('解放すると、すぐに取り直せる。解放済みのリースを、もう一度解放しても、エラーにしない', async () => {
    const { lock } = await setup();
    const first = await lock.tryAcquire('job:JB-04', LEASE_MS);

    await first?.release();
    await first?.release();

    expect(await lock.tryAcquire('job:JB-04', LEASE_MS)).not.toBeNull();
  });

  it('期限が過ぎると、解放されていなくても、取れる（実行が異常終了した場合）。期限の前は、取れない', async () => {
    const { lock, clock } = await setup();
    await lock.tryAcquire('job:JB-04', LEASE_MS);

    clock.advance(LEASE_MS - 1);
    expect(await lock.tryAcquire('job:JB-04', LEASE_MS)).toBeNull();

    clock.advance(1);
    expect(await lock.tryAcquire('job:JB-04', LEASE_MS)).not.toBeNull();
  });

  it('期限が過ぎて、別の実行にロックを取られたあと、古い実行が解放しても、新しいロックは、消えない', async () => {
    const { lock, clock } = await setup();
    const stale = await lock.tryAcquire('job:JB-04', LEASE_MS);
    clock.advance(LEASE_MS);
    const current = await lock.tryAcquire('job:JB-04', LEASE_MS);

    await stale?.release();

    expect(current).not.toBeNull();
    expect(await lock.tryAcquire('job:JB-04', LEASE_MS)).toBeNull();
  });

  it('同時に取りに来ても、取れるのは、1 つだけ', async () => {
    const { lock } = await setup();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => lock.tryAcquire('job:JB-04', LEASE_MS)),
    );

    expect(results.filter((lease) => lease !== null)).toHaveLength(1);
  });
});
