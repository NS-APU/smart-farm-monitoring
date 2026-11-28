/**
 * 計測単位の観測値の一覧（GET /observations/measurements。Issue #363）の結合テスト。
 * 1 回の計測（設備・計測日時・取得元〔手動入力は 1 回の入力〕）の項目を 1 つにまとめ、日時順に、計測単位でページを分ける
 * （1 回の計測は、ページの境界で割れない）。キーワード・カテゴリで絞ったときも、その計測の全項目を返す。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MeasurementListResponseSchema,
  type Measurement,
  type Observation,
} from '@smart-farm/shared/schemas/observation';
import { FACILITY_ID, must, observation, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';
import {
  addUserAndLogin,
  errorOf,
  markPasswordChanged,
  withEquipment,
  type TestContext,
} from '../support/test-context.ts';

const BASE_MS = Date.parse('2026-10-01T00:00:00.000Z');
const at = (minutes: number): string => new Date(BASE_MS + minutes * 60_000).toISOString();

/** ロボットの 1 回の計測（収穫数・稼働時間・待機時間の 3 項目）。 */
function robotMeasurement(minutes: number, overrides: Partial<Observation> = {}): Observation[] {
  return [
    observation({
      equipmentId: ROBOT_ID,
      itemKey: 'harvestCount',
      value: minutes,
      observedAt: at(minutes),
    }),
    observation({
      equipmentId: ROBOT_ID,
      itemKey: 'operatingHours',
      value: 1,
      observedAt: at(minutes),
    }),
    observation({
      equipmentId: ROBOT_ID,
      itemKey: 'standbyHours',
      value: 2,
      observedAt: at(minutes),
    }),
  ].map((item) => ({ ...item, ...overrides }));
}

async function save(context: TestContext, items: readonly Observation[]): Promise<void> {
  await context.container.repositories.observations.saveMany(items);
}

async function fetchMeasurements(context: TestContext, query = '') {
  const response = await context.request(`/observations/measurements${query}`);
  expect(response.status).toBe(200);
  return MeasurementListResponseSchema.parse(await response.json());
}

/** 全ページをたどる。 */
async function allPages(context: TestContext, query: string): Promise<Measurement[][]> {
  const pages: Measurement[][] = [];
  let cursor: string | null = null;
  do {
    const page = await fetchMeasurements(
      context,
      `${query}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    pages.push(page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return pages;
}

const keyOf = (measurement: Measurement): string =>
  `${measurement.equipmentId}|${measurement.observedAt}|${measurement.source}|${measurement.manualEntryId ?? ''}`;

describe('1 回の計測にまとめる', () => {
  it('同じ設備・計測日時・取得元の項目を 1 つの計測にする。項目は、項目の定義の順', async () => {
    const context = await withEquipment();
    await save(context, [...robotMeasurement(10)].reverse());

    const { items, nextCursor } = await fetchMeasurements(context, '?limit=20');

    expect(nextCursor).toBeNull();
    expect(items).toHaveLength(1);
    expect(items[0]?.equipmentId).toBe(ROBOT_ID);
    expect(items[0]?.observedAt).toBe(at(10));
    expect(items[0]?.items.map((item) => item.itemKey)).toEqual([
      'harvestCount',
      'operatingHours',
      'standbyHours',
    ]);
  });

  it('設備・日時・取得元・手動入力の 1 回の入力が違えば、別の計測。同じ日時の別の設備も、別の計測', async () => {
    const context = await withEquipment();
    await save(context, [
      ...robotMeasurement(10),
      ...robotMeasurement(10, { source: 'MANUAL' }),
      ...robotMeasurement(20, { source: 'MANUAL', manualEntryId: 'e-1' }),
      // 同じ設備・日時・取得元でも、別の入力（別のカテゴリ）は、別の計測（同じ項目は、一意キーが同じで、上書きされるため、項目を変える）
      {
        ...observation({
          equipmentId: ROBOT_ID,
          itemKey: 'failureCount',
          value: 1,
          observedAt: at(20),
        }),
        source: 'MANUAL',
        manualEntryId: 'e-2',
      },
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 22,
        observedAt: at(10),
      }),
    ]);

    const { items } = await fetchMeasurements(context, '?limit=50');

    expect(items.map(keyOf).sort()).toEqual(
      [
        `${ROBOT_ID}|${at(10)}|AUTO_IMPORT|`,
        `${ROBOT_ID}|${at(10)}|MANUAL|`,
        `${ROBOT_ID}|${at(20)}|MANUAL|e-1`,
        `${ROBOT_ID}|${at(20)}|MANUAL|e-2`,
        `${SENSOR_ID}|${at(10)}|AUTO_IMPORT|`,
      ].sort(),
    );
    expect(items.find((item) => item.manualEntryId === 'e-1')?.items).toHaveLength(3);
    expect(items.find((item) => item.manualEntryId === 'e-2')?.items).toHaveLength(1);
  });

  it('論理削除した観測値は、含めない。受信日時は、計測の中の最も新しい値', async () => {
    const context = await withEquipment();
    const [first, second, third] = robotMeasurement(10);
    await save(context, [
      { ...must(first), receivedAt: at(11) },
      { ...must(second), receivedAt: at(12) },
      { ...must(third), isDeleted: true },
    ]);

    const { items } = await fetchMeasurements(context);

    expect(items[0]?.items.map((item) => item.itemKey)).toEqual(['harvestCount', 'operatingHours']);
    expect(items[0]?.receivedAt).toBe(at(12));
  });
});

describe('日時順・ページ分割', () => {
  it('既定は新しい順。asc は古い順', async () => {
    const context = await withEquipment();
    await save(context, [
      ...robotMeasurement(10),
      ...robotMeasurement(30),
      ...robotMeasurement(20),
    ]);

    const desc = await fetchMeasurements(context);
    const asc = await fetchMeasurements(context, '?direction=asc');

    expect(desc.items.map((item) => item.observedAt)).toEqual([at(30), at(20), at(10)]);
    expect(asc.items.map((item) => item.observedAt)).toEqual([at(10), at(20), at(30)]);
  });

  it.each(['desc', 'asc'] as const)(
    '計測単位でページを分け（%s）、全ページをたどると、すべての計測が、重複・欠けなく並ぶ。1 回の計測は、ページの境界で割れない',
    async (direction) => {
      const context = await withEquipment();
      const all: Observation[] = [];
      for (let minute = 1; minute <= 7; minute += 1) {
        all.push(...robotMeasurement(minute));
      }
      await save(context, all);

      const pages = await allPages(context, `?limit=3&direction=${direction}`);

      expect(pages.map((page) => page.length)).toEqual([3, 3, 1]);
      const flat = pages.flat();
      expect(new Set(flat.map(keyOf)).size).toBe(7);
      const minutes = flat.map((item) => (Date.parse(item.observedAt) - BASE_MS) / 60_000);
      expect(minutes).toEqual(direction === 'desc' ? [7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7]);
      // どの計測も、3 項目がそろっている
      expect(flat.every((item) => item.items.length === 3)).toBe(true);
    },
  );

  it('同じ日時の計測は、まとめて同じページに入る（limit を超えることがある）', async () => {
    const context = await withEquipment();
    await save(context, [
      ...robotMeasurement(10),
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 22,
        observedAt: at(10),
      }),
      ...robotMeasurement(5),
    ]);

    const pages = await allPages(context, '?limit=1');

    expect(pages.map((page) => page.length)).toEqual([2, 1]);
    expect(pages[0]?.map((item) => item.observedAt)).toEqual([at(10), at(10)]);
  });

  it('1 ページの読み取りの大きさ（項目数）を超える量でも、全ページで、取りこぼさない', async () => {
    const context = await withEquipment();
    const all: Observation[] = [];
    for (let minute = 1; minute <= 150; minute += 1) {
      all.push(...robotMeasurement(minute));
    }
    await save(context, all);

    const pages = await allPages(context, '?limit=100');

    expect(pages.flat()).toHaveLength(150);
    expect(new Set(pages.flat().map(keyOf)).size).toBe(150);
    expect(pages.flat().every((item) => item.items.length === 3)).toBe(true);
  });

  it('データがなければ、空。不正なページの指定は、400', async () => {
    const context = await withEquipment();

    expect(await fetchMeasurements(context)).toEqual({ items: [], nextCursor: null });
    const bad = await context.request('/observations/measurements?cursor=bad');
    expect(bad.status).toBe(400);
  });
});

describe('絞り込み', () => {
  it('設備・取得元・期間で絞る。ハウスを指定すると、配下の設備の計測も含む', async () => {
    const context = await withEquipment();
    await save(context, [
      ...robotMeasurement(10),
      ...robotMeasurement(20, { source: 'MANUAL' }),
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 22,
        observedAt: at(30),
      }),
    ]);

    const byEquipment = await fetchMeasurements(context, `?equipmentId=${SENSOR_ID}`);
    const byHouse = await fetchMeasurements(context, `?equipmentId=${FACILITY_ID}`);
    const bySource = await fetchMeasurements(context, '?source=MANUAL');
    const byPeriod = await fetchMeasurements(
      context,
      `?from=${encodeURIComponent(at(15))}&to=${encodeURIComponent(at(25))}`,
    );

    expect(byEquipment.items.map((item) => item.equipmentId)).toEqual([SENSOR_ID]);
    expect(byHouse.items).toHaveLength(3);
    expect(bySource.items.map((item) => item.source)).toEqual(['MANUAL']);
    expect(byPeriod.items.map((item) => item.observedAt)).toEqual([at(20)]);
  });

  it('カテゴリ・キーワードで絞ると、一致した項目を含む計測を、全項目で返す', async () => {
    const context = await withEquipment();
    await save(context, [
      ...robotMeasurement(10),
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 22,
        observedAt: at(20),
      }),
    ]);
    const period = `from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(60))}`;

    const byCategory = await fetchMeasurements(context, '?category=OPERATION');
    const byKeyword = await fetchMeasurements(
      context,
      `?q=${encodeURIComponent('待機')}&${period}`,
    );

    // 稼働時間・待機時間は「稼働情報」。収穫数（収穫情報）も、同じ計測として、そろって返る
    expect(byCategory.items).toHaveLength(1);
    expect(byCategory.items[0]?.items.map((item) => item.itemKey)).toEqual([
      'harvestCount',
      'operatingHours',
      'standbyHours',
    ]);
    expect(byKeyword.items).toHaveLength(1);
    expect(byKeyword.items[0]?.items).toHaveLength(3);
  });

  it('キーワードは、期間（31 日以内）が必須。足りなければ 400', async () => {
    const context = await withEquipment();

    const missing = await context.request('/observations/measurements?q=test');
    const tooLong = await context.request(
      `/observations/measurements?q=test&from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(60 * 24 * 40))}`,
    );

    expect(missing.status).toBe(400);
    expect(tooLong.status).toBe(400);
    expect((await errorOf(missing)).fields?.map((field) => field.name).sort()).toEqual([
      'from',
      'to',
    ]);
  });
});

describe('「問題あり」（有効でない: 欠損・遅延・不正）の絞り込み（SC-09-3）', () => {
  const period = `from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(60))}`;

  /** 10 分: すべて有効／20 分: 遅延を含む／30 分: 欠損を含む／40 分: 不正を含む（センサー）。 */
  async function withProblems() {
    const context = await withEquipment();
    const [harvest, operating, standby] = robotMeasurement(20);
    await save(context, [
      ...robotMeasurement(10),
      must(harvest),
      { ...must(operating), quality: 'LATE' as const },
      must(standby),
      ...robotMeasurement(30).map((item) =>
        item.itemKey === 'harvestCount'
          ? { ...item, value: null, quality: 'MISSING' as const }
          : item,
      ),
      observation({
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 999,
        quality: 'INVALID',
        observedAt: at(40),
      }),
    ]);
    return context;
  }

  it('有効でない項目を 1 つでも含む計測だけを返す（遅延を含む）。その計測は、有効な項目も含めて、全項目を示す', async () => {
    const context = await withProblems();

    const { items, nextCursor } = await fetchMeasurements(
      context,
      `?problemOnly=true&${period}&direction=asc`,
    );

    expect(nextCursor).toBeNull();
    expect(items.map((item) => item.observedAt)).toEqual([at(20), at(30), at(40)]);
    expect(items[0]?.items.map((item) => [item.itemKey, item.quality])).toEqual([
      ['harvestCount', 'VALID'],
      ['operatingHours', 'LATE'],
      ['standbyHours', 'VALID'],
    ]);
    expect(items[1]?.items.map((item) => item.quality)).toEqual(['MISSING', 'VALID', 'VALID']);
    expect(items[2]?.items.map((item) => item.quality)).toEqual(['INVALID']);
  });

  it('指定しない・false なら、すべての計測を返し、期間も不要。ほかの条件（設備・取得元）とも組み合わせられる', async () => {
    const context = await withProblems();

    const off = await fetchMeasurements(context, '?problemOnly=false');
    const none = await fetchMeasurements(context);
    const sensorOnly = await fetchMeasurements(
      context,
      `?problemOnly=true&equipmentId=${SENSOR_ID}&${period}`,
    );
    const manual = await fetchMeasurements(context, `?problemOnly=true&source=MANUAL&${period}`);

    expect(off.items).toHaveLength(4);
    expect(none.items).toHaveLength(4);
    expect(sensorOnly.items.map((item) => item.equipmentId)).toEqual([SENSOR_ID]);
    expect(manual.items).toEqual([]);
  });

  it('ページ分割しても、「問題あり」の計測だけが、重複・欠けなく並ぶ', async () => {
    const context = await withProblems();

    const pages = await allPages(context, `?problemOnly=true&limit=1&${period}`);

    expect(pages.map((page) => page.length)).toEqual([1, 1, 1]);
    expect(pages.flat().map((item) => item.observedAt)).toEqual([at(40), at(30), at(20)]);
  });

  it('期間（31 日以内）が必須。足りなければ 400（from・to）。不正な値も 400', async () => {
    const context = await withProblems();

    const missing = await context.request('/observations/measurements?problemOnly=true');
    const tooLong = await context.request(
      `/observations/measurements?problemOnly=true&from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(60 * 24 * 40))}`,
    );
    const invalid = await context.request(`/observations/measurements?problemOnly=1&${period}`);

    expect(missing.status).toBe(400);
    expect(tooLong.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect((await errorOf(missing)).fields?.map((field) => field.name).sort()).toEqual([
      'from',
      'to',
    ]);
  });
});

describe('閲覧の範囲', () => {
  it('割り当てのない一般ユーザーには、何も返さない（範囲外の設備の指定は、存在しないもの）', async () => {
    const context = await withEquipment();
    await save(context, robotMeasurement(10));
    const token = await addUserAndLogin(context, { userId: 'nobody', role: 'general' });
    await markPasswordChanged(context, 'nobody');

    const own = await context.request('/observations/measurements', {
      headers: { authorization: `Bearer ${token}` },
    });
    const other = await context.request(`/observations/measurements?equipmentId=${ROBOT_ID}`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(own.status).toBe(200);
    expect(MeasurementListResponseSchema.parse(await own.json()).items).toEqual([]);
    expect(other.status).toBe(404);
  });
});

describe('項目の並び・ページの続きと期間の組み合わせ・展開の取得', () => {
  it('項目の定義にない項目は、定義の項目のあとに、項目名の順で並べる', async () => {
    const context = await withEquipment();
    const known = observation({
      equipmentId: ROBOT_ID,
      itemKey: 'harvestCount',
      value: 1,
      observedAt: at(10),
    });
    const unknown = (itemKey: string): Observation => ({ ...known, itemKey });
    await save(context, [unknown('zeta'), unknown('alpha'), known]);

    const { items } = await fetchMeasurements(context);

    expect(items[0]?.items.map((item) => item.itemKey)).toEqual(['harvestCount', 'alpha', 'zeta']);
  });

  it.each([
    ['desc', 'to'],
    ['asc', 'from'],
  ] as const)(
    '次のページの続きと、利用者が指定した期間（%s の向きの %s）を、組み合わせても、範囲の外を返さない',
    async (direction, edge) => {
      const context = await withEquipment();
      const all: Observation[] = [];
      for (let minute = 1; minute <= 6; minute += 1) {
        all.push(...robotMeasurement(minute));
      }
      await save(context, all);
      // 続きの位置（前のページの最後の日時）より、期間の端の方が、手前にある場合も、先にある場合も
      const query = (limit: number, bound: number, cursor?: string) =>
        `?limit=${String(limit)}&direction=${direction}&${edge}=${encodeURIComponent(at(bound))}${
          cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`
        }`;

      const minutesOf = (items: Measurement[]) =>
        items.map((item) => (Date.parse(item.observedAt) - BASE_MS) / 60_000);
      // 期間の端が、続きの位置より、内側（新しい順: 終了 2 分・続き 5 分 / 古い順: 開始 5 分・続き 2 分）にあれば、期間の端が効く
      const inner = await fetchMeasurements(
        context,
        query(1, direction === 'desc' ? 2 : 5, direction === 'desc' ? at(5) : at(2)),
      );
      // 期間の端が、続きの位置より、外側（新しい順: 終了 6 分・続き 3 分 / 古い順: 開始 1 分・続き 4 分）にあれば、続きの位置が効く
      const outer = await fetchMeasurements(
        context,
        query(1, direction === 'desc' ? 6 : 1, direction === 'desc' ? at(3) : at(4)),
      );

      expect(minutesOf(inner.items)).toEqual(direction === 'desc' ? [2] : [5]);
      expect(minutesOf(outer.items)).toEqual(direction === 'desc' ? [2] : [5]);
    },
  );

  it('絞り込みで選んだ計測の全項目を取り直したとき、観測値が見つからなければ（取得の間に消えた）、一致した項目だけを返す', async () => {
    const context = await withEquipment();
    await save(context, robotMeasurement(10));
    const { observations } = context.container.repositories;
    const original = observations.query.bind(observations);
    vi.spyOn(observations, 'query').mockImplementation((filter, page, sort) =>
      filter.from !== undefined && filter.from.getTime() === filter.to?.getTime()
        ? Promise.resolve({ items: [], nextCursor: null })
        : original(filter, page, sort),
    );

    const { items } = await fetchMeasurements(context, '?category=OPERATION');

    // 稼働情報の 2 項目（稼働時間・待機時間）だけ
    expect(items[0]?.items.map((item) => item.itemKey)).toEqual(['operatingHours', 'standbyHours']);
  });
});

describe('1 回の読み取りの大きさを超える量（サービスの直接の呼び出し）', () => {
  it('閲覧範囲を指定しなければ全設備。1 回の読み取り（最大 500 行）で、ページの分が、そろわなければ、続きを読む', async () => {
    const context = await withEquipment();
    const all: Observation[] = [];
    // 3 項目 × 600 回 = 1,800 行。1 回の読み取り（500 行 = 166 回の計測）では、190 回の計測にならない
    for (let minute = 1; minute <= 600; minute += 1) {
      all.push(...robotMeasurement(minute));
    }
    await save(context, all);

    const first = await context.container.observationQuery.listMeasurements({
      direction: 'desc',
      limit: 190,
    });
    const second = await context.container.observationQuery.listMeasurements({
      direction: 'desc',
      limit: 190,
      ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
    });

    expect(first.items).toHaveLength(190);
    expect(first.items.every((item) => item.items.length === 3)).toBe(true);
    expect(first.nextCursor).toBe(first.items.at(-1)?.observedAt);
    expect(second.items).toHaveLength(190);
    expect(second.items[0]?.observedAt).not.toBe(first.items.at(-1)?.observedAt);
  });
});
