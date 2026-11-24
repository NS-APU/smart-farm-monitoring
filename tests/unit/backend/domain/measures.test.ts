import { describe, expect, it } from 'vitest';
import {
  aggregateMeasures,
  type AggregationInput,
} from '../../../../src/backend/domain/evaluation/measures.ts';
import { toEquipmentId, toUserId } from '../../../../src/shared/schemas/common.ts';
import {
  FACILITY_ID,
  ROBOT_ID,
  observation,
  SENSOR_ID,
  statusCodeMap,
  type ObservationOverrides,
} from '../../../support/builders.ts';

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

describe('観測値の集計: 数値でない値（ステータスコードの文字列）が、数値の項目に入っているとき', () => {
  it('数値の項目（収穫数）に、文字列の値だけがあれば、集計しない。数値の値があれば、数値だけを使う', () => {
    const onlyText = aggregateMeasures(
      input({
        observations: [
          observation({
            itemKey: 'harvestCount',
            value: 'RUNNING',
            observedAt: '2026-10-09T01:00:00Z',
          }),
        ],
      }),
    );
    const mixed = aggregateMeasures(
      input({
        observations: [
          observation({
            itemKey: 'harvestCount',
            value: 'RUNNING',
            observedAt: '2026-10-09T01:00:00Z',
          }),
          observation({ itemKey: 'harvestCount', value: 4, observedAt: '2026-10-09T02:00:00Z' }),
        ],
      }),
    );

    expect(onlyText.values).not.toHaveProperty('harvestCount');
    expect(mixed.values.harvestCount).toBe(4);
  });

  it('満足度の項目に、文字列の値だけがあれば、集計しない。数値の値があれば、数値だけを使う', () => {
    const rating = (value: number | string, observedAt: string) =>
      observation({
        equipmentId: FACILITY_ID,
        itemKey: 'satisfaction.safety',
        value,
        observedAt,
        source: 'MANUAL',
      });

    const onlyText = aggregateMeasures(
      input({ observations: [rating('abc', '2026-10-09T01:00:00Z')] }),
    );
    const mixed = aggregateMeasures(
      input({
        observations: [rating('abc', '2026-10-09T01:00:00Z'), rating(4, '2026-10-09T02:00:00Z')],
      }),
    );

    expect(onlyText.values).not.toHaveProperty('satisfaction.safety');
    expect(mixed.values['satisfaction.safety']).toBe(4);
  });
});

describe('観測値の集計: 集計の種類', () => {
  it('累積の項目（稼働時間）は、期間内の増分の合計にする（短期・長期とも。D-26。累積の値を足さない）', () => {
    const observations = [
      observation({ itemKey: 'operatingHours', value: 0.25, observedAt: '2026-10-09T01:00:00Z' }),
      observation({ itemKey: 'operatingHours', value: 0.5, observedAt: '2026-10-09T02:00:00Z' }),
    ];

    const short = aggregateMeasures(
      input({ observations, horizon: 'SHORT', from: new Date('2026-10-08T03:00:00Z') }),
    );
    const long = aggregateMeasures(input({ observations }));

    // 0.25（0 からの増分）+ 0.25（0.25 → 0.5）。累積の値を足した 0.75 にはならない
    expect(short.values.operatingHours).toBe(0.5);
    expect(long.values.operatingHours).toBe(0.5);
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

describe('観測値の集計: 手動入力と自動取り込みの重なり（状態値・ステータスコード。従来どおり）', () => {
  const temperature = (
    value: number,
    observedAt: string,
    source: 'AUTO_IMPORT' | 'MANUAL' = 'AUTO_IMPORT',
  ) =>
    observation({
      equipmentId: SENSOR_ID,
      itemKey: 'temperatureCelsius',
      value,
      source,
      observedAt,
    });

  it('同じ設備・項目・計測日時では、手動入力を使い、自動取り込みの値は二重に数えない（状態値）', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          temperature(20, '2026-10-09T02:00:00Z'),
          temperature(40, '2026-10-09T02:00:00Z', 'MANUAL'),
          temperature(30, '2026-10-09T02:15:00Z'),
        ],
      }),
    );

    // 長期は平均。同じ日時の自動（20）は使わず、手動（40）と、別の日時の自動（30）の平均
    expect(measures.values.temperatureCelsius).toBe(35);
  });

  it('計測日時が異なれば、手動入力と自動取り込みの両方を使う（状態値。D-26 の自動優先は、合計の項目だけ）', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          temperature(20, '2026-10-09T02:00:00Z'),
          temperature(30, '2026-10-09T02:01:00Z', 'MANUAL'),
        ],
      }),
    );

    expect(measures.values.temperatureCelsius).toBe(25);
  });

  it('ステータスコードも、自動取り込みがあっても、手動入力を使う（短期は、最新の入力）', () => {
    const measures = aggregateMeasures(
      input({
        horizon: 'SHORT',
        from: new Date('2026-10-08T03:00:00Z'),
        observations: [
          observation({
            itemKey: 'statusCode',
            value: 'RUNNING',
            observedAt: '2026-10-09T01:00:00Z',
          }),
          observation({
            itemKey: 'statusCode',
            value: 'STOPPED',
            source: 'MANUAL',
            observedAt: '2026-10-09T02:00:00Z',
          }),
        ],
      }),
    );

    expect(measures.status?.code).toBe('STOPPED');
  });

  it('合計（累積）の項目で、同じ計測日時に自動取り込みと手動入力が重なるときも、自動があれば、自動だけを使う（D-26）', () => {
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

    // 自動だけ: 10 → 5（減ったのでリセット）。10 + 5。手動の 12 は使わない
    expect(measures.values.harvestCount).toBe(15);
  });

  it('合計（累積）の項目で、計測日時が異なるときも、自動があれば、手動入力を使わない（D-26）', () => {
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

    expect(measures.values.harvestCount).toBe(10);
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

describe('観測値の集計: 累積の項目（収穫数・稼働時間など。期間の値 = 期間内の増分の合計。D-26）', () => {
  const at = (hhmm: string): string => `2026-10-09T${hhmm}:00Z`;
  const harvest = (value: number, hhmm: string, overrides: Partial<ObservationOverrides> = {}) =>
    observation({ itemKey: 'harvestCount', value, observedAt: at(hhmm), ...overrides });

  it('累積の値は、足し算にせず、増分の合計にする（8:00 に 0、12:00 に 1,200、16:00 に 2,400 なら、2,400）', () => {
    const measures = aggregateMeasures(
      input({
        observations: [harvest(0, '00:00'), harvest(1200, '01:00'), harvest(2400, '02:00')],
      }),
    );

    expect(measures.values.harvestCount).toBe(2400);
  });

  it('合計の 5 項目は、すべて、累積として集計する', () => {
    const keys = [
      'harvestCount',
      'operatingHours',
      'standbyHours',
      'harvestOperatingHours',
      'travelStoppedHours',
    ];
    const measures = aggregateMeasures(
      input({
        observations: keys.flatMap((itemKey) => [
          observation({ itemKey, value: 1, observedAt: at('00:00') }),
          observation({ itemKey, value: 4, observedAt: at('01:00') }),
          observation({ itemKey, value: 6, observedAt: at('02:00') }),
        ]),
      }),
    );

    for (const itemKey of keys) {
      expect(measures.values[itemKey], itemKey).toBe(6);
    }
  });

  it('値が減ったときは、リセットとみなし、減った時点の値そのものを、その区間の増分にする', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          harvest(100, '00:00'),
          harvest(250, '00:30'),
          harvest(30, '01:00'),
          harvest(80, '01:30'),
        ],
      }),
    );

    // 100 + 150 + 30（リセット）+ 50
    expect(measures.values.harvestCount).toBe(330);
  });

  it('値が変わらなければ、増分は 0（同じ累積の値を、繰り返し足さない）', () => {
    const measures = aggregateMeasures(
      input({ observations: [harvest(10, '00:00'), harvest(10, '00:30'), harvest(10, '01:00')] }),
    );

    expect(measures.values.harvestCount).toBe(10);
  });

  it('期間の直前の値を基準にする（期間の最初の値の全体を、増分にしない）', () => {
    const baseline = harvest(1000, '23:00', { observedAt: '2026-10-01T00:00:00Z' });
    const measures = aggregateMeasures(
      input({
        observations: [harvest(1200, '01:00'), harvest(1500, '02:00')],
        priorObservations: [baseline],
      }),
    );

    expect(measures.values.harvestCount).toBe(500);
  });

  it('期間の直前の値は、期間の開始より前の、最新の値を使う（順序に依らない）', () => {
    const measures = aggregateMeasures(
      input({
        observations: [harvest(1500, '01:00')],
        priorObservations: [
          harvest(1400, '00:00', { observedAt: '2026-10-02T00:00:00Z' }),
          harvest(900, '00:00', { observedAt: '2026-10-01T00:00:00Z' }),
        ],
      }),
    );

    expect(measures.values.harvestCount).toBe(100);
  });

  it('期間の直前の値が、期間の値より大きければ（リセット）、期間の最初の値が増分になる', () => {
    const measures = aggregateMeasures(
      input({
        observations: [harvest(40, '01:00'), harvest(100, '02:00')],
        priorObservations: [harvest(5000, '00:00', { observedAt: '2026-10-01T00:00:00Z' })],
      }),
    );

    expect(measures.values.harvestCount).toBe(100);
  });

  it('期間の直前の値がなければ、0 から始まるとみなす（1 件だけなら、その値）', () => {
    const measures = aggregateMeasures(input({ observations: [harvest(7, '01:00')] }));

    expect(measures.values.harvestCount).toBe(7);
  });

  it('期間の直前の値は、使える観測値だけ（論理削除・欠損・不正・評価時刻より後に受信したものは使わない）', () => {
    const before = '2026-10-02T00:00:00Z';
    const measures = aggregateMeasures(
      input({
        observations: [harvest(1500, '01:00')],
        priorObservations: [
          harvest(1000, '00:00', { observedAt: '2026-10-01T00:00:00Z' }),
          harvest(1400, '00:00', { observedAt: before, isDeleted: true }),
          harvest(1450, '00:00', { observedAt: before, quality: 'INVALID' }),
          harvest(1480, '00:00', { observedAt: before, receivedAt: '2026-10-09T05:00:00Z' }),
        ],
      }),
    );

    expect(measures.values.harvestCount).toBe(500);
  });

  it('期間内に観測値がなければ、期間の直前の値があっても、未取得（キーなし）にする', () => {
    const measures = aggregateMeasures(
      input({
        observations: [],
        priorObservations: [harvest(1000, '00:00', { observedAt: '2026-10-01T00:00:00Z' })],
      }),
    );

    expect(measures.values).toEqual({});
  });

  it('設備ごとに、増分を求めて合計する（別の設備の累積の値を、つなげない）', () => {
    const other = toEquipmentId('ROBOT-T2');
    const measures = aggregateMeasures(
      input({
        observations: [
          harvest(100, '00:00'),
          harvest(1000, '00:10', { equipmentId: other }),
          harvest(150, '01:00'),
          harvest(1300, '01:10', { equipmentId: other }),
        ],
      }),
    );

    // 設備 1: 150、設備 2: 1,300（つなげると、100 → 1,000 → 150 → 1,300 で 1,000 + 0 + 1,300 になる）
    expect(measures.values.harvestCount).toBe(1450);
  });

  it('計測日時の順に並んでいない入力でも、計測日時の順に増分を求める', () => {
    const measures = aggregateMeasures(
      input({
        observations: [harvest(2400, '02:00'), harvest(0, '00:00'), harvest(1200, '01:00')],
      }),
    );

    expect(measures.values.harvestCount).toBe(2400);
  });

  it('小数の累積の値（稼働時間）の増分は、小数第 6 位に丸める（浮動小数点の誤差を残さない）', () => {
    const operating = (value: number, hhmm: string) =>
      observation({ itemKey: 'operatingHours', value, observedAt: at(hhmm) });
    const measures = aggregateMeasures(
      input({
        observations: [operating(0.1, '00:00'), operating(0.3, '01:00'), operating(0.7, '02:00')],
      }),
    );

    expect(measures.values.operatingHours).toBe(0.7);
  });

  it('短期（直近 24 時間）も、同じく、期間の直前の値を基準にした増分の合計にする', () => {
    const measures = aggregateMeasures(
      input({
        horizon: 'SHORT',
        from: new Date('2026-10-08T03:00:00Z'),
        observations: [harvest(1200, '01:00'), harvest(1500, '02:00')],
        priorObservations: [harvest(1000, '00:00', { observedAt: '2026-10-08T02:00:00Z' })],
      }),
    );

    expect(measures.values.harvestCount).toBe(500);
  });

  it('手動専用の件数の項目は、現状のまま、入力ごとの件数を足す', () => {
    const damaged = (value: number, hhmm: string) =>
      observation({ itemKey: 'damagedFruitCount', value, source: 'MANUAL', observedAt: at(hhmm) });
    const measures = aggregateMeasures(
      input({ observations: [damaged(2, '00:00'), damaged(3, '01:00'), damaged(1, '02:00')] }),
    );

    expect(measures.values.damagedFruitCount).toBe(6);
  });
});

describe('観測値の集計: 合計（累積）の項目は、自動取り込みを優先する（D-26。評価の期間に自動が 1 件でもあれば、自動だけ）', () => {
  const at = (hhmm: string): string => `2026-10-09T${hhmm}:00Z`;
  const harvest = (
    value: number,
    hhmm: string,
    source: 'AUTO_IMPORT' | 'MANUAL',
    overrides: Partial<ObservationOverrides> = {},
  ) => observation({ itemKey: 'harvestCount', value, source, observedAt: at(hhmm), ...overrides });

  it('自動の 1,800 → 手動の 1,700 → 自動の 2,400 は、手動を混ぜず、自動だけの 2,400（混ぜると 4,200 になる誤り）', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          harvest(1800, '00:00', 'AUTO_IMPORT'),
          harvest(1700, '01:00', 'MANUAL'),
          harvest(2400, '02:00', 'AUTO_IMPORT'),
        ],
      }),
    );

    // 自動だけ: 1,800（0 からの増分）+ 600
    expect(measures.values.harvestCount).toBe(2400);
  });

  it('期間の直前の自動の値を基準にした増分は 600（間の手動入力で壊れない）', () => {
    const measures = aggregateMeasures(
      input({
        from: new Date('2026-10-09T01:30:00Z'),
        observations: [harvest(1700, '01:45', 'MANUAL'), harvest(2400, '02:00', 'AUTO_IMPORT')],
        priorObservations: [harvest(1800, '01:00', 'AUTO_IMPORT')],
      }),
    );

    expect(measures.values.harvestCount).toBe(600);
  });

  it('自動の基準は、自動の値だけから選ぶ（直前の値が手動でも、基準にしない）', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          harvest(1800, '01:00', 'AUTO_IMPORT'),
          harvest(2400, '02:00', 'AUTO_IMPORT'),
        ],
        priorObservations: [
          harvest(1000, '00:00', 'AUTO_IMPORT', { observedAt: '2026-10-01T00:00:00Z' }),
          harvest(5000, '00:00', 'MANUAL', { observedAt: '2026-10-08T00:00:00Z' }),
        ],
      }),
    );

    // 基準は、自動の 1,000: 800 + 600。手動の 5,000 を基準にすると、リセット扱いで 1,800 + 600
    expect(measures.values.harvestCount).toBe(1400);
  });

  it('自動がなければ、手動だけを使う（手動のみの運用）。手動の基準は、手動の値だけから選ぶ', () => {
    const measures = aggregateMeasures(
      input({
        observations: [harvest(150, '01:00', 'MANUAL'), harvest(400, '02:00', 'MANUAL')],
        priorObservations: [
          harvest(100, '00:00', 'MANUAL', { observedAt: '2026-10-01T00:00:00Z' }),
          harvest(9000, '00:00', 'AUTO_IMPORT', { observedAt: '2026-10-08T00:00:00Z' }),
        ],
      }),
    );

    // 基準は、手動の 100: 50 + 250
    expect(measures.values.harvestCount).toBe(300);
  });

  it('期間の外にしか自動がなければ、期間内は手動だけを使う（自動の有無は、評価の期間ごとに判定する）', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          harvest(1800, '00:00', 'AUTO_IMPORT', { observedAt: '2026-09-01T00:00:00Z' }),
          harvest(100, '01:00', 'MANUAL'),
          harvest(250, '02:00', 'MANUAL'),
        ],
        from: new Date('2026-10-08T00:00:00Z'),
      }),
    );

    expect(measures.values.harvestCount).toBe(250);
  });

  it('同じ観測値で、短期（24 時間）と長期（7 日）の取得元が違うことがある（短期は自動なし→手動、長期は自動あり→自動）', () => {
    const observations = [
      harvest(1000, '00:00', 'AUTO_IMPORT', { observedAt: '2026-10-05T00:00:00Z' }),
      harvest(1500, '00:00', 'AUTO_IMPORT', { observedAt: '2026-10-05T06:00:00Z' }),
      harvest(300, '01:00', 'MANUAL'),
      harvest(450, '02:00', 'MANUAL'),
    ];

    const short = aggregateMeasures(
      input({ observations, horizon: 'SHORT', from: new Date('2026-10-08T03:00:00Z') }),
    );
    const long = aggregateMeasures(input({ observations }));

    expect(short.values.harvestCount).toBe(450);
    expect(long.values.harvestCount).toBe(1500);
  });

  it('自動の有無は、設備ごとに判定する（自動のある設備は自動、手動だけの設備は手動を使い、増分を合計する）', () => {
    const other = toEquipmentId('ROBOT-T2');
    const measures = aggregateMeasures(
      input({
        observations: [
          harvest(100, '00:00', 'AUTO_IMPORT'),
          harvest(9999, '00:30', 'MANUAL'),
          harvest(160, '01:00', 'AUTO_IMPORT'),
          harvest(30, '00:10', 'MANUAL', { equipmentId: other }),
          harvest(80, '01:10', 'MANUAL', { equipmentId: other }),
        ],
      }),
    );

    // 設備 1（自動）: 100 + 60。設備 2（手動のみ）: 30 + 50
    expect(measures.values.harvestCount).toBe(240);
  });

  it('自動の有無は、項目ごとに判定する（収穫数に自動があっても、稼働時間の手動入力は、自動がなければ使う）', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          harvest(100, '01:00', 'AUTO_IMPORT'),
          harvest(9999, '01:30', 'MANUAL'),
          observation({
            itemKey: 'operatingHours',
            value: 2,
            source: 'MANUAL',
            observedAt: at('02:00'),
          }),
        ],
      }),
    );

    expect(measures.values).toMatchObject({ harvestCount: 100, operatingHours: 2 });
  });

  it('合計（累積）の 5 項目は、すべて、自動があれば手動を使わない', () => {
    const keys = [
      'harvestCount',
      'operatingHours',
      'standbyHours',
      'harvestOperatingHours',
      'travelStoppedHours',
    ];
    const measures = aggregateMeasures(
      input({
        observations: keys.flatMap((itemKey) => [
          observation({ itemKey, value: 3, source: 'AUTO_IMPORT', observedAt: at('01:00') }),
          observation({ itemKey, value: 900, source: 'MANUAL', observedAt: at('02:00') }),
        ]),
      }),
    );

    for (const itemKey of keys) {
      expect(measures.values[itemKey], itemKey).toBe(3);
    }
  });

  it('使えない自動（論理削除・欠損・不正・評価時刻より後に受信）は、「自動がある」に数えない（手動を使う）', () => {
    const unusable: Partial<ObservationOverrides>[] = [
      { isDeleted: true },
      { value: null, quality: 'MISSING' },
      { quality: 'INVALID' },
      { receivedAt: '2026-10-09T05:00:00Z' },
    ];
    for (const override of unusable) {
      const measures = aggregateMeasures(
        input({
          observations: [
            harvest(1800, '00:30', 'AUTO_IMPORT', override),
            harvest(100, '01:00', 'MANUAL'),
            harvest(250, '02:00', 'MANUAL'),
          ],
        }),
      );

      expect(measures.values.harvestCount, JSON.stringify(override)).toBe(250);
    }
  });

  it('遅延（LATE）の自動は、使える自動として数える（手動を使わない）', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          harvest(500, '00:30', 'AUTO_IMPORT', { quality: 'LATE' }),
          harvest(9999, '01:00', 'MANUAL'),
        ],
      }),
    );

    expect(measures.values.harvestCount).toBe(500);
  });

  it('自動の値が文字列だけのときは、数値の自動がないとみなし、手動を使う', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          harvest('RUNNING' as unknown as number, '00:30', 'AUTO_IMPORT'),
          harvest(250, '01:00', 'MANUAL'),
        ],
      }),
    );

    expect(measures.values.harvestCount).toBe(250);
  });

  it('自動がある期間でも、手動専用の件数の項目・状態値は、従来どおり、手動入力を使う', () => {
    const measures = aggregateMeasures(
      input({
        observations: [
          harvest(100, '01:00', 'AUTO_IMPORT'),
          harvest(9999, '01:30', 'MANUAL'),
          observation({
            itemKey: 'damagedFruitCount',
            value: 4,
            source: 'MANUAL',
            observedAt: at('01:30'),
          }),
          observation({
            equipmentId: SENSOR_ID,
            itemKey: 'temperatureCelsius',
            value: 20,
            observedAt: at('01:00'),
          }),
          observation({
            equipmentId: SENSOR_ID,
            itemKey: 'temperatureCelsius',
            value: 30,
            source: 'MANUAL',
            observedAt: at('02:00'),
          }),
        ],
      }),
    );

    expect(measures.values).toMatchObject({
      harvestCount: 100,
      damagedFruitCount: 4,
      temperatureCelsius: 25,
    });
  });

  it('データ活用度合い（手動入力の数え方）は、評価に使われない手動入力も、手動入力の取得数に数える（変わらない）', () => {
    const observations = [harvest(100, '01:00', 'AUTO_IMPORT'), harvest(9999, '01:30', 'MANUAL')];
    const from = new Date(NOW.getTime() - DAY_MS);

    const withoutManual = aggregateMeasures(
      input({ from, observations: observations.slice(0, 1) }),
    );
    const withManual = aggregateMeasures(input({ from, observations }));

    expect(withoutManual.values.manualDataCount).toBe(0);
    expect(withManual.values.manualDataCount).toBe(1);
    expect(withManual.values.robotDataCount).toBe(withoutManual.values.robotDataCount);
    expect(withManual.values.totalDataCount).toBe(withoutManual.values.totalDataCount);
  });

  it('取得元を決める設備・項目を、呼び出し側が渡すこともできる（推移で、全体の期間の判定を、区間に使う）', () => {
    const observations = [harvest(100, '01:00', 'MANUAL'), harvest(250, '02:00', 'MANUAL')];

    const fromPeriod = aggregateMeasures(input({ observations }));
    const decided = aggregateMeasures(
      input({ observations, autoCumulativeKeys: new Set([`${ROBOT_ID}#harvestCount`]) }),
    );

    expect(fromPeriod.values.harvestCount).toBe(250);
    // 全体の期間では自動がある（この区間には、自動がない）ので、手動は使わず、未取得
    expect(decided.values).not.toHaveProperty('harvestCount');
  });
});
