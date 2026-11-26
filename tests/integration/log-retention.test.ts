/**
 * ログ類の保存期間（90 日。ADR-0018 の D-30。Issue #230）の、アプリの組み立て（ローカルの保存先）での確認。
 * 取り込みログ・連携ログは、組み立ての時計で 90 日が過ぎると、画面の一覧（API）に出ない。
 */

import { describe, expect, it } from 'vitest';
import { createTestContext } from '../support/test-context.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('ログ類の保存期間（組み立て）', () => {
  it('取り込みログ・連携ログは、90 日が過ぎると、API の一覧に出ない', async () => {
    const context = await createTestContext();
    const { ingestion, federation } = context.container.repositories;
    const at = context.clock.now().toISOString();
    await ingestion.addLog({
      logId: 'i-1',
      sourceId: 'robot',
      startedAt: at,
      finishedAt: at,
      result: 'SUCCESS',
      filesProcessed: 1,
      recordCount: 1,
      rejectedCount: 0,
      attempts: 1,
    });
    await federation.addLog({ logId: 'f-1', occurredAt: at, result: 'SENT', itemCount: 1 });
    const count = async (path: string): Promise<number> =>
      ((await (await context.request(path)).json()) as { items: unknown[] }).items.length;

    context.clock.advance(90 * DAY_MS - 60_000);
    expect(await count('/ingestion/logs')).toBe(1);
    expect(await count('/federation/logs')).toBe(1);

    context.clock.advance(2 * 60_000);
    expect(await count('/ingestion/logs')).toBe(0);
    expect(await count('/federation/logs')).toBe(0);
  });
});
