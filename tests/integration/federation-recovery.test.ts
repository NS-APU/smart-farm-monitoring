/**
 * 農業情報基盤の復旧後の連携（#195 の #203。ADR-0016 の D-06）の結合テスト。
 * 送信に成功したら、溜まった保留・失敗の項目の次の試行を、すぐ（今）に戻す（1 回の成功につき、最大でバッチの件数）。
 */

import { describe, expect, it } from 'vitest';
import { createFederationService } from '../../src/backend/application/federation/federation-service.ts';
import { FederationUnavailableError } from '../../src/backend/application/ports/federation-port.ts';
import { NULL_LOGGER } from '../../src/backend/application/ports/logger-port.ts';
import { DEFAULT_APP_SETTINGS } from '../../src/backend/application/settings.ts';
import { createControllableClock } from '../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../src/backend/infrastructure/local/ids.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import { TEST_NOW } from '../support/test-context.ts';

const MINUTE_MS = 60_000;

function setup(overrides: { batchSize?: number } = {}) {
  const { repositories } = createLocalRepositories();
  const clock = createControllableClock(TEST_NOW);
  let down = false;
  const sent: string[] = [];
  const service = createFederationService({
    federation: repositories.federation,
    equipment: repositories.equipment,
    notifications: { notifyFederationExpired: () => Promise.resolve(null) },
    port: {
      send: (items) => {
        if (down) {
          return Promise.reject(new FederationUnavailableError('停止中'));
        }
        sent.push(...items.map((item) => item.targetRef));
        return Promise.resolve();
      },
    },
    clock,
    ids: createSequentialIdGenerator(),
    settings: { ...DEFAULT_APP_SETTINGS.federation, ...overrides },
    logger: NULL_LOGGER,
  });
  return {
    repositories,
    clock,
    service,
    sent,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

async function enqueue(service: ReturnType<typeof setup>['service'], refs: readonly string[]) {
  for (const targetRef of refs) {
    await service.enqueue({ targetType: 'OBSERVATION', targetRef, payload: {} });
  }
}

describe('送信に成功したら、溜まった項目を、すぐ送る（#203）', () => {
  it('停止の間に保留になった項目は、復旧後の最初の成功の直後の実行で、再試行の間隔を待たずに送る', async () => {
    const { clock, service, sent, setDown } = setup();
    await enqueue(service, ['a', 'b']);
    setDown(true);
    await service.runPending();
    setDown(false);
    // 2 分後に積んだ項目は、すぐ送れる。a・b は、次の試行まで 5 分あるため、待たなければ送れない
    clock.advance(2 * MINUTE_MS);
    await enqueue(service, ['c']);

    const first = await service.runPending();
    const second = await service.runPending();

    expect(first).toEqual({ sent: 1, failed: 0, held: 0, expired: 0 });
    expect(second).toEqual({ sent: 2, failed: 0, held: 0, expired: 0 });
    expect(sent).toEqual(['c', 'a', 'b']);
  });

  it('戻す件数は、1 回の成功につき、バッチの件数まで（古い順）。残りは、次の成功で戻す', async () => {
    const { clock, service, sent, setDown } = setup({ batchSize: 2 });
    await enqueue(service, ['a', 'b', 'c', 'd', 'e']);
    // 停止の間に、3 回の実行で、a〜e のすべてが保留になる（バッチは 2 件）
    setDown(true);
    await service.runPending();
    await service.runPending();
    await service.runPending();
    setDown(false);
    clock.advance(1 * MINUTE_MS);
    await enqueue(service, ['f']);

    // 1 回目: 新しい f だけが、送れる（a・b・c・d・e は、次の試行の日時が先）→ 成功の後に、古い a・b を戻す
    await service.runPending();
    // 2 回目: a・b → c・d を戻す。3 回目: c・d → e を戻す。4 回目: e
    await service.runPending();
    await service.runPending();
    await service.runPending();

    expect(sent).toEqual(['f', 'a', 'b', 'c', 'd', 'e']);
  });

  it('送信に失敗した実行では、溜まった項目を戻さない（停止の間は、間隔を広げて再試行する）', async () => {
    const { repositories, clock, service, setDown } = setup();
    await enqueue(service, ['a']);
    setDown(true);
    await service.runPending();
    await enqueue(service, ['b']);
    const before = await repositories.federation.listWaiting(clock.now(), 10);

    await service.runPending();

    const after = await repositories.federation.listWaiting(clock.now(), 10);
    expect(after.find((item) => item.targetRef === 'a')?.nextAttemptAt).toBe(
      before[0]?.nextAttemptAt,
    );
    expect(after.map((item) => item.status)).toEqual(['HELD', 'HELD']);
  });

  it('戻した項目の試行の回数は、変えない（再試行の間隔の計算を保つ）', async () => {
    const { repositories, clock, service, setDown } = setup();
    await enqueue(service, ['a']);
    setDown(true);
    await service.runPending();
    setDown(false);
    clock.advance(1 * MINUTE_MS);
    await enqueue(service, ['b']);

    await service.runPending();

    const due = await repositories.federation.listDue(clock.now(), 10);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ targetRef: 'a', status: 'HELD', attempts: 1 });
    expect(due[0]?.nextAttemptAt).toBe(clock.now().toISOString());
  });
});
