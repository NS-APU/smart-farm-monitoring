/**
 * 「現在」（短期の評価）だけの同期評価（`evaluateCurrent`。Issue #591）の結合テスト。
 * 手動入力の保存の直後（AWS の `EVALUATION_ON_WRITE=deferred`）に、影響する設備とハウスの、短期の評価だけを、直近 7 日の観測値で行う。
 * - 短期の結果は、全期間を読む定期の評価（`evaluateAll`）の、短期の結果と一致する
 * - 保存するのは、短期の結果だけ（長期の結果は、触らない）。ハウスの結果は、配下の設備の短期の結果の最悪
 * - 状態の変化の処理（通知・連携・変化の記録）は、行わない（定期の評価に任せる）
 * - 読む観測値は、直近 7 日分（90 日分でない）
 */

import { describe, expect, it, vi } from 'vitest';
import type { EvaluationResult } from '@smart-farm/shared/schemas/evaluation';
import { toUserId } from '@smart-farm/shared/schemas/common';
import { CUMULATIVE_ITEM_KEYS } from '@smart-farm/shared/constants/items';
import { MS_PER_HOUR } from '@smart-farm/shared/time';
import {
  equipmentSet,
  FACILITY_ID,
  observation,
  ROBOT_ID,
  SENSOR_ID,
  STATUS_CODE_FIXTURES,
  type ObservationOverrides,
} from '../support/builders.ts';
import { createTestContext, TEST_NOW, TEST_USER } from '../support/test-context.ts';

const HOUR_MS = MS_PER_HOUR;

function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** 合成の観測値（直近 6 日。ロボットの累積の項目・ステータスコード、センサーの環境の項目。手動入力と自動取り込みが重なる）。 */
function dataset(seed: number): ObservationOverrides[] {
  const random = createRandom(seed);
  const counters = new Map<string, number>();
  const rows: ObservationOverrides[] = [];
  for (let index = 0; index < 400; index += 1) {
    const observedAt = new Date(
      TEST_NOW.getTime() - (1 + Math.floor(random() * 6 * 24)) * HOUR_MS,
    ).toISOString();
    const source = random() < 0.25 ? 'MANUAL' : 'AUTO_IMPORT';
    const kind = random();
    if (kind < 0.15) {
      rows.push({
        equipmentId: ROBOT_ID,
        itemKey: 'statusCode',
        value: STATUS_CODE_FIXTURES[Math.floor(random() * STATUS_CODE_FIXTURES.length)]?.code ?? '',
        observedAt,
        source,
      });
    } else if (kind < 0.65) {
      const itemKey =
        CUMULATIVE_ITEM_KEYS[Math.floor(random() * CUMULATIVE_ITEM_KEYS.length)] ?? '';
      const counterKey = `${itemKey}#${source}`;
      const previous = counters.get(counterKey) ?? 0;
      const value =
        random() < 0.05 ? Math.floor(random() * 5) : previous + Math.floor(random() * 10);
      counters.set(counterKey, value);
      rows.push({ equipmentId: ROBOT_ID, itemKey, value, observedAt, source });
    } else {
      rows.push({
        equipmentId: SENSOR_ID,
        itemKey: random() < 0.5 ? 'temperatureCelsius' : 'humidityPercent',
        value: Math.floor(random() * 50),
        observedAt,
        source,
      });
    }
  }
  return rows;
}

async function setup(rows: readonly ObservationOverrides[] = []) {
  const context = await createTestContext();
  for (const equipment of equipmentSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  await context.container.repositories.observations.saveMany(rows.map(observation));
  return context;
}

type Context = Awaited<ReturnType<typeof setup>>;

async function resultsOf(
  context: Context,
  horizon?: 'SHORT' | 'LONG',
): Promise<EvaluationResult[]> {
  const all = await Promise.all(
    [FACILITY_ID, ROBOT_ID, SENSOR_ID].map((id) =>
      context.container.repositories.evaluations.listLatest(id),
    ),
  );
  return all
    .flat()
    .filter((result) => horizon === undefined || result.horizon === horizon)
    .sort((left, right) =>
      `${left.equipmentId}#${left.viewpointId}#${left.horizon}#${String(left.periodDays)}`.localeCompare(
        `${right.equipmentId}#${right.viewpointId}#${right.horizon}#${String(right.periodDays)}`,
      ),
    );
}

describe('「現在」（短期の評価）だけの同期評価', () => {
  it.each([1, 2, 3, 4])(
    '短期の結果は、全期間を読む定期の評価（evaluateAll）の短期の結果と、すべての項目が一致する（データセット %i。ハウスの集約を含む）',
    async (seed) => {
      const rows = dataset(seed);
      const reference = await setup(rows);
      const current = await setup(rows);

      await reference.container.evaluationService.evaluateAll('DEV');
      await current.container.evaluationService.evaluateCurrent('MANUAL_ENTRY', [
        ROBOT_ID,
        SENSOR_ID,
      ]);

      const expected = await resultsOf(reference, 'SHORT');
      const actual = await resultsOf(current);
      expect(actual).toEqual(expected);
      // ハウスの結果（配下の設備の最悪）を含み、「不明」だけに偏っていない
      expect(actual.some((result) => result.equipmentId === FACILITY_ID)).toBe(true);
      expect(new Set(actual.map((result) => result.status)).size).toBeGreaterThanOrEqual(2);
    },
  );

  it('保存するのは、短期の結果だけ。長期の結果は、触らない（評価の日時も、そのまま）', async () => {
    const context = await setup(dataset(5));
    await context.container.evaluationService.evaluateAll('DEV');
    const before = await resultsOf(context, 'LONG');
    context.clock.advance(5 * 60_000);

    await context.container.evaluationService.evaluateCurrent('MANUAL_ENTRY', [ROBOT_ID]);

    expect(await resultsOf(context, 'LONG')).toEqual(before);
    const short = await resultsOf(context, 'SHORT');
    const now = context.clock.now().toISOString();
    // 対象の設備（ロボット）と、それを含むハウスの短期の結果が、更新される。対象でないセンサーの短期の結果は、そのまま
    const updated = short.filter((result) => result.evaluatedAt === now);
    expect(new Set(updated.map((result) => result.equipmentId))).toEqual(
      new Set([ROBOT_ID, FACILITY_ID]),
    );
    expect(
      short
        .filter((result) => result.equipmentId === SENSOR_ID)
        .every((result) => result.evaluatedAt !== now),
    ).toBe(true);
  });

  it('観点ごとの短期の結果は、短期を持つ観点だけ（短期を持たない観点の結果は、作らない）', async () => {
    const context = await setup(dataset(6));

    await context.container.evaluationService.evaluateCurrent('MANUAL_ENTRY', [
      ROBOT_ID,
      SENSOR_ID,
    ]);

    const results = await resultsOf(context);
    expect(
      results.every((result) => result.horizon === 'SHORT' && result.periodDays === null),
    ).toBe(true);
    const viewpoints = new Set(results.map((result) => result.viewpointId));
    for (const notShort of ['costEfficiency', 'durability', 'dataUtilization', 'satisfaction']) {
      expect(viewpoints.has(notShort as never)).toBe(false);
    }
    expect(viewpoints.has('harvestAccuracy')).toBe(true);
    expect(viewpoints.has('environmentalAdaptability')).toBe(true);
  });

  it('状態の変化の処理（通知・連携・変化の記録）は、行わない。異常になっても、通知は、定期の評価に任せる', async () => {
    const context = await setup([
      {
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 40,
        observedAt: new Date(TEST_NOW.getTime() - HOUR_MS).toISOString(),
      },
    ]);

    const summary = await context.container.evaluationService.evaluateCurrent('MANUAL_ENTRY', [
      SENSOR_ID,
    ]);

    expect(summary).toMatchObject({ statusChanges: 0, notificationsCreated: 0 });
    const environmental = await context.container.repositories.evaluations.getLatest(
      SENSOR_ID,
      'environmentalAdaptability',
      'SHORT',
      null,
    );
    expect(environmental?.status).toBe('ERROR');
    const notifications = await context.container.repositories.notifications.list(
      toUserId(TEST_USER.userId),
      {},
      { limit: 10 },
    );
    expect(notifications.items).toEqual([]);
    expect(
      await context.container.repositories.evaluations.getLastStatusChange(
        SENSOR_ID,
        'environmentalAdaptability',
      ),
    ).toBeUndefined();
    // そのあとの定期の評価が、状態の変化を扱い、通知する
    await context.container.evaluationService.evaluateAll('DEV');
    const after = await context.container.repositories.notifications.list(
      toUserId(TEST_USER.userId),
      {},
      { limit: 10 },
    );
    expect(after.items.length).toBeGreaterThan(0);
  });

  it('読む観測値は、直近 7 日分（定期の評価の 90 日分でない）', async () => {
    const context = await setup(dataset(7));
    const spy = vi.spyOn(context.container.repositories.observations, 'findForEvaluation');

    await context.container.evaluationService.evaluateCurrent('MANUAL_ENTRY', [ROBOT_ID]);

    expect(spy).toHaveBeenCalled();
    for (const [, from, to] of spy.mock.calls) {
      expect((to.getTime() - from.getTime()) / HOUR_MS).toBe(7 * 24);
    }
  });

  it('遅れて終わった古い評価は、新しい「現在」を上書きしない（評価の日時が新しい結果が残る）', async () => {
    const context = await setup(dataset(8));
    await context.container.evaluationService.evaluateCurrent('MANUAL_ENTRY', [SENSOR_ID]);
    const newer = await resultsOf(context, 'SHORT');
    // 古い日時の結果を、あとから保存しても、残らない
    for (const result of newer) {
      await context.container.repositories.evaluations.saveLatest({
        ...result,
        status: 'UNKNOWN',
        evaluatedAt: new Date(Date.parse(result.evaluatedAt) - 60_000).toISOString(),
      });
    }

    expect(await resultsOf(context, 'SHORT')).toEqual(newer);
  });
});
