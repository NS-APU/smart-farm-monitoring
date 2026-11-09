/**
 * Web Push の配信の規則（Issue #237。ADR-0019 の D-38）の単体テスト。
 * 配信の状態は、購読ごとに持つ。失敗した購読にだけ、1 分から倍々（最大 60 分）の間隔で再送し、通知を作ってから 1 時間で断念する。
 * Web Push の有効期限（TTL）は、その期限（通知を作ってから 1 時間）までの残りの時間にそろえる。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DELIVERY_EXPIRY_MINUTES,
  DEFAULT_RETRY_BASE_MINUTES,
  DEFAULT_RETRY_MAX_MINUTES,
  isWebPushExpired,
  needsWebPushDelivery,
  summarizeWebPushDeliveries,
  webPushRetryDelayMinutes,
  webPushTtlSeconds,
} from '../../../../src/backend/domain/notification-delivery.ts';

const at = (time: string): string => `2026-10-09T${time}:00.000Z`;
const delivery = (
  result: 'PENDING' | 'SUCCESS' | 'FAILURE' | 'ABANDONED',
  attempts = 0,
  errorMessage?: string,
) => ({
  subscriptionId: `s-${result}-${String(attempts)}`,
  result,
  attempts,
  updatedAt: at('10:00'),
  ...(errorMessage === undefined ? {} : { errorMessage }),
});

describe('既定値', () => {
  it('再送は 1 分から倍々、最大 60 分。通知を作ってから 60 分で断念する', () => {
    expect(DEFAULT_RETRY_BASE_MINUTES).toBe(1);
    expect(DEFAULT_RETRY_MAX_MINUTES).toBe(60);
    expect(DEFAULT_DELIVERY_EXPIRY_MINUTES).toBe(60);
  });
});

describe('再送の間隔（倍々。最大 60 分）', () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 4],
    [4, 8],
    [5, 16],
    [6, 32],
    [7, 60],
    [8, 60],
    [30, 60],
  ])('%i 回失敗したあとの、次の試行までの間隔は、%i 分', (attempts, minutes) => {
    expect(webPushRetryDelayMinutes(attempts, 1, 60)).toBe(minutes);
  });

  it('最初の間隔・最大の間隔を指定できる', () => {
    expect(webPushRetryDelayMinutes(3, 2, 10)).toBe(8);
    expect(webPushRetryDelayMinutes(4, 2, 10)).toBe(10);
  });
});

describe('断念の期限（通知を作ってから 60 分）', () => {
  it('作成から 60 分未満は、期限内。60 分ちょうどから、期限切れ（境界）', () => {
    const now = (time: string) => new Date(at(time));

    expect(isWebPushExpired(at('10:00'), now('10:59'), 60)).toBe(false);
    expect(isWebPushExpired(at('10:00'), now('11:00'), 60)).toBe(true);
    expect(isWebPushExpired(at('10:00'), now('12:00'), 60)).toBe(true);
  });
});

describe('Web Push の有効期限（TTL）は、期限までの残りの秒数', () => {
  it('作成の直後は 3600 秒。再送が遅れるほど、短くなる', () => {
    expect(webPushTtlSeconds(at('10:00'), new Date(at('10:00')), 60)).toBe(3600);
    expect(webPushTtlSeconds(at('10:00'), new Date(at('10:10')), 60)).toBe(3000);
    expect(webPushTtlSeconds(at('10:00'), new Date(at('10:59')), 60)).toBe(60);
  });

  it('端数は切り捨てる。期限を過ぎていても、1 秒以上にする（0 以下にしない）', () => {
    expect(webPushTtlSeconds(at('10:00'), new Date('2026-10-09T10:59:59.500Z'), 60)).toBe(1);
    expect(webPushTtlSeconds(at('10:00'), new Date(at('12:00')), 60)).toBe(1);
  });
});

describe('通知の Web Push の、まとめの状態', () => {
  it('配信する相手がなければ、成功（完了）。試行は 0', () => {
    expect(summarizeWebPushDeliveries([])).toEqual({ result: 'SUCCESS', attempts: 0 });
  });

  it('すべて成功なら、成功。試行は、購読ごとの合計', () => {
    expect(summarizeWebPushDeliveries([delivery('SUCCESS', 1), delivery('SUCCESS', 2)])).toEqual({
      result: 'SUCCESS',
      attempts: 3,
    });
  });

  it('未試行（PENDING）か、再送待ち（FAILURE）が 1 つでもあれば、未完了（PENDING）。直近の失敗の内容を残す', () => {
    expect(summarizeWebPushDeliveries([delivery('SUCCESS', 1), delivery('PENDING')])).toEqual({
      result: 'PENDING',
      attempts: 1,
    });
    expect(
      summarizeWebPushDeliveries([
        delivery('SUCCESS', 1),
        delivery('FAILURE', 2, '配信サービスに接続できません'),
      ]),
    ).toEqual({ result: 'PENDING', attempts: 3, errorMessage: '配信サービスに接続できません' });
  });

  it('未完了がなく、断念（ABANDONED）があれば、失敗（終了）', () => {
    expect(
      summarizeWebPushDeliveries([
        delivery('SUCCESS', 1),
        delivery('ABANDONED', 7, '期限を過ぎたため、断念しました'),
      ]),
    ).toEqual({ result: 'FAILURE', attempts: 8, errorMessage: '期限を過ぎたため、断念しました' });
  });
});

describe('配信が必要な通知（配信が未完了の通知を引く索引・一覧の条件）', () => {
  const withWebPush = (
    result: 'PENDING' | 'SUCCESS' | 'FAILURE',
    webPushDeliveries?: ReturnType<typeof delivery>[],
  ) => ({
    deliveries: [{ channel: 'WEB_PUSH' as const, result, attempts: 0, updatedAt: at('10:00') }],
    ...(webPushDeliveries === undefined ? {} : { webPushDeliveries }),
  });

  it('Web Push が未完了（PENDING）の通知は、必要', () => {
    expect(needsWebPushDelivery(withWebPush('PENDING'))).toBe(true);
    expect(needsWebPushDelivery(withWebPush('PENDING', []))).toBe(true);
  });

  it('成功、または、断念して終了した失敗（購読ごとの状態がある）は、不要', () => {
    expect(needsWebPushDelivery(withWebPush('SUCCESS'))).toBe(false);
    expect(needsWebPushDelivery(withWebPush('FAILURE', [delivery('ABANDONED', 7)]))).toBe(false);
  });

  it('購読ごとの状態がない、以前の形式の失敗（FAILURE）は、必要（購読ごとの形式で、終了させる）', () => {
    expect(needsWebPushDelivery(withWebPush('FAILURE'))).toBe(true);
  });

  it('Web Push の配信の記録がない通知（取り込みの通知などで、配信を持たない）は、不要', () => {
    expect(needsWebPushDelivery({ deliveries: [] })).toBe(false);
  });
});
