import { describe, expect, it, vi } from 'vitest';

// 再送の待ち時間は、実際には待たない（待ち時間を、倍にする再送を、速く検証するため）
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }));

import { AppError } from '../../../../../src/shared/errors.ts';
import {
  batchGetItems,
  batchWriteItems,
  isConditionalCheckFailed,
  isTransactionConditionFailed,
  mapConcurrent,
  queryPages,
  updateItemIf,
  type Database,
} from '../../../../../src/backend/infrastructure/dynamodb/operations.ts';

interface SentCommand {
  readonly input: Record<string, unknown>;
}

/** 返す結果を、順に決める、偽のクライアント（実際の DynamoDB を使わない）。 */
function fakeDatabase(responses: readonly unknown[]): { db: Database; sent: SentCommand[] } {
  const sent: SentCommand[] = [];
  let index = 0;
  const client = {
    send: (command: SentCommand) => {
      sent.push(command);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    },
  };
  return {
    db: {
      client: client as unknown as Database['client'],
      tables: { observations: 'o', main: 'm' },
    },
    sent,
  };
}

function namedError(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(name), { name, ...extra });
}

describe('DynamoDB の操作（エラーの判定）', () => {
  it('条件つきの書き込みの失敗を判定する', () => {
    expect(isConditionalCheckFailed(namedError('ConditionalCheckFailedException'))).toBe(true);
    expect(isConditionalCheckFailed(namedError('ValidationException'))).toBe(false);
    expect(isConditionalCheckFailed('x')).toBe(false);
    expect(isConditionalCheckFailed(null)).toBe(false);
  });

  it('トランザクションの取り消しは、条件を満たさない項目があるときだけ、条件の失敗とする', () => {
    const cancelled = (codes: string[]) =>
      namedError('TransactionCanceledException', {
        CancellationReasons: codes.map((Code) => ({ Code })),
      });

    expect(isTransactionConditionFailed(cancelled(['None', 'ConditionalCheckFailed']))).toBe(true);
    expect(isTransactionConditionFailed(cancelled(['None', 'ThrottlingError']))).toBe(false);
    expect(isTransactionConditionFailed(namedError('TransactionCanceledException'))).toBe(false);
    expect(isTransactionConditionFailed(namedError('ValidationException'))).toBe(false);
  });
});

describe('DynamoDB の操作（条件つきの更新）', () => {
  const input = { key: { pk: 'a', sk: 'b' }, update: 'SET x = :v', condition: 'x < :v' };

  it('条件を満たせば true、満たさなければ false（何もしない）', async () => {
    expect(await updateItemIf(fakeDatabase([{}]).db, 'm', input)).toBe(true);
    expect(
      await updateItemIf(
        fakeDatabase([namedError('ConditionalCheckFailedException')]).db,
        'm',
        input,
      ),
    ).toBe(false);
  });

  it('条件の失敗以外のエラーは、そのまま投げる', async () => {
    await expect(
      updateItemIf(
        fakeDatabase([namedError('ProvisionedThroughputExceededException')]).db,
        'm',
        input,
      ),
    ).rejects.toThrow('ProvisionedThroughputExceededException');
  });
});

describe('DynamoDB の操作（Query）', () => {
  const options = {
    table: 'm',
    hashName: 'pk',
    hashValue: 'p',
    sortName: 'sk',
    forward: true,
    pageSize: 10,
  };

  it('下端が上端より大きければ、読まない（範囲が空。DynamoDB は、このまま送ると、エラーにする）', async () => {
    const { db, sent } = fakeDatabase([{ Items: [{ sk: 'x' }] }]);

    const pages: unknown[] = [];
    for await (const page of queryPages(db, { ...options, lower: 'b', upper: 'a' })) {
      pages.push(page);
    }

    expect(pages).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('続きがあれば、読み続ける。空のページは、返さない', async () => {
    const { db, sent } = fakeDatabase([
      { Items: [{ sk: '1' }], LastEvaluatedKey: { pk: 'p', sk: '1' } },
      { Items: [], LastEvaluatedKey: { pk: 'p', sk: '1' } },
      { Items: [{ sk: '2' }] },
    ]);

    const pages: unknown[] = [];
    for await (const page of queryPages(db, { ...options, lower: 'a' })) {
      pages.push(page);
    }

    expect(pages).toEqual([[{ sk: '1' }], [{ sk: '2' }]]);
    expect(sent).toHaveLength(3);
    expect(sent[1]?.input).toMatchObject({ ExclusiveStartKey: { pk: 'p', sk: '1' } });
  });
});

describe('DynamoDB の操作（まとめての取得・書き込み）', () => {
  it('取得: 100 件ずつに分け、処理されなかったキーは、再び読む', async () => {
    const keys = Array.from({ length: 150 }, (_, index) => ({ pk: 'p', sk: String(index) }));
    const { db, sent } = fakeDatabase([
      { Responses: { m: [{ sk: 'a' }] }, UnprocessedKeys: { m: { Keys: [{ pk: 'p', sk: 'x' }] } } },
      { Responses: { m: [{ sk: 'b' }] } },
      { Responses: { m: [{ sk: 'c' }] } },
    ]);

    const found = await batchGetItems(db, 'm', keys);

    expect(found).toEqual([{ sk: 'a' }, { sk: 'b' }, { sk: 'c' }]);
    expect(sent).toHaveLength(3);
  });

  it('取得: 応答が空（テーブルの項目なし）でも、空を返す', async () => {
    expect(await batchGetItems(fakeDatabase([{}]).db, 'm', [{ pk: 'p', sk: '1' }])).toEqual([]);
  });

  it('取得: 処理されない状態が続けば、上限の回数で、サービス利用不可（SERVICE_UNAVAILABLE）にする', async () => {
    const { db } = fakeDatabase([{ UnprocessedKeys: { m: { Keys: [{ pk: 'p', sk: '1' }] } } }]);

    await expect(batchGetItems(db, 'm', [{ pk: 'p', sk: '1' }])).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('書き込み: 25 件ずつに分け、処理されなかった分は、再び書く', async () => {
    const requests = Array.from({ length: 30 }, (_, index) => ({
      put: { pk: 'p', sk: String(index) },
    }));
    const { db, sent } = fakeDatabase([
      { UnprocessedItems: { m: [{ PutRequest: { Item: { pk: 'p', sk: '0' } } }] } },
      {},
      {},
    ]);

    await batchWriteItems(db, 'm', [...requests, { delete: { pk: 'p', sk: 'gone' } }]);

    // 31 件 → 2 回（25 件・6 件）+ 処理されなかった 1 件の再送
    expect(sent).toHaveLength(3);
  });

  it('書き込み: 処理されない状態が続けば、サービス利用不可（SERVICE_UNAVAILABLE）にする', async () => {
    const { db } = fakeDatabase([
      { UnprocessedItems: { m: [{ PutRequest: { Item: { pk: 'p', sk: '0' } } }] } },
    ]);

    const failure = batchWriteItems(db, 'm', [{ put: { pk: 'p', sk: '0' } }]);

    await expect(failure).rejects.toThrow(AppError);
    await expect(failure).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('並列数を制限した処理', () => {
  it('結果は、入力と同じ順。同時に動かす数は、上限まで', async () => {
    let running = 0;
    let peak = 0;

    const results = await mapConcurrent([1, 2, 3, 4, 5, 6], 2, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      await Promise.resolve();
      running -= 1;
      return value * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
    expect(await mapConcurrent([], 4, (value: number) => Promise.resolve(value))).toEqual([]);
  });
});
