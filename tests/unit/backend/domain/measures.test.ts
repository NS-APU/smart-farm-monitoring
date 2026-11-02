import { describe, expect, it } from 'vitest';
import {
  aggregateMeasures,
  type AggregationInput,
} from '../../../../src/backend/domain/evaluation/measures.ts';
import { toUserId } from '../../../../src/shared/schemas/common.ts';
import { FACILITY_ID, observation, SENSOR_ID, statusCodeMap } from '../../../support/builders.ts';

const NOW = new Date('2026-10-09T03:00:00Z');
const DAY_MS = 86_400_000;

function input(
  overrides: Partial<AggregationInput> & Pick<AggregationInput, 'observations'>,
): AggregationInput {
  return {
    horizon: 'LONG',
    from: new Date(NOW.getTime() - 7 * DAY_MS),
    to: NOW,
    statusCodes: statusCodeMap(),
    expectedStreams: { robot: true, sensor: true },
    coverageSlotMinutes: 15,
    ...overrides,
  };
}

describe('観測値の集計: 使う観測値', () => {
  it('論理削除・欠損・不正の観測値は使わず、遅延の観測値は使う', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          observation({ itemKey: 'harvestCount', value: 10, observedAt: '2026-10-09T01:00:00Z' }),
          observation({
            itemKey: 'harvestCount',
            value: 100,
            observedAt: '2026-10-09T01:15:00Z',
            isDeleted: true,
          }),
          observation({
            itemKey: 'harvestCount',
            value: null,
            observedAt: '2026-10-09T01:30:00Z',
            quality: 'MISSING',
          }),
          observation({
            itemKey: 'harvestCount',
            value: 1000,
            observedAt: '2026-10-09T01:45:00Z',
            quality: 'INVALID',
          }),
          observation({
            itemKey: 'harvestCount',
            value: 5,
            observedAt: '2026-10-09T02:00:00Z',
            quality: 'LATE',
          }),
        ],
      }),
    );

    expect(measures.values.harvestCount).toBe(15);
  });

  it('期間の外の観測値と、評価時刻より後に受信した観測値は使わない', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          observation({ itemKey: 'harvestCount', value: 1, observedAt: '2026-10-01T00:00:00Z' }),
          observation({ itemKey: 'harvestCount', value: 2, observedAt: '2026-10-09T04:00:00Z' }),
          observation({
            itemKey: 'harvestCount',
            value: 4,
            observedAt: '2026-10-09T02:00:00Z',
            receivedAt: '2026-10-09T05:00:00Z',
          }),
          observation({ itemKey: 'harvestCount', value: 8, observedAt: '2026-10-09T02:30:00Z' }),
        ],
      }),
    );

    expect(measures.values.harvestCount).toBe(8);
  });

  it('カタログにない項目は使わない', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          { ...observation({ itemKey: 'harvestCount', value: 1 }), itemKey: 'unknownItem' },
        ],
      }),
    );

    expect(measures.values).toEqual({
      robotDataCount: 1,
      sensorDataCount: 0,
      manualDataCount: 0,
      totalDataCount: expect.any(Number),
    });
  });

  it('観測値がなければ、項目は未取得（キーなし）で、0 にしない', () => {
    const measures = aggregateMeasures(input({ observations: [] }));

    expect(measures.values).toEqual({});
    expect(measures.status).toBeNull();
  });
});

describe('観測値の集計: 集計の種類', () => {
  it('合計の項目は、期間内の合計にする（短期・長期とも）', () => {
    const observations = [
      observation({ itemKey: 'operatingHours', value: 0.25, observedAt: '2026-10-09T01:00:00Z' }),
      observation({ itemKey: 'operatingHours', value: 0.5, observedAt: '2026-10-09T02:00:00Z' }),
    ];

    const short = aggregateMeasures(
      input({ observations, horizon: 'SHORT', from: new Date('2026-10-08T03:00:00Z') }),
    );
    const long = aggregateMeasures(input({ observations }));

    expect(short.values.operatingHours).toBe(0.75);
    expect(long.values.operatingHours).toBe(0.75);
  });

  it('状態値の項目は、短期は最新値、長期は平均にする', () => {
    const observations = [
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 20,
        observedAt: '2026-10-09T01:00:00Z',
      }),
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 30,
        observedAt: '2026-10-09T02:00:00Z',
      }),
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 22,
        observedAt: '2026-10-09T00:30:00Z',
      }),
    ];

    const short = aggregateMeasures(
      input({ observations, horizon: 'SHORT', from: new Date('2026-10-08T03:00:00Z') }),
    );
    const long = aggregateMeasures(input({ observations }));

    expect(short.values.temperatureCelsius).toBe(30);
    expect(long.values.temperatureCelsius).toBe(24);
  });

  it('ステータスコードは、短期は最新、長期は期間内で最も悪いカテゴリにする', () => {
    const observations = [
      observation({ itemKey: 'statusCode', value: 'FALLEN', observedAt: '2026-10-09T01:00:00Z' }),
      observation({ itemKey: 'statusCode', value: 'RUNNING', observedAt: '2026-10-09T02:00:00Z' }),
      observation({ itemKey: 'statusCode', value: 'STOPPED', observedAt: '2026-10-09T02:30:00Z' }),
    ];

    const short = aggregateMeasures(
      input({ observations, horizon: 'SHORT', from: new Date('2026-10-08T03:00:00Z') }),
    );
    const long = aggregateMeasures(input({ observations }));

    expect(short.status).toEqual({ code: 'STOPPED', name: '停止中', category: 'CAUTION' });
    expect(long.status).toEqual({ code: 'FALLEN', name: '転倒（姿勢異常）', category: 'ERROR' });
  });

  it('定義にない・削除済みのステータスコードは、ステータスとして使わない', () => {
    const codes = statusCodeMap();
    const running = codes.get('RUNNING');
    if (running === undefined) {
      throw new Error('テストの前提: RUNNING が定義されている');
    }
    codes.set('RUNNING', { ...running, isDeleted: true });

    const measures = aggregateMeasures(
      input({
        statusCodes: codes,
        observations: [
          observation({
            itemKey: 'statusCode',
            value: 'RUNNING',
            observedAt: '2026-10-09T01:00:00Z',
          }),
          observation({
            itemKey: 'statusCode',
            value: 'NOT_DEFINED',
            observedAt: '2026-10-09T02:00:00Z',
          }),
        ],
      }),
    );

    expect(measures.status).toBeNull();
  });
});

describe('観測値の集計: 満足度（入力者ごとの最新の平均。1 人 1 票。D-18）', () => {
  const KEY = 'satisfaction.safety';
  const A = toUserId('worker-a');
  const B = toUserId('worker-b');

  function rating(
    value: number,
    observedAt: string,
    enteredBy?: ReturnType<typeof toUserId>,
    itemKey = KEY,
  ) {
    return observation({
      equipmentId: FACILITY_ID,
      itemKey,
      value,
      observedAt,
      source: 'MANUAL',
      ...(enteredBy === undefined ? {} : { enteredBy }),
    });
  }

  it('同じ入力者が、期間内に複数回入力したときは、最新の入力だけを使う', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          rating(5, '2026-10-09T01:00:00Z', A),
          rating(1, '2026-10-09T02:00:00Z', A),
          rating(4, '2026-10-08T12:00:00Z', A),
        ],
      }),
    );

    expect(measures.values[KEY]).toBe(1);
  });

  it('入力者が複数のときは、各入力者の最新の値の平均にする（入力の回数が多い人の意見が重くならない）', () => {
    // A は 5 を 3 回、B は 1 を 1 回。全入力の平均（3.8）ではなく、1 人 1 票の平均（3）
    const measures = aggregateMeasures(
      input({
        observations: [
          rating(5, '2026-10-07T01:00:00Z', A),
          rating(5, '2026-10-08T01:00:00Z', A),
          rating(5, '2026-10-09T01:00:00Z', A),
          rating(1, '2026-10-09T02:00:00Z', B),
        ],
      }),
    );

    expect(measures.values[KEY]).toBe(3);
  });

  it('期間内に入力のない人は含めない（期間の外の入力は、その人の票にしない）', () => {
    const measures = aggregateMeasures(
      input({
        observations: [rating(5, '2026-10-09T01:00:00Z', A), rating(1, '2026-10-01T01:00:00Z', B)],
      }),
    );

    expect(measures.values[KEY]).toBe(5);
  });

  it('論理削除した入力は使わず、その人の、削除されていない最新の入力に戻る', () => {
    const deleted = observation({
      equipmentId: FACILITY_ID,
      itemKey: KEY,
      value: 1,
      observedAt: '2026-10-09T02:00:00Z',
      source: 'MANUAL',
      enteredBy: A,
      isDeleted: true,
    });

    const measures = aggregateMeasures(
      input({ observations: [rating(4, '2026-10-09T01:00:00Z', A), deleted] }),
    );

    expect(measures.values[KEY]).toBe(4);
  });

  it('観点ごとに、入力者の最新の入力を選ぶ（観点によって、最新の入力の日時が違ってもよい）', () => {
    const other = 'satisfaction.durability';
    const measures = aggregateMeasures(
      input({
        observations: [
          rating(2, '2026-10-08T01:00:00Z', A),
          rating(4, '2026-10-09T01:00:00Z', A),
          rating(5, '2026-10-08T01:00:00Z', A, other),
          rating(3, '2026-10-09T01:00:00Z', B, other),
        ],
      }),
    );

    expect(measures.values[KEY]).toBe(4);
    expect(measures.values[other]).toBe(4);
  });

  it('入力者が分からない入力（入力者の記録がない）は、1 人の入力として扱い、その最新を使う', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          rating(5, '2026-10-09T00:00:00Z'),
          rating(3, '2026-10-09T01:00:00Z'),
          rating(1, '2026-10-09T02:00:00Z', A),
        ],
      }),
    );

    // 入力者不明の最新 3 と、A の 1 → 平均 2
    expect(measures.values[KEY]).toBe(2);
  });

  it('同じ入力者の同じ日時の入力が複数あるときは、後のものを使う。平均は、小数第 6 位に丸める', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          rating(2, '2026-10-09T01:00:00Z', A),
          rating(4, '2026-10-09T01:00:00Z', A),
          rating(5, '2026-10-09T01:00:00Z', B),
          rating(5, '2026-10-09T01:00:00Z', toUserId('worker-c')),
        ],
      }),
    );

    expect(measures.values[KEY]).toBe(4.666667);
  });

  it('短期視点でも、同じ規則（入力者ごとの最新の平均）にする', () => {
    const measures = aggregateMeasures(
      input({
        horizon: 'SHORT',
        from: new Date('2026-10-08T03:00:00Z'),
        observations: [
          rating(5, '2026-10-09T01:00:00Z', A),
          rating(1, '2026-10-09T02:00:00Z', A),
          rating(3, '2026-10-09T02:00:00Z', B),
        ],
      }),
    );

    expect(measures.values[KEY]).toBe(2);
  });

  it('満足度以外の状態値は、従来どおり、入力者に関わらず、長期は全入力の平均にする', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          observation({
            itemKey: 'robotCostYenPerHour',
            value: 100,
            observedAt: '2026-10-09T01:00:00Z',
            source: 'MANUAL',
            enteredBy: A,
          }),
          observation({
            itemKey: 'robotCostYenPerHour',
            value: 200,
            observedAt: '2026-10-09T02:00:00Z',
            source: 'MANUAL',
            enteredBy: A,
          }),
        ],
      }),
    );

    expect(measures.values.robotCostYenPerHour).toBe(150);
  });
});

describe('観測値の集計: 手動入力と自動取り込みの重なり', () => {
  it('同じ設備・項目・計測日時では、手動入力を使い、自動取り込みの値は二重に数えない', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          observation({
            itemKey: 'harvestCount',
            value: 10,
            source: 'AUTO_IMPORT',
            observedAt: '2026-10-09T02:00:00Z',
          }),
          observation({
            itemKey: 'harvestCount',
            value: 12,
            source: 'MANUAL',
            observedAt: '2026-10-09T02:00:00Z',
          }),
          observation({
            itemKey: 'harvestCount',
            value: 5,
            source: 'AUTO_IMPORT',
            observedAt: '2026-10-09T02:15:00Z',
          }),
        ],
      }),
    );

    expect(measures.values.harvestCount).toBe(17);
  });

  it('計測日時が異なれば、手動入力と自動取り込みの両方を使う', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          observation({
            itemKey: 'harvestCount',
            value: 10,
            source: 'AUTO_IMPORT',
            observedAt: '2026-10-09T02:00:00Z',
          }),
          observation({
            itemKey: 'harvestCount',
            value: 12,
            source: 'MANUAL',
            observedAt: '2026-10-09T02:01:00Z',
          }),
        ],
      }),
    );

    expect(measures.values.harvestCount).toBe(22);
  });
});

describe('観測値の集計: データ活用度合いの入力', () => {
  const FROM = new Date(NOW.getTime() - DAY_MS);

  it('データの入口ごとに、値があった間隔の数と、期待される数を数える', () => {
    // 期間: 最初の観測（00:00）から評価時刻（03:00）までの3時間 = 12間隔（15分）。手動入力は1日 = 1間隔
    const measures = aggregateMeasures(
      input({
        from: FROM,
        observations: [
          observation({ itemKey: 'harvestCount', value: 1, observedAt: '2026-10-09T00:00:00Z' }),
          observation({ itemKey: 'harvestCount', value: 1, observedAt: '2026-10-09T00:05:00Z' }),
          observation({ itemKey: 'operatingHours', value: 1, observedAt: '2026-10-09T01:00:00Z' }),
          observation({
            equipmentId: SENSOR_ID,
            itemKey: 'temperatureCelsius',
            value: 20,
            observedAt: '2026-10-09T00:00:00Z',
          }),
          observation({
            itemKey: 'failureCount',
            value: 0,
            source: 'MANUAL',
            observedAt: '2026-10-09T02:00:00Z',
          }),
        ],
      }),
    );

    expect(measures.values).toMatchObject({
      robotDataCount: 2,
      sensorDataCount: 1,
      manualDataCount: 1,
      totalDataCount: 12 + 12 + 1,
    });
  });

  it('データの入口が登録されていない種別は、期待される数に含めない', () => {
    const measures = aggregateMeasures(
      input({
        from: FROM,
        expectedStreams: { robot: true, sensor: false },
        observations: [
          observation({ itemKey: 'harvestCount', value: 1, observedAt: '2026-10-09T00:00:00Z' }),
          observation({
            equipmentId: SENSOR_ID,
            itemKey: 'temperatureCelsius',
            value: 20,
            observedAt: '2026-10-09T00:00:00Z',
          }),
        ],
      }),
    );

    expect(measures.values).toMatchObject({
      robotDataCount: 1,
      sensorDataCount: 0,
      totalDataCount: 12 + 1,
    });
  });

  it('期間の開始は、最初の観測値の日時にする（取得が始まる前の期間は数えない）', () => {
    const measures = aggregateMeasures(
      input({
        from: new Date(NOW.getTime() - 90 * DAY_MS),
        expectedStreams: { robot: true, sensor: false },
        observations: [
          observation({ itemKey: 'harvestCount', value: 1, observedAt: '2026-10-09T02:00:00Z' }),
        ],
      }),
    );

    expect(measures.values.totalDataCount).toBe(4 + 1);
  });

  it('評価時刻ちょうどの観測値も、最後の間隔として数える', () => {
    const measures = aggregateMeasures(
      input({
        from: FROM,
        expectedStreams: { robot: true, sensor: false },
        observations: [
          observation({ itemKey: 'harvestCount', value: 1, observedAt: '2026-10-09T00:00:00Z' }),
          observation({ itemKey: 'harvestCount', value: 1, observedAt: '2026-10-09T03:00:00Z' }),
        ],
      }),
    );

    expect(measures.values.robotDataCount).toBe(2);
  });

  it('短期視点では、データ活用度合いの入力を作らない', () => {
    const measures = aggregateMeasures(
      input({
        horizon: 'SHORT',
        from: FROM,
        observations: [
          observation({ itemKey: 'harvestCount', value: 1, observedAt: '2026-10-09T02:00:00Z' }),
        ],
      }),
    );

    expect(measures.values).not.toHaveProperty('totalDataCount');
  });

  it('観測値が1件もなければ、データ活用度合いの入力を作らない（不明）', () => {
    const measures = aggregateMeasures(input({ observations: [] }));

    expect(measures.values).not.toHaveProperty('totalDataCount');
  });
});

describe('観測値の集計: 大量のステータスコード（Issue #266）', () => {
  // ロボットが 1 分間隔で、24 時間連続のデータが 90 日分（129,600 件）。引数の展開の上限（Node で約 12.4 万件）を超える
  const MINUTE_MS = 60_000;
  const COUNT = 90 * 24 * 60;
  const FROM = new Date(NOW.getTime() - 90 * DAY_MS);

  function statusPoints(codeAt: (index: number) => string) {
    return Array.from({ length: COUNT }, (_, index) =>
      observation({
        itemKey: 'statusCode',
        value: codeAt(index),
        observedAt: new Date(FROM.getTime() + index * MINUTE_MS).toISOString(),
      }),
    );
  }

  it('ステータスコードの点が 12 万件を超えても、長期評価が失敗せず、最も悪いカテゴリになる', () => {
    const observations = statusPoints((index) => (index === 1000 ? 'FALLEN' : 'RUNNING'));

    const measures = aggregateMeasures(input({ observations, from: FROM }));

    expect(observations.length).toBeGreaterThan(124_000);
    expect(measures.status).toEqual({
      code: 'FALLEN',
      name: '転倒（姿勢異常）',
      category: 'ERROR',
    });
  });

  it('最も悪いカテゴリの点が複数あるときは、その中で最新の点を選ぶ（少ない件数のときと同じ）', () => {
    // 停止中（注意）→ バッテリー不足（注意）。どちらも、最も悪いカテゴリ。最新は、バッテリー不足
    const observations = statusPoints((index) => {
      if (index === 1000) {
        return 'STOPPED';
      }
      return index === 5000 ? 'LOW_BATTERY' : 'RUNNING';
    });

    const measures = aggregateMeasures(input({ observations, from: FROM }));

    expect(measures.status).toEqual({
      code: 'LOW_BATTERY',
      name: 'バッテリー不足',
      category: 'CAUTION',
    });
  });
});
