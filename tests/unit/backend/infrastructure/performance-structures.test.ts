/**
 * 性能の改善（レビュー V-072・V-075・V-077・V-082・V-086・V-087・V-189・V-191）で入れた、索引・キャッシュ・上位件数の選択が、
 * 従来の全件走査・全件の並べ替えと同じ結果を返すことのテスト。
 */

import { describe, expect, it } from 'vitest';
import { toEquipmentId } from '@smart-farm/shared/schemas/common';
import { compareIsoInstants } from '@smart-farm/shared/time';
import {
  createKeywordMatcher,
  observationMatchesKeyword,
  type ObservationNames,
} from '../../../../src/backend/application/query/observation-query.ts';
import { paginatedSorted } from '../../../../src/backend/infrastructure/local/repositories/collection-helpers.ts';
import { createLocalRepositories } from '../../../../src/backend/infrastructure/local/local-repositories.ts';
import { createRandom } from '../../../../src/backend/infrastructure/local/synthetic-data.ts';
import { observation, ROBOT_ID, SENSOR_ID } from '../../../support/builders.ts';

describe('paginatedSorted（上位の件数だけを選ぶページ分割。V-075）', () => {
  const random = createRandom(7);
  const numbers = Array.from({ length: 3000 }, (_, index) => index);
  // 全順序（同じ値がない）の入力を、ランダムな順序にする
  const shuffled = [...numbers].sort(() => random() - 0.5);
  const ascending = (left: number, right: number) => left - right;

  it.each([
    [10, undefined],
    [20, 'MjA'], // 位置 20 のカーソル
    [50, 'MTAw'], // 位置 100
    [100, 'ODAw'], // 位置 800（位置 + 件数が上限を超え、全件を並べ替える）
    [5000, undefined], // 件数が全件を超える
  ])(
    '件数 %i・カーソル %s: 全件を並べ替えた結果と同じ項目・次のカーソルを返す',
    async (limit, cursor) => {
      const subject = await paginatedSorted(shuffled, ascending, { limit, cursor });
      const reference = await paginatedSorted([...numbers], () => 0, { limit, cursor });
      const sorted = numbers.slice(
        cursor === undefined ? 0 : Number(Buffer.from(cursor, 'base64url').toString()),
      );

      expect(subject.items).toEqual(sorted.slice(0, limit));
      expect(subject.nextCursor === null).toBe(reference.nextCursor === null);
    },
  );

  it('次のページがなければ nextCursor は null。空の入力でも動く。不正なカーソルは拒否する', async () => {
    expect((await paginatedSorted([3, 1, 2], ascending, { limit: 5 })).nextCursor).toBeNull();
    expect(await paginatedSorted([], ascending, { limit: 5 })).toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(paginatedSorted([1], ascending, { limit: 5, cursor: '!!' })).rejects.toThrow(
      'cursor',
    );
    expect((await paginatedSorted([1, 2], ascending, { limit: 0 })).items).toEqual([]);
  });
});

describe('観測値の Repository（索引・キャッシュ）', () => {
  it('findByKey: 一意キー（設備・項目・計測日時・取得元）で直接引く。論理削除済みも返し、キーが違えば undefined', async () => {
    const { repositories } = createLocalRepositories();
    const saved = observation({
      equipmentId: ROBOT_ID,
      itemKey: 'harvestCount',
      value: 3,
      source: 'MANUAL',
      isDeleted: true,
    });
    await repositories.observations.saveMany([saved]);

    const found = await repositories.observations.findByKey(
      ROBOT_ID,
      'harvestCount',
      saved.observedAt,
      'MANUAL',
    );

    expect(found).toEqual(saved);
    expect(
      await repositories.observations.findByKey(
        ROBOT_ID,
        'harvestCount',
        saved.observedAt,
        'AUTO_IMPORT',
      ),
    ).toBeUndefined();
    expect(
      await repositories.observations.findByKey(
        SENSOR_ID,
        'harvestCount',
        saved.observedAt,
        'MANUAL',
      ),
    ).toBeUndefined();
  });

  it('latestReceivedAt: 結果を再利用するが、書き込み・全消去・読み込みの後は、最新の値を返す', async () => {
    const { repositories, store } = createLocalRepositories();
    const at = (hour: number) => `2026-10-09T0${String(hour)}:00:00.000Z`;
    await repositories.observations.saveMany([
      observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 1, receivedAt: at(1) }),
    ]);
    expect(await repositories.observations.latestReceivedAt([ROBOT_ID])).toEqual(new Date(at(1)));
    expect(await repositories.observations.latestReceivedAt([ROBOT_ID])).toEqual(new Date(at(1)));

    await repositories.observations.saveMany([
      observation({
        equipmentId: ROBOT_ID,
        itemKey: 'operatingHours',
        value: 1,
        receivedAt: at(2),
        source: 'MANUAL',
      }),
    ]);

    expect(await repositories.observations.latestReceivedAt([ROBOT_ID])).toEqual(new Date(at(2)));
    expect(
      await repositories.observations.latestReceivedAt([ROBOT_ID], { autoImportOnly: true }),
    ).toEqual(new Date(at(1)));

    store.clear();
    expect(await repositories.observations.latestReceivedAt([ROBOT_ID])).toBeNull();
  });
});

describe('取り込み済みファイルの索引（V-082）', () => {
  const record = (fileId: string, contentHash: string, result: 'SUCCESS' | 'FAILURE') => ({
    sourceId: 'robot',
    fileId,
    contentHash,
    fetchedAt: '2026-10-09T03:00:00.000Z',
    result,
    recordCount: 1,
  });

  it('索引を作った後に記録したファイルも、見つける。失敗の記録は、同じ識別子のときだけ一致する', async () => {
    const { repositories, store } = createLocalRepositories();
    await repositories.ingestion.recordFile(record('a.json', 'h1', 'SUCCESS'));
    // 索引を作らせる
    expect(
      await repositories.ingestion.findIngestedFile('robot', 'other.json', 'h1'),
    ).toBeDefined();

    await repositories.ingestion.recordFile(record('b.json', 'h2', 'SUCCESS'));
    await repositories.ingestion.recordFile(record('c.json', 'h2', 'SUCCESS'));
    await repositories.ingestion.recordFile(record('bad.json', 'h3', 'FAILURE'));

    expect(await repositories.ingestion.findIngestedFile('robot', 'copy.json', 'h2')).toBeDefined();
    expect(await repositories.ingestion.findIngestedFile('robot', 'bad.json', 'h3')).toBeDefined();
    expect(
      await repositories.ingestion.findIngestedFile('robot', 'other.json', 'h3'),
    ).toBeUndefined();
    expect(await repositories.ingestion.findIngestedFile('sensor', 'a.json', 'h1')).toBeUndefined();

    store.clear();
    expect(await repositories.ingestion.findIngestedFile('robot', 'a.json', 'h1')).toBeUndefined();
  });
});

describe('キーワード検索（V-189）', () => {
  const names: ObservationNames = {
    equipment: new Map([
      [ROBOT_ID, '収穫ロボット1'],
      [SENSOR_ID, 'Sensor A'],
    ]),
    statusCodes: new Map([['RUNNING', '走行中']]),
  };
  const sample = [
    observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 12 }),
    observation({ equipmentId: ROBOT_ID, itemKey: 'statusCode', value: 'RUNNING' }),
    observation({ equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 26.5 }),
    observation({
      equipmentId: SENSOR_ID,
      itemKey: 'humidityPercent',
      value: 55,
      source: 'MANUAL',
    }),
    observation({
      equipmentId: toEquipmentId('HOUSE-X'),
      itemKey: 'co2Ppm',
      value: 800,
      quality: 'INVALID',
    }),
  ];

  it.each([
    '',
    '  ',
    'harvest',
    'ロボット',
    'SENSOR',
    '走行',
    '26.5',
    '手動',
    '不正',
    'temp',
    'zzz',
    '収穫',
  ])(
    'キーワード「%s」: 従来の判定（observationMatchesKeyword）と、すべての観測値で同じ結果になる',
    (keyword) => {
      const matcher = createKeywordMatcher(keyword, names);

      for (const item of sample) {
        expect(matcher(item)).toBe(observationMatchesKeyword(item, keyword, names));
        // 2回目（キャッシュを使う）も同じ
        expect(matcher(item)).toBe(observationMatchesKeyword(item, keyword, names));
      }
    },
  );
});

describe('日時の文字列の比較（V-088）', () => {
  it('表記の長さが違っても（ミリ秒の有無）、同じ時刻は 0、前後は正しく返す', () => {
    expect(compareIsoInstants('2026-10-09T03:00:00Z', '2026-10-09T03:00:00.000Z')).toBe(0);
    expect(compareIsoInstants('2026-10-09T03:00:00Z', '2026-10-09T03:00:00.001Z')).toBeLessThan(0);
    expect(compareIsoInstants('2026-10-09T03:00:01Z', '2026-10-09T03:00:00.999Z')).toBeGreaterThan(
      0,
    );
    expect(compareIsoInstants('2026-10-09T03:00:00.000Z', '2026-10-09T03:00:00.000Z')).toBe(0);
    expect(compareIsoInstants('2026-10-09T03:00:00.000Z', '2026-10-09T03:00:00.001Z')).toBeLessThan(
      0,
    );
    expect(
      compareIsoInstants('2026-10-09T03:00:00.002Z', '2026-10-09T03:00:00.001Z'),
    ).toBeGreaterThan(0);
  });

  it('ミリ秒のない計測日時の観測値が、期間の境界（同じ時刻）で、除かれない', async () => {
    const { repositories } = createLocalRepositories();
    const noMillis = observation({
      equipmentId: ROBOT_ID,
      itemKey: 'harvestCount',
      value: 1,
      observedAt: '2026-10-09T03:00:00Z',
    });
    await repositories.observations.saveMany([noMillis]);
    const boundary = new Date('2026-10-09T03:00:00Z');

    const queried = await repositories.observations.query(
      { equipmentIds: [ROBOT_ID], from: boundary, to: boundary },
      { limit: 10 },
    );
    const forEvaluation = await repositories.observations.findForEvaluation(
      [ROBOT_ID],
      boundary,
      boundary,
    );

    expect(queried.items).toHaveLength(1);
    expect(forEvaluation).toHaveLength(1);
  });
});
