/**
 * ログ類の保存期間（90 日。ADR-0018 の D-30。Issue #230）のテスト。
 * 共通の期限の計算と、ローカル実装での期限切れの扱い（DynamoDB の TTL による自動削除にそろえる）を確かめる。
 */

import { describe, expect, it } from 'vitest';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import type { FederationItem } from '@smart-farm/shared/schemas/ingestion';
import type { Repositories } from '../../../../src/backend/application/ports/repositories.ts';
import {
  isLogExpired,
  LOG_RETENTION_DAYS,
  logTtlSeconds,
} from '../../../../src/backend/infrastructure/common/log-retention.ts';
import {
  createControllableClock,
  type ControllableClock,
} from '../../../../src/backend/infrastructure/local/clocks.ts';
import { createLocalRepositories } from '../../../../src/backend/infrastructure/local/local-repositories.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOGGED_AT = '2026-10-09T01:00:00.000Z';
const loggedAtMs = Date.parse(LOGGED_AT);

describe('期限の計算', () => {
  it('保存期間は 90 日', () => {
    expect(LOG_RETENTION_DAYS).toBe(90);
  });

  it('TTL の値は、日時の 90 日後（エポック秒）。ミリ秒の端数は、切り上げる', () => {
    expect(logTtlSeconds('2026-10-09T01:00:00.000Z')).toBe(loggedAtMs / 1000 + 90 * 86_400);
    expect(logTtlSeconds('2026-10-09T01:00:00.001Z')).toBe(loggedAtMs / 1000 + 90 * 86_400 + 1);
    // ミリ秒のない形式も、同じ時刻なら同じ値
    expect(logTtlSeconds('2026-10-09T01:00:00Z')).toBe(logTtlSeconds('2026-10-09T01:00:00.000Z'));
  });

  it('期限（日時の 90 日後）の時刻から、期限切れとみなす。それより前は、期限切れではない', () => {
    expect(isLogExpired(LOGGED_AT, new Date(loggedAtMs + 90 * DAY_MS - 1))).toBe(false);
    expect(isLogExpired(LOGGED_AT, new Date(loggedAtMs + 90 * DAY_MS))).toBe(true);
  });
});

describe('ローカル実装の期限切れ（時計を渡したとき）', () => {
  function setup(): { clock: ControllableClock; repositories: Repositories } {
    const clock = createControllableClock(new Date(LOGGED_AT));
    clock.freeze();
    return { clock, repositories: createLocalRepositories({ clock }).repositories };
  }

  const ingestionLog = (logId: string, startedAt: string) => ({
    logId,
    sourceId: 'robot',
    startedAt,
    finishedAt: startedAt,
    result: 'SUCCESS' as const,
    filesProcessed: 1,
    recordCount: 1,
    rejectedCount: 0,
    attempts: 1,
    equipmentId: toEquipmentId('ROBOT-T1'),
    facilities: [{ facilityId: 'HOUSE-T1', result: 'SUCCESS' as const, recordCount: 1 }],
  });
  const federationLog = (logId: string, occurredAt: string) => ({
    logId,
    occurredAt,
    result: 'SENT' as const,
    itemCount: 1,
    facilities: [{ facilityId: 'HOUSE-T1', itemCount: 1 }],
  });
  const federationItem = (
    id: string,
    status: FederationItem['status'],
    updatedAt: string,
  ): FederationItem => ({
    federationItemId: id,
    targetType: 'EVALUATION',
    targetRef: id,
    payload: {},
    status,
    attempts: 0,
    enqueuedAt: updatedAt,
    updatedAt,
    nextAttemptAt: updatedAt,
  });

  it('取り込みログ（設備ごと・ハウス別の内訳を含む）は、90 日後から、一覧に出ない', async () => {
    const { clock, repositories } = setup();
    await repositories.ingestion.addLog(ingestionLog('l-1', LOGGED_AT));

    clock.set(new Date(loggedAtMs + 90 * DAY_MS - 1));
    expect((await repositories.ingestion.listLogs({}, { limit: 10 })).items).toHaveLength(1);
    expect(
      (await repositories.ingestion.listFacilityLogs(['HOUSE-T1'], { limit: 10 })).items,
    ).toHaveLength(1);

    clock.set(new Date(loggedAtMs + 90 * DAY_MS));
    expect((await repositories.ingestion.listLogs({}, { limit: 10 })).items).toEqual([]);
    expect(
      (await repositories.ingestion.listFacilityLogs(['HOUSE-T1'], { limit: 10 })).items,
    ).toEqual([]);
  });

  it('連携ログ（ハウス別の内訳を含む）は、90 日後から、一覧に出ない', async () => {
    const { clock, repositories } = setup();
    await repositories.federation.addLog(federationLog('f-1', LOGGED_AT));

    clock.set(new Date(loggedAtMs + 90 * DAY_MS - 1));
    expect((await repositories.federation.listLogs({ limit: 10 })).items).toHaveLength(1);

    clock.set(new Date(loggedAtMs + 90 * DAY_MS));
    expect((await repositories.federation.listLogs({ limit: 10 })).items).toEqual([]);
    expect(
      (await repositories.federation.listFacilityLogs(['HOUSE-T1'], { limit: 10 })).items,
    ).toEqual([]);
  });

  it('送信済みの連携項目は、送信済みになった時点（更新日時）の 90 日後に消える。送信済みの件数は、消えた分を含む累計のまま', async () => {
    const { clock, repositories } = setup();
    await repositories.federation.enqueue(federationItem('sent', 'SENT', LOGGED_AT));
    await repositories.federation.enqueue(federationItem('failed', 'FAILED', LOGGED_AT));
    await repositories.federation.enqueue(federationItem('held', 'HELD', LOGGED_AT));

    clock.set(new Date(loggedAtMs + 90 * DAY_MS));
    const counts = await repositories.federation.countByStatus();

    expect(counts).toEqual({ PENDING: 0, SENT: 1, FAILED: 1, HELD: 1, EXPIRED: 0 });
    // 送信していない項目は、期限で消えない（再送のために残す）
    const due = await repositories.federation.listDue(new Date(loggedAtMs + 90 * DAY_MS), 10);
    expect(due.map((item) => item.federationItemId).sort()).toEqual(['failed', 'held']);
  });

  it('送信済みの件数は、消えたあとも増え続ける（消えた分と、新しく送った分の合計）', async () => {
    const { clock, repositories } = setup();
    await repositories.federation.enqueue(federationItem('a', 'SENT', LOGGED_AT));
    clock.set(new Date(loggedAtMs + 91 * DAY_MS));
    await repositories.federation.enqueue(
      federationItem('b', 'SENT', new Date(loggedAtMs + 91 * DAY_MS).toISOString()),
    );

    expect((await repositories.federation.countByStatus()).SENT).toBe(2);

    // 時間が進んでも、数は変わらない
    clock.set(new Date(loggedAtMs + 92 * DAY_MS));
    expect((await repositories.federation.countByStatus()).SENT).toBe(2);
  });

  it('時計を渡さないときは、期限で消さない（テストで、固定の日付のデータを使えるように）', async () => {
    const { repositories } = createLocalRepositories();
    await repositories.ingestion.addLog(ingestionLog('l-1', '2000-01-01T00:00:00.000Z'));

    expect((await repositories.ingestion.listLogs({}, { limit: 10 })).items).toHaveLength(1);
  });
});
