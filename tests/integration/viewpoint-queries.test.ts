/**
 * 観点の詳細（UC-02・UC-04・UC-21。SC-03・SC-04）、推移（UC-03）、観測値の一覧（元データ。FR-6.4）の結合テスト。
 * Hono アプリ（app.request）から、評価の結果を読む。値は同値分割（正常・注意・異常・不明）と、境界値で選ぶ。
 */

import { describe, expect, it } from 'vitest';
import { satisfactionItemKey } from '../../src/shared/constants/items.ts';
import { SATISFACTION_TARGET_VIEWPOINT_IDS } from '../../src/shared/constants/viewpoints.ts';
import { ErrorResponseSchema } from '../../src/shared/schemas/api.ts';
import {
  DashboardResponseSchema,
  SeriesResponseSchema,
  ViewpointDetailResponseSchema,
} from '../../src/shared/schemas/evaluation.ts';
import { ObservationListResponseSchema } from '../../src/shared/schemas/observation.ts';
import { toEquipmentId } from '../../src/shared/schemas/common.ts';
import { getDefaultCriteria } from '../../src/backend/domain/evaluation/default-criteria.ts';
import { CUSTOM_CRITERIA_NOTE } from '../../src/backend/domain/evaluation/messages.ts';
import {
  equipmentSet,
  FACILITY_ID,
  must,
  observation,
  ROBOT_ID,
  SENSOR_ID,
  type ObservationOverrides,
} from '../support/builders.ts';
import { createTestContext, TEST_NOW } from '../support/test-context.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

async function setup() {
  const context = await createTestContext();
  for (const equipment of equipmentSet()) {
    await context.container.repositories.equipment.save(equipment);
  }
  return context;
}

type Context = Awaited<ReturnType<typeof setup>>;

function hoursAgo(hours: number): string {
  return new Date(TEST_NOW.getTime() - hours * HOUR_MS).toISOString();
}

async function seed(context: Context, rows: readonly ObservationOverrides[]): Promise<void> {
  await context.container.repositories.observations.saveMany(rows.map(observation));
  await context.container.evaluationService.evaluateAll('DEV');
}

/** 環境センサーの4指標（正常な値）。温度のみ、引数で変える。 */
function environment(temperature: number, observedAt = hoursAgo(1)): ObservationOverrides[] {
  return [
    { equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: temperature, observedAt },
    { equipmentId: SENSOR_ID, itemKey: 'humidityPercent', value: 60, observedAt },
    { equipmentId: SENSOR_ID, itemKey: 'illuminanceLux', value: 30_000, observedAt },
    { equipmentId: SENSOR_ID, itemKey: 'co2Ppm', value: 900, observedAt },
  ];
}

async function get(context: Context, path: string) {
  const response = await context.request(path);
  return { status: response.status, body: await response.json() };
}

async function detailOf(context: Context, query = '', viewpointId = 'environmentalAdaptability') {
  const { status, body } = await get(context, `/viewpoints/${viewpointId}?${query}`);
  expect(status).toBe(200);
  return ViewpointDetailResponseSchema.parse(body);
}

async function seriesOf(context: Context, query = '', viewpointId = 'environmentalAdaptability') {
  const { status, body } = await get(context, `/viewpoints/${viewpointId}/series?${query}`);
  expect(status).toBe(200);
  return SeriesResponseSchema.parse(body);
}

async function errorCodeOf(context: Context, path: string): Promise<string> {
  const response = await context.request(path);
  return ErrorResponseSchema.parse(await response.json()).error.code;
}

describe('観点の詳細（UC-02。GET /viewpoints/{id}）', () => {
  it('診断結果・根拠のメトリクスと指標ごとの判定・判断基準・短期と長期の判定の対象期間を、スキーマに合う形で返す', async () => {
    const context = await setup();
    await seed(context, environment(20));

    const detail = await detailOf(context);

    expect(detail).toMatchObject({
      equipmentId: FACILITY_ID,
      viewpointId: 'environmentalAdaptability',
      name: '環境適応性',
      horizon: 'LONG',
      periodDays: 7,
      horizonUsed: 'LONG',
      hasShortHorizon: true,
      status: 'NORMAL',
      isEvaluated: true,
      usesStatusIndicator: false,
      radar: null,
    });
    expect(detail.metrics.map((row) => [row.metricId, row.value, row.indicatorStatus])).toEqual([
      ['temperatureCelsius', 20, 'NORMAL'],
      ['humidityPercent', 60, 'NORMAL'],
      ['illuminanceLux', 30_000, 'NORMAL'],
      ['co2Ppm', 900, 'NORMAL'],
    ]);
    expect(detail.metrics.every((row) => row.isPrimary)).toBe(true);
    expect(detail.criteria).toMatchObject({ isDefault: true, version: 'DEFAULT' });
    expect(detail.criteria.criteria).toHaveLength(4);
    expect(detail.selected).toMatchObject({
      horizon: 'LONG',
      periodDays: 7,
      status: 'NORMAL',
      isCustomCriteria: false,
      evaluatedTo: TEST_NOW.toISOString(),
      evaluatedFrom: new Date(TEST_NOW.getTime() - 7 * DAY_MS).toISOString(),
    });
    expect(detail.selected?.diagnosticMessage).toContain('温度 20.0℃（正常）');
    expect(detail.short).toMatchObject({
      horizon: 'SHORT',
      periodDays: null,
      evaluatedFrom: new Date(TEST_NOW.getTime() - DAY_MS).toISOString(),
    });
    expect(detail.long?.periodDays).toBe(7);
  });

  it.each([
    // 正常・注意・異常の同値クラスの代表値
    [20, 'NORMAL'],
    [27, 'CAUTION'],
    [5, 'CAUTION'],
    [40, 'ERROR'],
    [-5, 'ERROR'],
    // 境界値（10℃以上25℃未満が正常、0℃以上35℃未満が注意以内）
    [10, 'NORMAL'],
    [9.9, 'CAUTION'],
    [24.9, 'NORMAL'],
    [25, 'CAUTION'],
    [34.9, 'CAUTION'],
    [35, 'ERROR'],
    [0, 'CAUTION'],
    [-0.1, 'ERROR'],
  ] as const)('温度 %s℃ なら、環境適応性は %s', async (temperature, expected) => {
    const context = await setup();
    await seed(context, environment(temperature));

    const detail = await detailOf(context);

    expect(detail.status).toBe(expected);
    expect(detail.metrics.find((row) => row.metricId === 'temperatureCelsius')).toMatchObject({
      value: temperature,
      indicatorStatus: expected,
    });
  });

  it('複数の指標は、最も悪い判定を観点のステータスにする（湿度が異常なら、温度が正常でも異常）', async () => {
    const context = await setup();
    await seed(context, [
      ...environment(20).filter((row) => row.itemKey !== 'humidityPercent'),
      { equipmentId: SENSOR_ID, itemKey: 'humidityPercent', value: 95, observedAt: hoursAgo(1) },
    ]);

    const detail = await detailOf(context);

    expect(detail.status).toBe('ERROR');
    expect(detail.metrics.map((row) => row.indicatorStatus)).toEqual([
      'NORMAL',
      'ERROR',
      'NORMAL',
      'NORMAL',
    ]);
  });

  it('一部の指標だけ取得できていれば、取得できた指標だけで判定し、欠けた指標は値なし・判定なしにする', async () => {
    const context = await setup();
    await seed(context, [
      { equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 27, observedAt: hoursAgo(1) },
    ]);

    const detail = await detailOf(context);

    expect(detail.status).toBe('CAUTION');
    expect(detail.metrics.map((row) => [row.metricId, row.value, row.indicatorStatus])).toEqual([
      ['temperatureCelsius', 27, 'CAUTION'],
      ['humidityPercent', null, 'UNKNOWN'],
      ['illuminanceLux', null, 'UNKNOWN'],
      ['co2Ppm', null, 'UNKNOWN'],
    ]);
  });

  it('評価に必要なデータがなければ、不明とし、データ不足の旨・欠けた項目・取得と入力を確認する推奨アクションを返す', async () => {
    const context = await setup();
    await seed(context, []);

    const detail = await detailOf(context, '', 'harvestAccuracy');

    expect(detail.status).toBe('UNKNOWN');
    expect(detail.isEvaluated).toBe(true);
    expect(detail.selected?.diagnosticMessage).toContain('データ不足のため評価できません');
    expect(detail.selected?.diagnosticMessage).toContain('未取得の項目');
    expect(detail.selected?.recommendedAction).toContain('データの取得・入力を確認');
    expect(detail.metrics.every((row) => row.value === null)).toBe(true);
  });

  it('分母が 0（収穫数 0）の場合は、不明とし、算出できない指標を示す', async () => {
    const context = await setup();
    await seed(context, [
      { equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 0, observedAt: hoursAgo(1) },
      { equipmentId: ROBOT_ID, itemKey: 'damagedFruitCount', value: 0, observedAt: hoursAgo(1) },
      { equipmentId: ROBOT_ID, itemKey: 'wrongHarvestCount', value: 0, observedAt: hoursAgo(1) },
      { equipmentId: ROBOT_ID, itemKey: 'missedFruitCount', value: 0, observedAt: hoursAgo(1) },
    ]);

    const detail = await detailOf(context, '', 'harvestAccuracy');

    expect(detail.status).toBe('UNKNOWN');
    expect(detail.selected?.diagnosticMessage).toContain('算出できない指標');
  });

  it('評価がまだ保存されていなければ、評価前（isEvaluated=false）として、値のないメトリクスと不明を返す', async () => {
    const context = await setup();

    const detail = await detailOf(context);

    expect(detail).toMatchObject({
      status: 'UNKNOWN',
      isEvaluated: false,
      selected: null,
      short: null,
      long: null,
    });
    expect(detail.metrics.every((row) => row.value === null && row.indicatorStatus === null)).toBe(
      true,
    );
  });

  it('短期視点を指定すると、短期の診断結果・メトリクスを返す（短期は最新の観測値）', async () => {
    const context = await setup();
    await seed(context, [...environment(20, hoursAgo(30)), ...environment(40, hoursAgo(1))]);

    const shortDetail = await detailOf(context, 'horizon=SHORT');
    const longDetail = await detailOf(context, 'horizon=LONG');

    expect(shortDetail).toMatchObject({ horizon: 'SHORT', horizonUsed: 'SHORT' });
    expect(shortDetail.selected?.horizon).toBe('SHORT');
    expect(shortDetail.metrics[0]).toMatchObject({ value: 40, indicatorStatus: 'ERROR' });
    // 長期は平均（7日: 20 と 40 の平均 30）
    expect(longDetail.metrics[0]).toMatchObject({ value: 30, indicatorStatus: 'CAUTION' });
    // 観点のステータスは、短期・長期のうち悪い方（短期が異常）
    expect(longDetail.status).toBe('ERROR');
  });

  it.each(['costEfficiency', 'durability', 'dataUtilization'] as const)(
    '短期評価を持たない観点（%s）は、短期を指定しても長期の結果を返し、短期は null',
    async (viewpointId) => {
      const context = await setup();
      await seed(context, []);

      const detail = await detailOf(context, 'horizon=SHORT', viewpointId);

      expect(detail).toMatchObject({
        hasShortHorizon: false,
        horizon: 'SHORT',
        horizonUsed: 'LONG',
        short: null,
      });
      expect(detail.selected?.horizon).toBe('LONG');
    },
  );

  it.each([1, 7, 30, 60, 90] as const)(
    '長期の期間 %s 日を選ぶと、その期間の結果を返す',
    async (days) => {
      const context = await setup();
      await seed(context, environment(20));

      const detail = await detailOf(context, `periodDays=${String(days)}`);

      expect(detail.periodDays).toBe(days);
      expect(detail.selected?.periodDays).toBe(days);
      expect(detail.selected?.evaluatedFrom).toBe(
        new Date(TEST_NOW.getTime() - days * DAY_MS).toISOString(),
      );
    },
  );

  it('期間によって結果が変わる（直近は正常でも、30日平均は注意）', async () => {
    const context = await setup();
    await seed(context, [
      ...environment(20, hoursAgo(2)),
      ...environment(30, hoursAgo(10 * 24)),
      ...environment(30, hoursAgo(15 * 24)),
      ...environment(30, hoursAgo(20 * 24)),
    ]);

    const week = await detailOf(context, 'periodDays=7');
    const month = await detailOf(context, 'periodDays=30');

    expect(week.metrics[0]).toMatchObject({ value: 20, indicatorStatus: 'NORMAL' });
    expect(month.metrics[0]).toMatchObject({ value: 27.5, indicatorStatus: 'CAUTION' });
  });

  it('ステータスコードで判定する観点は、ステータスコードの名称（カテゴリ名ではなく）を返す', async () => {
    const context = await setup();
    await seed(context, [
      {
        equipmentId: ROBOT_ID,
        itemKey: 'harvestOperatingHours',
        value: 1,
        observedAt: hoursAgo(1),
      },
      {
        equipmentId: ROBOT_ID,
        itemKey: 'travelStoppedHours',
        value: 0.02,
        observedAt: hoursAgo(1),
      },
      { equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 100, observedAt: hoursAgo(1) },
      {
        equipmentId: ROBOT_ID,
        itemKey: 'statusCode',
        value: 'HARVEST_ERROR',
        observedAt: hoursAgo(1),
      },
    ]);

    const detail = await detailOf(context, '', 'harvestSpeed');

    expect(detail.usesStatusIndicator).toBe(true);
    expect(detail.selected?.statusDetail).toEqual({
      code: 'HARVEST_ERROR',
      name: '収穫異常',
      category: 'ERROR',
    });
    expect(detail.status).toBe('ERROR');
    expect(detail.selected?.diagnosticMessage).toContain('ステータス 収穫異常（異常）');
  });

  it('変更した判断基準による判定は、変更済みの判断基準と、その旨の診断メッセージを返す', async () => {
    const context = await setup();
    const defaults = getDefaultCriteria('environmentalAdaptability');
    await context.container.repositories.criteria.save({
      ...defaults,
      version: 'V2',
      isDefault: false,
      criteria: defaults.criteria.map((criterion) =>
        criterion.indicator === 'temperatureCelsius' && criterion.kind === 'RANGE'
          ? { ...criterion, thresholds: { ...criterion.thresholds, normalUpper: 30 } }
          : criterion,
      ),
    });
    await seed(context, environment(27));

    const detail = await detailOf(context);

    expect(detail.criteria).toMatchObject({ isDefault: false, version: 'V2' });
    expect(detail.status).toBe('NORMAL');
    expect(detail.selected?.isCustomCriteria).toBe(true);
    expect(detail.selected?.diagnosticMessage).toContain(CUSTOM_CRITERIA_NOTE);
  });

  it('ロボットを指定すると、ロボットの観点を返す。その設備では評価しない観点は 404', async () => {
    const context = await setup();
    await seed(context, []);

    const robot = await get(context, `/viewpoints/harvestAccuracy?equipmentId=${ROBOT_ID}`);
    const sensorOnlyEnvironment = await get(
      context,
      `/viewpoints/environmentalAdaptability?equipmentId=${SENSOR_ID}`,
    );

    expect(robot.status).toBe(200);
    expect(sensorOnlyEnvironment.status).toBe(200);
    expect(await errorCodeOf(context, `/viewpoints/harvestAccuracy?equipmentId=${SENSOR_ID}`)).toBe(
      'NOT_FOUND',
    );
    expect(await errorCodeOf(context, `/viewpoints/satisfaction?equipmentId=${ROBOT_ID}`)).toBe(
      'NOT_FOUND',
    );
  });

  it.each([
    ['存在しない観点', '/viewpoints/unknown-viewpoint'],
    ['存在しない設備', '/viewpoints/safety?equipmentId=NOT-EXIST'],
  ])('%s は 404', async (_name, path) => {
    const context = await setup();

    expect(await errorCodeOf(context, path)).toBe('NOT_FOUND');
  });

  it('論理削除した設備は 404。設備が1つもなく、設備の指定もなければ 404', async () => {
    const context = await setup();
    const robot = must(equipmentSet().find((item) => item.equipmentId === ROBOT_ID));
    await context.container.repositories.equipment.save({ ...robot, isDeleted: true });
    const empty = await createTestContext();

    expect(await errorCodeOf(context, `/viewpoints/safety?equipmentId=${ROBOT_ID}`)).toBe(
      'NOT_FOUND',
    );
    expect(await errorCodeOf(empty, '/viewpoints/safety')).toBe('NOT_FOUND');
  });

  it.each(['horizon=MIDDLE', 'periodDays=5', 'periodDays=abc', 'equipmentId=%E6%97%A5%E6%9C%AC'])(
    'クエリが不正（%s）なら 400',
    async (query) => {
      const context = await setup();

      expect(await errorCodeOf(context, `/viewpoints/safety?${query}`)).toBe('VALIDATION_ERROR');
    },
  );
});

describe('満足度の詳細（UC-21。GET /viewpoints/satisfaction）', () => {
  function stars(scores: readonly number[], observedAt = hoursAgo(1)): ObservationOverrides[] {
    return SATISFACTION_TARGET_VIEWPOINT_IDS.flatMap((viewpointId, index) => {
      const score = scores[index];
      return score === undefined
        ? []
        : [
            {
              equipmentId: FACILITY_ID,
              itemKey: satisfactionItemKey(viewpointId),
              value: score,
              observedAt,
              source: 'MANUAL' as const,
            },
          ];
    });
  }

  it('9観点の満足度を軸ごとに返し、総合満足度（平均。小数第1位）を判定する', async () => {
    const context = await setup();
    await seed(context, stars([5, 4, 3, 4, 5, 4, 3, 4, 5]));

    const detail = await detailOf(context, '', 'satisfaction');

    expect(detail.radar).toHaveLength(9);
    expect(detail.radar?.map((point) => point.score)).toEqual([5, 4, 3, 4, 5, 4, 3, 4, 5]);
    expect(detail.radar?.[0]).toEqual({
      viewpointId: 'harvestAccuracy',
      name: '収穫精度',
      score: 5,
    });
    expect(detail.hasShortHorizon).toBe(false);
    // (5+4+3+4+5+4+3+4+5) / 9 = 4.111...
    expect(detail.metrics.find((row) => row.metricId === 'overallSatisfaction')).toMatchObject({
      value: 4.1,
      indicatorStatus: 'NORMAL',
    });
    expect(detail.status).toBe('NORMAL');
  });

  it.each([
    // 総合満足度 = 合計 ÷ 9（小数第1位）。4.0以上 正常／3.0以上 注意／3.0未満 異常
    [[5, 5, 5, 5, 5, 5, 5, 5, 5], 5, 'NORMAL'],
    [[4, 4, 4, 4, 4, 4, 4, 4, 4], 4, 'NORMAL'],
    [[4, 4, 4, 4, 4, 4, 4, 4, 3], 3.9, 'CAUTION'],
    [[3, 3, 3, 3, 3, 3, 3, 3, 3], 3, 'CAUTION'],
    [[3, 3, 3, 3, 3, 3, 3, 3, 2], 2.9, 'ERROR'],
    [[1, 1, 1, 1, 1, 1, 1, 1, 1], 1, 'ERROR'],
  ] as const)('満足度 %j なら、総合満足度 %s で %s', async (scores, overall, expected) => {
    const context = await setup();
    await seed(context, stars(scores));

    const detail = await detailOf(context, '', 'satisfaction');

    expect(detail.metrics.find((row) => row.metricId === 'overallSatisfaction')?.value).toBe(
      overall,
    );
    expect(detail.status).toBe(expected);
  });

  it('9観点のいずれかが未入力なら、不明とし、入力済みの軸の値と未入力の軸（null）を返す', async () => {
    const context = await setup();
    await seed(context, stars([5, 4, 3, 4, 5, 4, 3, 4]));

    const detail = await detailOf(context, '', 'satisfaction');

    expect(detail.status).toBe('UNKNOWN');
    expect(detail.radar?.map((point) => point.score)).toEqual([5, 4, 3, 4, 5, 4, 3, 4, null]);
    expect(detail.selected?.diagnosticMessage).toContain('データ不足のため評価できません');
  });

  it('満足度が1つも入力されていなければ、不明で、すべての軸が未入力', async () => {
    const context = await setup();
    await seed(context, []);

    const detail = await detailOf(context, '', 'satisfaction');

    expect(detail.status).toBe('UNKNOWN');
    expect(detail.radar?.every((point) => point.score === null)).toBe(true);
  });

  it('評価前でも、レーダーチャートの軸（未入力）を返す', async () => {
    const context = await setup();

    const detail = await detailOf(context, '', 'satisfaction');

    expect(detail.isEvaluated).toBe(false);
    expect(detail.radar).toHaveLength(9);
  });

  it('期間を選ぶと、その期間の満足度の平均で判定する', async () => {
    const context = await setup();
    await seed(context, [
      ...stars([5, 5, 5, 5, 5, 5, 5, 5, 5], hoursAgo(1)),
      ...stars([1, 1, 1, 1, 1, 1, 1, 1, 1], hoursAgo(10 * 24)),
    ]);

    const week = await detailOf(context, 'periodDays=7', 'satisfaction');
    const month = await detailOf(context, 'periodDays=30', 'satisfaction');

    expect(week.radar?.[0]?.score).toBe(5);
    expect(week.status).toBe('NORMAL');
    expect(month.radar?.[0]?.score).toBe(3);
    expect(month.status).toBe('CAUTION');
  });
});

describe('推移（UC-03。GET /viewpoints/{id}/series）', () => {
  it('短期は、直近24時間の1時間ごと（24区間）。観測値のない区間は欠損（null）で、期間の平均は値のある区間の平均', async () => {
    const context = await setup();
    await seed(context, [
      ...environment(20, hoursAgo(1)),
      ...environment(30, hoursAgo(5)),
      ...environment(10, hoursAgo(20)),
    ]);

    const series = await seriesOf(context, 'horizon=SHORT');

    expect(series).toMatchObject({
      equipmentId: FACILITY_ID,
      horizon: 'SHORT',
      horizonUsed: 'SHORT',
      periodDays: null,
      bucket: 'HOUR',
      hasShortHorizon: true,
      to: TEST_NOW.toISOString(),
    });
    const temperature = series.metrics.find((metric) => metric.metricId === 'temperatureCelsius');
    expect(temperature?.points).toHaveLength(24);
    expect(temperature?.points.filter((point) => point.value !== null)).toHaveLength(3);
    expect(temperature?.average).toBe(20);
    expect(temperature?.isPrimary).toBe(true);
    // 区間は1時間ごと（古い順）で、最後は評価時刻を含む1時間（12:00 JST 台）
    expect(temperature?.points.at(-1)?.at).toBe('2026-10-09T03:00:00.000Z');
    expect(temperature?.points[0]?.at).toBe('2026-10-08T04:00:00.000Z');
    expect(series.from).toBe('2026-10-08T04:00:00.000Z');
  });

  it('直近7日は、日本時間の日ごと（7区間。最後は今日）。日の境界（日本時間 0:00）の値は、新しい日に入る', async () => {
    const context = await setup();
    await seed(context, [
      // 2026-10-09 00:00 JST = 2026-10-08T15:00Z（今日の最初）
      ...environment(30, '2026-10-08T15:00:00.000Z'),
      // その1ミリ秒前は、前日
      ...environment(10, '2026-10-08T14:59:59.999Z'),
    ]);

    const series = await seriesOf(context, 'periodDays=7');

    expect(series).toMatchObject({ bucket: 'DAY', horizonUsed: 'LONG', periodDays: 7 });
    const temperature = series.metrics.find((metric) => metric.metricId === 'temperatureCelsius');
    expect(temperature?.points.map((point) => point.at)).toEqual([
      '2026-10-02T15:00:00.000Z',
      '2026-10-03T15:00:00.000Z',
      '2026-10-04T15:00:00.000Z',
      '2026-10-05T15:00:00.000Z',
      '2026-10-06T15:00:00.000Z',
      '2026-10-07T15:00:00.000Z',
      '2026-10-08T15:00:00.000Z',
    ]);
    expect(temperature?.points.map((point) => point.value)).toEqual([
      null,
      null,
      null,
      null,
      null,
      10,
      30,
    ]);
    expect(temperature?.average).toBe(20);
  });

  it.each([
    [1, 'HOUR', 24],
    [7, 'DAY', 7],
    [30, 'DAY', 30],
    [60, 'DAY', 60],
    [90, 'DAY', 90],
  ] as const)('期間 %s 日の推移は、%s 単位で %s 区間', async (days, bucket, count) => {
    const context = await setup();
    await seed(context, environment(20));

    const series = await seriesOf(context, `periodDays=${String(days)}`);

    expect(series.bucket).toBe(bucket);
    expect(series.metrics[0]?.points).toHaveLength(count);
    expect(series.periodDays).toBe(days);
  });

  it('データが1件もなければ、すべての区間が欠損で、平均も null（0 で代用しない）', async () => {
    const context = await setup();
    await seed(context, []);

    const series = await seriesOf(context);

    expect(series.metrics.every((metric) => metric.average === null)).toBe(true);
    expect(
      series.metrics.every((metric) => metric.points.every((point) => point.value === null)),
    ).toBe(true);
  });

  it('欠損・不正な値は使わず、遅延した値（受信が区間の後）は、受信済みなら、計測の区間に入れる。未受信の値は使わない', async () => {
    const context = await setup();
    await seed(context, [
      { equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 21, observedAt: hoursAgo(3) },
      {
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 22,
        observedAt: hoursAgo(5),
        receivedAt: hoursAgo(2),
        quality: 'LATE',
      },
      {
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 99,
        observedAt: hoursAgo(7),
        quality: 'INVALID',
      },
      {
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: null,
        observedAt: hoursAgo(9),
        quality: 'MISSING',
      },
      {
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 50,
        observedAt: hoursAgo(11),
        receivedAt: new Date(TEST_NOW.getTime() + HOUR_MS).toISOString(),
      },
    ]);

    const series = await seriesOf(context, 'horizon=SHORT');

    const temperature = series.metrics.find((metric) => metric.metricId === 'temperatureCelsius');
    expect(
      temperature?.points.filter((point) => point.value !== null).map((point) => point.value),
    ).toEqual([22, 21]);
  });

  it('割合のメトリクスは、区間ごとに、評価と同じ算出式で求める（収穫精度: 可販果率）', async () => {
    const context = await setup();
    const at = hoursAgo(2);
    await seed(context, [
      { equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 100, observedAt: at },
      { equipmentId: ROBOT_ID, itemKey: 'damagedFruitCount', value: 4, observedAt: at },
      { equipmentId: ROBOT_ID, itemKey: 'wrongHarvestCount', value: 1, observedAt: at },
      { equipmentId: ROBOT_ID, itemKey: 'missedFruitCount', value: 0, observedAt: at },
    ]);

    const series = await seriesOf(context, 'horizon=SHORT', 'harvestAccuracy');

    const rate = series.metrics.find((metric) => metric.metricId === 'marketableFruitRatePercent');
    expect(rate?.points.filter((point) => point.value !== null)).toEqual([
      { at: '2026-10-09T01:00:00.000Z', value: 95 },
    ]);
    expect(rate?.average).toBe(95);
    expect(series.metrics.map((metric) => metric.metricId)).toEqual([
      'marketableFruitRatePercent',
      'recognitionAccuracyPercent',
      'missedFruitRatePercent',
      'damagedFruitRatePercent',
    ]);
  });

  it.each(['costEfficiency', 'durability', 'satisfaction', 'dataUtilization'] as const)(
    '短期評価を持たない観点（%s）は、短期を指定しても長期の推移（日ごと）を返し、短期のフィードバックは null',
    async (viewpointId) => {
      const context = await setup();
      await seed(context, []);

      const series = await seriesOf(context, 'horizon=SHORT&periodDays=30', viewpointId);

      expect(series).toMatchObject({
        horizon: 'SHORT',
        horizonUsed: 'LONG',
        hasShortHorizon: false,
        periodDays: 30,
        bucket: 'DAY',
      });
      expect(series.feedback.short).toBeNull();
      expect(series.feedback.long?.periodDays).toBe(30);
    },
  );

  it('視点ごとのフィードバック（最新の診断メッセージ・推奨アクション）を、短期・長期で返す', async () => {
    const context = await setup();
    await seed(context, environment(40));

    const series = await seriesOf(context);

    expect(series.feedback.short).toMatchObject({ horizon: 'SHORT', status: 'ERROR' });
    expect(series.feedback.long).toMatchObject({ horizon: 'LONG', periodDays: 7, status: 'ERROR' });
    expect(series.feedback.long?.recommendedAction).toContain('対応が必要な状態です');
  });

  it('評価前は、フィードバックが null で、ステータスの推移も空', async () => {
    const context = await setup();

    const series = await seriesOf(context);

    expect(series.feedback).toEqual({ short: null, long: null });
    expect(series.statusHistory).toEqual({ initial: null, changes: [] });
  });

  it('ステータスの推移は、期間の開始時点のステータスと、期間内の変化を、古い順に返す', async () => {
    const context = await setup();
    // 20日前: 正常、5日前: 注意（27℃）、1日前: 異常（40℃）に変わる
    context.clock.set(new Date(TEST_NOW.getTime() - 20 * DAY_MS));
    await seed(context, environment(20, hoursAgo(20 * 24 + 1)));
    context.clock.set(new Date(TEST_NOW.getTime() - 5 * DAY_MS));
    await seed(context, environment(27, hoursAgo(5 * 24 + 1)));
    context.clock.set(new Date(TEST_NOW.getTime() - 1 * DAY_MS));
    await seed(context, environment(40, hoursAgo(1 * 24 + 1)));
    context.clock.set(TEST_NOW);

    const month = await seriesOf(context, 'periodDays=30');
    const week = await seriesOf(context, 'periodDays=7');

    // 30日の期間: 開始前の変化はなく、3回の変化が期間内
    expect(month.statusHistory.initial).toBeNull();
    expect(month.statusHistory.changes.map((change) => change.status)).toEqual([
      'NORMAL',
      'CAUTION',
      'ERROR',
    ]);
    // 7日の期間: 期間の開始時点は「正常」（20日前の変化）。期間内は 注意 → 異常
    expect(week.statusHistory.initial).toBe('NORMAL');
    expect(week.statusHistory.changes.map((change) => change.status)).toEqual(['CAUTION', 'ERROR']);
  });

  it('その設備では評価しない観点・存在しない観点・不正なクエリは、詳細と同じエラー', async () => {
    const context = await setup();

    expect(
      await errorCodeOf(context, `/viewpoints/harvestAccuracy/series?equipmentId=${SENSOR_ID}`),
    ).toBe('NOT_FOUND');
    expect(await errorCodeOf(context, '/viewpoints/unknown/series')).toBe('NOT_FOUND');
    expect(await errorCodeOf(context, '/viewpoints/safety/series?periodDays=3')).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('センサーを指定すると、センサーの観測値だけで、環境適応性の推移を返す', async () => {
    const context = await setup();
    await seed(context, [
      ...environment(20),
      {
        equipmentId: toEquipmentId('OTHER-EQUIPMENT'),
        itemKey: 'temperatureCelsius',
        value: 99,
        observedAt: hoursAgo(1),
      },
    ]);

    const series = await seriesOf(context, `equipmentId=${SENSOR_ID}&periodDays=7`);

    expect(series.equipmentId).toBe(SENSOR_ID);
    expect(series.metrics[0]?.average).toBe(20);
  });
});

describe('ダッシュボードのメトリクスごとの判定（UC-01。FR-6.2）', () => {
  it('主要メトリクスごとの判定（metricStatuses）を返し、評価前のカードは空', async () => {
    const context = await setup();
    const before = DashboardResponseSchema.parse((await get(context, '/dashboard')).body);
    await seed(context, [...environment(27).filter((row) => row.itemKey !== 'co2Ppm')]);

    const after = DashboardResponseSchema.parse((await get(context, '/dashboard')).body);

    expect(before.viewpoints.every((card) => Object.keys(card.metricStatuses).length === 0)).toBe(
      true,
    );
    const card = after.viewpoints.find((item) => item.viewpointId === 'environmentalAdaptability');
    expect(card?.metricStatuses).toEqual({
      temperatureCelsius: 'CAUTION',
      humidityPercent: 'NORMAL',
      illuminanceLux: 'NORMAL',
      co2Ppm: 'UNKNOWN',
    });
  });
});

describe('観測値の一覧（元データ。GET /observations）', () => {
  async function withData() {
    const context = await setup();
    await seed(context, [
      ...environment(20, hoursAgo(1)),
      { equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 100, observedAt: hoursAgo(2) },
      {
        equipmentId: ROBOT_ID,
        itemKey: 'damagedFruitCount',
        value: 3,
        observedAt: hoursAgo(3),
        source: 'MANUAL',
      },
      {
        equipmentId: ROBOT_ID,
        itemKey: 'statusCode',
        value: 'HARVESTING',
        observedAt: hoursAgo(4),
      },
      {
        equipmentId: ROBOT_ID,
        itemKey: 'operatingHours',
        value: 1,
        observedAt: hoursAgo(5),
        quality: 'LATE',
      },
    ]);
    return context;
  }

  async function list(context: Context, query = '') {
    const { status, body } = await get(context, `/observations?${query}`);
    expect(status).toBe(200);
    return ObservationListResponseSchema.parse(body);
  }

  it('設備を省略すると全設備、ハウスは配下のロボット・センサーを含み、ロボットはそのロボットのみ。新しい順', async () => {
    const context = await withData();

    const all = await list(context);
    const house = await list(context, `equipmentId=${FACILITY_ID}`);
    const robot = await list(context, `equipmentId=${ROBOT_ID}`);

    expect(all.items).toHaveLength(8);
    expect(house.items).toHaveLength(8);
    expect(robot.items).toHaveLength(4);
    expect(robot.items.every((item) => item.equipmentId === ROBOT_ID)).toBe(true);
    const times = all.items.map((item) => item.observedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('観点を指定すると、その観点の元データの項目だけを返す（環境適応性は環境の4項目、収穫精度は収穫の項目）', async () => {
    const context = await withData();

    const environmentRows = await list(context, 'viewpointId=environmentalAdaptability');
    const accuracyRows = await list(context, `viewpointId=harvestAccuracy&equipmentId=${ROBOT_ID}`);
    const dataUtilizationRows = await list(context, 'viewpointId=dataUtilization');

    expect(new Set(environmentRows.items.map((item) => item.itemKey))).toEqual(
      new Set(['temperatureCelsius', 'humidityPercent', 'illuminanceLux', 'co2Ppm']),
    );
    expect(new Set(accuracyRows.items.map((item) => item.itemKey))).toEqual(
      new Set(['harvestCount', 'damagedFruitCount']),
    );
    // 入力が集計値のみの観点（データ活用度合い）は、すべての観測値
    expect(dataUtilizationRows.items).toHaveLength(8);
  });

  it('カテゴリ・項目・取得元・期間で絞り込める（期間は両端を含む）', async () => {
    const context = await withData();

    expect((await list(context, 'category=ENVIRONMENT')).items).toHaveLength(4);
    expect((await list(context, 'itemKey=harvestCount')).items).toHaveLength(1);
    expect((await list(context, 'source=MANUAL')).items.map((item) => item.itemKey)).toEqual([
      'damagedFruitCount',
    ]);
    const ranged = await list(
      context,
      `from=${encodeURIComponent(hoursAgo(3))}&to=${encodeURIComponent(hoursAgo(2))}`,
    );
    expect(ranged.items.map((item) => item.itemKey).sort()).toEqual([
      'damagedFruitCount',
      'harvestCount',
    ]);
  });

  it.each([
    ['項目の表示名', '収穫数', ['harvestCount']],
    [
      'カテゴリの表示名',
      '環境情報',
      ['co2Ppm', 'humidityPercent', 'illuminanceLux', 'temperatureCelsius'],
    ],
    [
      '設備の名称',
      'テストセンサー',
      ['co2Ppm', 'humidityPercent', 'illuminanceLux', 'temperatureCelsius'],
    ],
    ['取得元の表示名', '手動', ['damagedFruitCount']],
    ['状態の表示名', '遅延', ['operatingHours']],
    ['値', '30000', ['illuminanceLux']],
    ['ステータスコードの名称', '収穫中', ['statusCode']],
    ['大文字・小文字を区別しない項目名', 'TEMPERATURECELSIUS', ['temperatureCelsius']],
  ])('キーワード（%s）で検索できる', async (_name, keyword, expectedItems) => {
    const context = await withData();

    const result = await list(context, `q=${encodeURIComponent(keyword)}`);

    expect(result.items.map((item) => item.itemKey).sort()).toEqual([...expectedItems].sort());
  });

  it('キーワードに一致するデータがなければ、空の一覧を返す。空白だけのキーワードは、絞り込まない', async () => {
    const context = await withData();

    expect((await list(context, 'q=%E5%AD%98%E5%9C%A8%E3%81%97%E3%81%AA%E3%81%84')).items).toEqual(
      [],
    );
    expect((await list(context, 'q=%20%20')).items).toHaveLength(8);
  });

  it.each([
    ['observedAt', 'asc', 'operatingHours'],
    // 同じ計測日時は、一意キーの順（項目名の昇順）で並べる
    ['observedAt', 'desc', 'co2Ppm'],
    ['value', 'desc', 'illuminanceLux'],
    ['value', 'asc', 'statusCode'],
    ['category', 'asc', 'co2Ppm'],
  ] as const)('並べ替え（%s・%s）の先頭は %s', async (sort, direction, firstItem) => {
    const context = await withData();

    const result = await list(context, `sort=${sort}&direction=${direction}`);

    expect(result.items[0]?.itemKey).toBe(firstItem);
  });

  it('ページ分割（limit・cursor）で、全件を重複なく返す。不正なカーソルは 400', async () => {
    const context = await withData();

    const first = await list(context, 'limit=3');
    const second = await list(context, `limit=3&cursor=${first.nextCursor ?? ''}`);
    const third = await list(context, `limit=3&cursor=${second.nextCursor ?? ''}`);

    expect([first.items.length, second.items.length, third.items.length]).toEqual([3, 3, 2]);
    expect(first.nextCursor).not.toBeNull();
    expect(third.nextCursor).toBeNull();
    const keys = [...first.items, ...second.items, ...third.items].map(
      (item) => `${item.equipmentId}#${item.itemKey}`,
    );
    expect(new Set(keys).size).toBe(8);
    expect(await errorCodeOf(context, '/observations?cursor=not-a-cursor')).toBe(
      'VALIDATION_ERROR',
    );
  });

  it.each([
    ['存在しない設備', '/observations?equipmentId=NOT-EXIST', 'NOT_FOUND'],
    ['存在しない観点', '/observations?viewpointId=unknown', 'NOT_FOUND'],
    ['不正なカテゴリ', '/observations?category=UNKNOWN', 'VALIDATION_ERROR'],
    ['不正な日時', '/observations?from=yesterday', 'VALIDATION_ERROR'],
    ['不正な並べ替え', '/observations?sort=name', 'VALIDATION_ERROR'],
    ['範囲外の件数', '/observations?limit=0', 'VALIDATION_ERROR'],
  ])('%s は %s', async (_name, path, code) => {
    const context = await withData();

    expect(await errorCodeOf(context, path)).toBe(code);
  });

  it('論理削除した観測値は返さない', async () => {
    const context = await setup();
    await seed(context, [
      ...environment(20),
      {
        equipmentId: SENSOR_ID,
        itemKey: 'temperatureCelsius',
        value: 1,
        observedAt: hoursAgo(9),
        isDeleted: true,
      },
    ]);

    expect((await list(context, 'itemKey=temperatureCelsius')).items).toHaveLength(1);
  });
});
