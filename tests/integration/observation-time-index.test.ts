/**
 * 観測値の一覧（計測日時の順）の結合テスト。計測日時の順の索引（保存のたびに、新しい一意キーだけを覚え、参照のときにまとめて加える）を使っても、
 * 全件を並べ替えた場合と同じ結果（順序・ページ分割・絞り込み）になること。
 */

import { describe, expect, it } from 'vitest';
import { observationKey, type Observation } from '../../src/shared/schemas/observation.ts';
import { createLocalRepositories } from '../../src/backend/infrastructure/local/local-repositories.ts';
import { must, observation, ROBOT_ID, SENSOR_ID } from '../support/builders.ts';

const BASE_MS = Date.parse('2026-10-01T00:00:00.000Z');

/** 計測日時が同じ観測値を複数持つ（同じ日時は、一意キーの昇順）。 */
function makeObservations(count: number, offsetMinutes = 0): Observation[] {
  return Array.from({ length: count }, (_, index) =>
    observation({
      equipmentId: index % 2 === 0 ? ROBOT_ID : SENSOR_ID,
      itemKey: index % 2 === 0 ? 'harvestCount' : 'temperatureCelsius',
      value: index,
      // 2件ずつ同じ日時
      observedAt: new Date(
        BASE_MS + (Math.floor(index / 2) + offsetMinutes) * 60_000,
      ).toISOString(),
    }),
  );
}

/** 全件を、計測日時の順（同じ日時は一意キーの昇順）に並べた結果。 */
function reference(items: readonly Observation[], direction: 'asc' | 'desc'): Observation[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...items].sort(
    (left, right) =>
      sign * left.observedAt.localeCompare(right.observedAt) ||
      observationKey(left).localeCompare(observationKey(right)),
  );
}

async function allPages(
  repository: ReturnType<typeof createLocalRepositories>['repositories']['observations'],
  direction: 'asc' | 'desc',
  limit: number,
  filter: Parameters<typeof repository.query>[0] = {},
): Promise<Observation[]> {
  const found: Observation[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await repository.query(
      filter,
      { limit, cursor },
      { key: 'observedAt', direction },
    );
    found.push(...page.items);
    if (page.nextCursor === null) {
      return found;
    }
    cursor = page.nextCursor;
  }
}

describe('観測値の一覧の計測日時の順（索引）', () => {
  it('降順・昇順とも、全件を並べ替えた結果と同じ順序でページ分割する（同じ日時は一意キーの昇順）', async () => {
    const { repositories } = createLocalRepositories();
    const items = makeObservations(41);
    await repositories.observations.saveMany(items.slice(20));
    await repositories.observations.saveMany(items.slice(0, 20));

    for (const direction of ['desc', 'asc'] as const) {
      const found = await allPages(repositories.observations, direction, 7);
      expect(found.map(observationKey)).toEqual(reference(items, direction).map(observationKey));
    }
  });

  it('索引ができたあとに保存した観測値（新しい一意キー・上書き）も、次の一覧に反映する', async () => {
    const { repositories } = createLocalRepositories();
    const items = makeObservations(10);
    await repositories.observations.saveMany(items);
    expect(await allPages(repositories.observations, 'desc', 4)).toHaveLength(10);

    const added = makeObservations(6, 100);
    const overwritten = { ...must(items[3]), value: 999, isDeleted: true };
    // 同じ一意キーを2回含める（索引に重複を作らない）
    await repositories.observations.saveMany([...added, ...added.slice(0, 2), overwritten]);

    const found = await allPages(repositories.observations, 'desc', 4);
    const expected = reference([...items.filter((_, index) => index !== 3), ...added], 'desc');
    expect(found.map(observationKey)).toEqual(expected.map(observationKey));
    const withDeleted = await repositories.observations.query(
      { includeDeleted: true },
      { limit: 100 },
    );
    expect(withDeleted.items.find((item) => item.value === 999)?.isDeleted).toBe(true);
  });

  it('一度に多数（索引へ併合する件数）を保存しても、同じ順序になる', async () => {
    const { repositories } = createLocalRepositories();
    const first = makeObservations(20);
    await repositories.observations.saveMany(first);
    await repositories.observations.query({}, { limit: 1 });

    const many = makeObservations(5200, 50);
    await repositories.observations.saveMany(many);

    const page = await repositories.observations.query({}, { limit: 30 });
    expect(page.items.map(observationKey)).toEqual(
      reference([...first, ...many], 'desc')
        .slice(0, 30)
        .map(observationKey),
    );
    const ascending = await repositories.observations.query(
      {},
      { limit: 30 },
      { key: 'observedAt', direction: 'asc' },
    );
    expect(ascending.items.map(observationKey)).toEqual(
      reference([...first, ...many], 'asc')
        .slice(0, 30)
        .map(observationKey),
    );
  });

  it('設備・期間などの絞り込みと、先のページ（オフセット）も、全件を絞り込んで並べ替えた結果と同じ', async () => {
    const { repositories } = createLocalRepositories();
    const items = makeObservations(60);
    await repositories.observations.saveMany(items);
    const from = new Date(BASE_MS + 5 * 60_000);
    const to = new Date(BASE_MS + 20 * 60_000);

    const found = await allPages(repositories.observations, 'desc', 5, {
      equipmentIds: [ROBOT_ID],
      from,
      to,
    });

    const expected = reference(
      items.filter(
        (item) =>
          item.equipmentId === ROBOT_ID &&
          item.observedAt >= from.toISOString() &&
          item.observedAt <= to.toISOString(),
      ),
      'desc',
    );
    expect(found.map(observationKey)).toEqual(expected.map(observationKey));
    expect(found.length).toBeGreaterThan(5);
  });

  it('全消去のあとは、索引も空になり、新しく保存した観測値だけを返す', async () => {
    const { repositories, store } = createLocalRepositories();
    await repositories.observations.saveMany(makeObservations(8));
    await repositories.observations.query({}, { limit: 1 });

    store.clear();
    expect((await repositories.observations.query({}, { limit: 10 })).items).toEqual([]);
    await repositories.observations.saveMany(makeObservations(3));

    expect((await repositories.observations.query({}, { limit: 10 })).items).toHaveLength(3);
  });

  it('不正なカーソルは、入力不正として拒否する', async () => {
    const { repositories } = createLocalRepositories();
    await repositories.observations.saveMany(makeObservations(3));

    await expect(repositories.observations.query({}, { limit: 5, cursor: '!!' })).rejects.toThrow(
      'cursor が不正です',
    );
  });
});
