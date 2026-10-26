/**
 * UC-02 診断結果と根拠のメトリクスを確認する（SC-03。FR-5.2、FR-5.5、FR-6.4 / NFR-7.2）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、評価観点を選ぶ
 *               2. システムが、その観点の診断結果と、根拠となるメトリクスを表示する
 *               3. 農作業者が、メトリクスの良否を確認する
 *   代替フロー  メトリクスの算出に必要なデータが欠けている場合は、診断できない旨と欠けている項目を表示する
 *
 * 値の同値分割: 観点（10観点）× ステータス（正常・注意・異常・不明）、閾値の境界値（上限型・下限型・範囲型）、
 * 複数指標（最も悪い判定）、一部の指標のみ、算出不能（分母 0）、ステータスコード（名称）、視点（短期・長期）と期間、
 * 設備の種別、元データ（絞り込み・並べ替え・ページ分割・取得元・状態）。
 */

import { expect, test, type Page } from '@playwright/test';
import { gotoAuthenticated, loginViaUi } from './support/helpers.ts';
import {
  ROBOT,
  SENSOR,
  costEfficiencyData,
  dataUtilizationData,
  durabilityData,
  environmentData,
  harvestAccuracyBoundary,
  harvestAccuracyData,
  harvestSpeedData,
  hoursAgo,
  maintainabilityData,
  merge,
  mixedScenario,
  operabilityData,
  prepare,
  safetyData,
  seed,
  shot,
  travelStoppedBoundary,
  type Level,
  type SeedBody,
} from './support/viewpoint-scenarios.ts';

async function openDetail(page: Page, viewpointId: string, query = ''): Promise<void> {
  await gotoAuthenticated(page, `/viewpoints/${viewpointId}${query}`);
  await expect(page.getByTestId('diagnosis')).toBeVisible();
}

/** 根拠のメトリクスの1行（値と判定）を確認する。 */
async function expectMetric(
  page: Page,
  metricId: string,
  expected: { value: string | RegExp; judgement: string },
): Promise<void> {
  const row = page.getByTestId(`metric-${metricId}`);
  await expect(row).toBeVisible();
  await expect(row.locator('td').first()).toHaveText(expected.value);
  await expect(row.locator('td').nth(1)).toContainText(expected.judgement);
}

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const badge = (page: Page) =>
  page.getByTestId('diagnosis').locator('.diagnosis-head .status-badge');

test.describe('基本フロー: 評価観点を選び、診断結果と根拠のメトリクスを確認する', () => {
  test('ダッシュボードで観点を選ぶと、診断結果・根拠のメトリクス・判断基準・推移・元データが表示される', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await page.goto('/');
    await loginViaUi(page);

    // 1. 評価観点を選ぶ（環境適応性: 異常）
    await page
      .getByTestId('card-environmentalAdaptability')
      .locator('h3')
      .getByRole('link')
      .click();

    // 2. その観点の診断結果と、根拠となるメトリクスを表示する
    await expect(heading(page)).toContainText('環境適応性');
    await expect(heading(page)).toContainText('異常');
    await expect(page.locator('.page-meta')).toContainText('対象: ハウス1');
    await expect(badge(page)).toContainText('異常');
    await expect(page.getByTestId('diagnostic-message')).toContainText(
      '環境適応性: 異常。温度 40.0℃（異常）',
    );
    await expect(page.getByTestId('recommended-action')).toContainText('対応が必要な状態です');
    await expect(
      page
        .locator('.diagnosis')
        .getByText('判定の対象期間: 2026/10/02 12:00:00 〜 2026/10/09 12:00:00'),
    ).toBeVisible();
    // 3. メトリクスの良否を確認する（値と、指標ごとの判定）
    await expectMetric(page, 'temperatureCelsius', { value: '40.0℃', judgement: '異常' });
    await expectMetric(page, 'humidityPercent', { value: '60.0%', judgement: '正常' });
    await expectMetric(page, 'illuminanceLux', { value: '30000lx', judgement: '正常' });
    await expectMetric(page, 'co2Ppm', { value: '900ppm', judgement: '正常' });
    // 判断基準・推移・元データの各欄
    await expect(page.getByTestId('criteria')).toBeVisible();
    await expect(page.getByTestId('trend')).toBeVisible();
    await expect(page.getByTestId('source-data')).toBeVisible();
    await shot(page, testInfo, 'detail-environment-error');

    // ダッシュボードへ戻れる
    await page
      .getByRole('navigation', { name: 'パンくず' })
      .getByRole('link', { name: 'ダッシュボード' })
      .click();
    await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
  });

  test('短期と長期の判定を並べて表示し、それぞれの判定の対象期間を示す', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    // 2日前は正常（20℃）、直近は異常（40℃）→ 短期は異常、長期（7日の平均 30℃）は注意
    await seed(
      request,
      merge(environmentData({ temperature: 20 }, 48), environmentData({ temperature: 40 }, 1)),
    );

    await openDetail(page, 'environmentalAdaptability');

    const short = page.getByTestId('horizon-short');
    const long = page.getByTestId('horizon-long');
    await expect(short).toContainText('短期（直近24時間）');
    await expect(short).toContainText('異常');
    await expect(short).toContainText('判定の対象期間: 2026/10/08 12:00:00 〜 2026/10/09 12:00:00');
    await expect(long).toContainText('長期（直近7日）');
    await expect(long).toContainText('注意');
    await expect(long).toContainText('判定の対象期間: 2026/10/02 12:00:00 〜 2026/10/09 12:00:00');
    // 観点の最終ステータスは、短期・長期のうち悪い方（異常）
    await expect(heading(page)).toContainText('異常');
    await shot(page, testInfo, 'detail-horizons');
  });
});

test.describe('環境適応性: ステータスの同値分割と、閾値の境界値（範囲型）', () => {
  const equivalence: readonly { temperature: number; status: string; note: string }[] = [
    { temperature: 20, status: '正常', note: '範囲の中' },
    { temperature: 27, status: '注意', note: '正常の上側の外' },
    { temperature: 5, status: '注意', note: '正常の下側の外' },
    { temperature: 40, status: '異常', note: '異常の上側' },
    { temperature: -5, status: '異常', note: '異常の下側' },
  ];
  for (const item of equivalence) {
    test(`温度 ${String(item.temperature)}℃（${item.note}）は、${item.status}`, async ({
      page,
      request,
    }, testInfo) => {
      await prepare(request);
      await seed(request, environmentData({ temperature: item.temperature }));

      await openDetail(page, 'environmentalAdaptability');

      await expect(badge(page)).toContainText(item.status);
      await expectMetric(page, 'temperatureCelsius', {
        value: `${item.temperature.toFixed(1)}℃`,
        judgement: item.status,
      });
      await expect(page.getByTestId('diagnostic-message')).toContainText(
        `温度 ${item.temperature.toFixed(1)}℃（${item.status}）`,
      );
      await shot(page, testInfo, `detail-environment-${item.status}-${String(item.temperature)}`);
    });
  }

  // 温度の判断基準: 10℃以上25℃未満 正常／0℃以上10℃未満・25℃以上35℃未満 注意／0℃未満・35℃以上 異常
  const boundaries: readonly [number, string][] = [
    [10, '正常'],
    [9.9, '注意'],
    [24.9, '正常'],
    [25, '注意'],
    [34.9, '注意'],
    [35, '異常'],
    [0, '注意'],
    [-0.1, '異常'],
  ];
  for (const [temperature, status] of boundaries) {
    test(`境界値: 温度 ${String(temperature)}℃ は、${status}`, async ({ page, request }) => {
      await prepare(request);
      await seed(request, environmentData({ temperature }));

      await openDetail(page, 'environmentalAdaptability');

      await expect(badge(page)).toContainText(status);
      await expectMetric(page, 'temperatureCelsius', {
        value: `${temperature.toFixed(1)}℃`,
        judgement: status,
      });
    });
  }

  test('複数の指標は、最も悪い判定が観点のステータスになる（湿度が異常なら、温度が正常でも異常）', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, environmentData({ temperature: 20, humidity: 95 }));

    await openDetail(page, 'environmentalAdaptability');

    await expect(badge(page)).toContainText('異常');
    await expectMetric(page, 'temperatureCelsius', { value: '20.0℃', judgement: '正常' });
    await expectMetric(page, 'humidityPercent', { value: '95.0%', judgement: '異常' });
    await expectMetric(page, 'illuminanceLux', { value: '30000lx', judgement: '正常' });
  });

  test('湿度・照度・CO2濃度も、閾値で判定する（湿度 35% 注意、照度 15,000lx 注意、CO2 3,000ppm 異常）', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(
      request,
      environmentData({ temperature: 20, humidity: 35, illuminance: 15_000, co2: 3_000 }),
    );

    await openDetail(page, 'environmentalAdaptability');

    await expectMetric(page, 'humidityPercent', { value: '35.0%', judgement: '注意' });
    await expectMetric(page, 'illuminanceLux', { value: '15000lx', judgement: '注意' });
    await expectMetric(page, 'co2Ppm', { value: '3000ppm', judgement: '異常' });
    await expect(badge(page)).toContainText('異常');
  });

  test('一部の指標だけ取得できているとき、取得できた指標だけで判定し、欠けた指標は値「—」・判定「不明」で示す', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(
      request,
      environmentData({ temperature: 27, humidity: null, illuminance: null, co2: 900 }),
    );

    await openDetail(page, 'environmentalAdaptability');

    await expect(badge(page)).toContainText('注意');
    await expectMetric(page, 'temperatureCelsius', { value: '27.0℃', judgement: '注意' });
    await expectMetric(page, 'humidityPercent', { value: '—', judgement: '不明' });
    await expectMetric(page, 'illuminanceLux', { value: '—', judgement: '不明' });
    await expectMetric(page, 'co2Ppm', { value: '900ppm', judgement: '正常' });
    await shot(page, testInfo, 'detail-environment-partial');
  });
});

test.describe('代替フロー: 必要なデータが欠けている場合は、診断できない旨と欠けている項目を表示する', () => {
  test('データがない（不明）とき、データ不足の旨・欠けている項目・推奨アクション・導線を表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, {});

    await openDetail(page, 'harvestAccuracy');

    await expect(badge(page)).toContainText('不明');
    await expect(heading(page)).toContainText('不明');
    await expect(page.getByTestId('diagnostic-message')).toContainText(
      'データ不足のため評価できません',
    );
    await expect(page.getByTestId('diagnostic-message')).toContainText(
      '未取得の項目: 収穫数、果実損傷数、誤収穫数、取り残し数',
    );
    await expect(page.getByTestId('recommended-action')).toContainText(
      'データの取得・入力を確認してください',
    );
    await expect(page.getByTestId('unknown-guide')).toContainText('データ不足のため評価できません');
    // メトリクスは、すべて値なし（「—」）
    for (const metricId of [
      'marketableFruitRatePercent',
      'recognitionAccuracyPercent',
      'missedFruitRatePercent',
      'damagedFruitRatePercent',
    ]) {
      await expect(page.getByTestId(`metric-${metricId}`).locator('td').first()).toHaveText('—');
    }
    await shot(page, testInfo, 'detail-unknown-missing');

    // 導線: データ入力・取り込み設定・状況
    await page.getByTestId('unknown-guide').getByRole('link', { name: 'データ入力へ' }).click();
    await expect(page).toHaveURL(/\/data-entry$/);
    await page.goBack();
    await page
      .getByTestId('unknown-guide')
      .getByRole('link', { name: '取り込み設定・状況へ' })
      .click();
    await expect(page).toHaveURL(/\/settings\/ingestion$/);
  });

  test('一部の入力だけ欠けている（取り残し数がない）とき、欠けている項目名だけを示す', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, {
      series: [],
      observations: [
        { equipmentId: ROBOT, itemKey: 'harvestCount', value: 100, observedAt: hoursAgo(1) },
        {
          equipmentId: ROBOT,
          itemKey: 'damagedFruitCount',
          value: 1,
          observedAt: hoursAgo(1),
          source: 'MANUAL',
        },
        {
          equipmentId: ROBOT,
          itemKey: 'wrongHarvestCount',
          value: 1,
          observedAt: hoursAgo(1),
          source: 'MANUAL',
        },
      ],
    });

    await openDetail(page, 'harvestAccuracy');

    await expect(badge(page)).toContainText('不明');
    await expect(page.getByTestId('diagnostic-message')).toContainText('未取得の項目: 取り残し数');
    await expect(page.getByTestId('diagnostic-message')).not.toContainText('収穫数、');
  });

  test('分母が 0（収穫数 0）のとき、算出できない旨を示し、不明にする（0 で代用しない）', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, {
      observations: [
        { equipmentId: ROBOT, itemKey: 'harvestCount', value: 0, observedAt: hoursAgo(1) },
        {
          equipmentId: ROBOT,
          itemKey: 'damagedFruitCount',
          value: 0,
          observedAt: hoursAgo(1),
          source: 'MANUAL',
        },
        {
          equipmentId: ROBOT,
          itemKey: 'wrongHarvestCount',
          value: 0,
          observedAt: hoursAgo(1),
          source: 'MANUAL',
        },
        {
          equipmentId: ROBOT,
          itemKey: 'missedFruitCount',
          value: 0,
          observedAt: hoursAgo(1),
          source: 'MANUAL',
        },
      ],
    });

    await openDetail(page, 'harvestAccuracy');

    await expect(badge(page)).toContainText('不明');
    await expect(page.getByTestId('diagnostic-message')).toContainText('算出できない指標');
    await expect(
      page.getByTestId('metric-marketableFruitRatePercent').locator('td').first(),
    ).toHaveText('—');
  });

  test('評価がまだ行われていない（データの取り込み・入力の前）とき、評価前である旨を示す', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);

    await page.goto('/viewpoints/harvestAccuracy');
    await loginViaUi(page);

    await expect(page.getByTestId('diagnosis')).toContainText('まだ評価されていません');
    await expect(heading(page)).toContainText('不明');
    await expect(page.getByTestId('horizon-long')).toContainText('まだ評価されていません');
    await shot(page, testInfo, 'detail-not-evaluated');
  });

  test('選んだ設備では評価しない観点は、その旨を示し、設備の選び直しで表示できる（センサー: 環境適応性のみ）', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, environmentData());

    await openDetail(page, 'harvestAccuracy');
    await page.getByLabel('対象の設備').selectOption({ label: '　環境センサー1' });

    await expect(page.getByTestId('not-applicable')).toContainText(
      'この設備では評価しない観点です',
    );
    await expect(page.getByTestId('not-applicable')).toContainText('設備を選び直してください');
    await shot(page, testInfo, 'detail-not-applicable');

    await page.getByLabel('対象の設備').selectOption({ label: '　収穫ロボット1' });
    await expect(page.getByTestId('diagnosis')).toBeVisible();
    await expect(page.locator('.page-meta')).toContainText('対象: 収穫ロボット1');
  });

  test('センサーを選んだ環境適応性は、そのセンサーの観測値だけで診断する', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, environmentData({ temperature: 27 }));

    await openDetail(page, 'environmentalAdaptability');
    await page.getByLabel('対象の設備').selectOption({ label: '　環境センサー1' });

    await expect(page.locator('.page-meta')).toContainText('対象: 環境センサー1');
    await expect(badge(page)).toContainText('注意');
    await expectMetric(page, 'temperatureCelsius', { value: '27.0℃', judgement: '注意' });
  });
});

interface LevelCase {
  readonly level: Level;
  readonly status: string;
  readonly metrics: readonly [string, string | RegExp, string][];
}

/** 観点ごとの、ステータス（正常・注意・異常）の同値クラスと、そのときの根拠のメトリクス（値・判定）。判断基準からの手計算。 */
const VIEWPOINT_CASES: readonly {
  readonly viewpointId: string;
  readonly name: string;
  readonly data: (level: Level) => SeedBody;
  readonly cases: readonly LevelCase[];
}[] = [
  {
    viewpointId: 'harvestAccuracy',
    name: '収穫精度',
    data: harvestAccuracyData,
    cases: [
      {
        level: 'NORMAL',
        status: '正常',
        metrics: [
          ['marketableFruitRatePercent', '98.7%', '正常'],
          ['recognitionAccuracyPercent', '98.7%', '正常'],
          ['missedFruitRatePercent', '1.3%', '判定なし'],
          ['damagedFruitRatePercent', '0.9%', '判定なし'],
        ],
      },
      {
        level: 'CAUTION',
        status: '注意',
        metrics: [
          ['marketableFruitRatePercent', '89.6%', '注意'],
          ['recognitionAccuracyPercent', '98.7%', '正常'],
        ],
      },
      {
        level: 'ERROR',
        status: '異常',
        metrics: [
          ['marketableFruitRatePercent', '78.3%', '異常'],
          ['recognitionAccuracyPercent', '98.7%', '正常'],
        ],
      },
    ],
  },
  {
    viewpointId: 'harvestSpeed',
    name: '収穫速度',
    data: harvestSpeedData,
    cases: [
      {
        level: 'NORMAL',
        status: '正常',
        metrics: [
          ['averageSecondsPerFruit', '36.0秒/果実', '正常'],
          ['travelStoppedRatePercent', '2.0%', '正常'],
        ],
      },
      {
        level: 'CAUTION',
        status: '注意',
        metrics: [
          ['averageSecondsPerFruit', '64.8秒/果実', '注意'],
          ['travelStoppedRatePercent', '2.0%', '正常'],
        ],
      },
      {
        level: 'ERROR',
        status: '異常',
        metrics: [
          ['averageSecondsPerFruit', '144.0秒/果実', '異常'],
          ['travelStoppedRatePercent', '2.0%', '正常'],
        ],
      },
    ],
  },
  {
    viewpointId: 'operability',
    name: '操作性',
    data: operabilityData,
    cases: [
      {
        level: 'NORMAL',
        status: '正常',
        metrics: [
          ['operationStepCount', '4回', '正常'],
          ['operationMinutes', '8.0分', '正常'],
          ['operationErrorRatePercent', '0.0%', '正常'],
        ],
      },
      {
        level: 'CAUTION',
        status: '注意',
        metrics: [
          ['operationStepCount', '7回', '注意'],
          ['operationMinutes', '15.0分', '注意'],
          ['operationErrorRatePercent', '14.3%', '注意'],
        ],
      },
      {
        level: 'ERROR',
        status: '異常',
        metrics: [
          ['operationStepCount', '12回', '異常'],
          ['operationMinutes', '35.0分', '異常'],
          ['operationErrorRatePercent', '41.7%', '異常'],
        ],
      },
    ],
  },
  {
    viewpointId: 'maintainability',
    name: 'メンテナンス性',
    data: (level) => maintainabilityData(level),
    cases: [
      { level: 'NORMAL', status: '正常', metrics: [['mttrHours', '1.50時間', '正常']] },
      { level: 'CAUTION', status: '注意', metrics: [['mttrHours', '5.00時間', '注意']] },
      { level: 'ERROR', status: '異常', metrics: [['mttrHours', '10.00時間', '異常']] },
    ],
  },
  {
    viewpointId: 'costEfficiency',
    name: 'コスト効率',
    data: () => costEfficiencyData(),
    cases: [
      {
        level: 'ERROR',
        status: '異常',
        metrics: [
          ['marketableFruitRatePercent', '98.7%', '正常'],
          ['averageSecondsPerFruit', '36.0秒/果実', '正常'],
          ['availabilityPercent', '95.8%', '正常'],
          ['economicProductivity', '0.00', '異常'],
          ['operatingCostYen', '35400円', '判定なし'],
        ],
      },
    ],
  },
  {
    viewpointId: 'safety',
    name: '安全性',
    data: safetyData,
    cases: [
      {
        level: 'NORMAL',
        status: '正常',
        metrics: [
          ['emergencyStopPerHour', '0.000回/時間', '正常'],
          ['nearMissPerHour', '0.000回/時間', '正常'],
        ],
      },
      {
        level: 'CAUTION',
        status: '注意',
        metrics: [
          ['emergencyStopPerHour', '0.043回/時間', '注意'],
          ['nearMissPerHour', '0.000回/時間', '正常'],
        ],
      },
      {
        level: 'ERROR',
        status: '異常',
        metrics: [
          ['emergencyStopPerHour', '0.087回/時間', '異常'],
          ['nearMissPerHour', '0.000回/時間', '正常'],
        ],
      },
    ],
  },
  {
    viewpointId: 'dataUtilization',
    name: 'データ活用度合い',
    data: dataUtilizationData,
    cases: [
      { level: 'NORMAL', status: '正常', metrics: [['dataCoveragePercent', /^9\d\.\d%$/, '正常']] },
      {
        level: 'CAUTION',
        status: '注意',
        metrics: [['dataCoveragePercent', /^7\d\.\d%$/, '注意']],
      },
      { level: 'ERROR', status: '異常', metrics: [['dataCoveragePercent', /^4\d\.\d%$/, '異常']] },
    ],
  },
  {
    viewpointId: 'durability',
    name: '耐久性',
    data: (level) => durabilityData(level),
    cases: [
      {
        level: 'NORMAL',
        status: '正常',
        metrics: [
          ['mtbfHours', '600.3時間', '正常'],
          ['availabilityPercent', '99.8%', '正常'],
        ],
      },
      {
        level: 'CAUTION',
        status: '注意',
        metrics: [
          ['mtbfHours', '299.0時間', '注意'],
          ['availabilityPercent', '99.7%', '正常'],
        ],
      },
      {
        level: 'ERROR',
        status: '異常',
        metrics: [
          ['mtbfHours', '23.0時間', '異常'],
          ['availabilityPercent', '95.8%', '正常'],
        ],
      },
    ],
  },
];

test.describe('観点ごとの診断結果と根拠のメトリクス（正常・注意・異常）', () => {
  for (const viewpoint of VIEWPOINT_CASES) {
    for (const item of viewpoint.cases) {
      test(`${viewpoint.name}が${item.status}のとき、診断結果と根拠のメトリクス（値・指標ごとの判定）を表示する`, async ({
        page,
        request,
      }, testInfo) => {
        await prepare(request);
        await seed(request, viewpoint.data(item.level));

        await openDetail(page, viewpoint.viewpointId);

        await expect(heading(page)).toContainText(viewpoint.name);
        await expect(badge(page)).toContainText(item.status);
        await expect(page.getByTestId('diagnostic-message')).toContainText(
          `${viewpoint.name}: ${item.status}`,
        );
        for (const [metricId, value, judgement] of item.metrics) {
          await expectMetric(page, metricId, { value, judgement });
        }
        await shot(page, testInfo, `detail-${viewpoint.viewpointId}-${item.level.toLowerCase()}`);
      });
    }
  }
});

test.describe('閾値の境界値（下限型・上限型）', () => {
  // 可販果率の判断基準（下限型）: 90%以上 正常／80%以上90%未満 注意／80%未満 異常。収穫数 100 に対する、損傷 + 誤収穫
  const lower: readonly { damaged: number; wrong: number; rate: string; status: string }[] = [
    { damaged: 6, wrong: 4, rate: '90.0%', status: '正常' },
    { damaged: 6, wrong: 5, rate: '89.0%', status: '注意' },
    { damaged: 12, wrong: 8, rate: '80.0%', status: '注意' },
    { damaged: 12, wrong: 9, rate: '79.0%', status: '異常' },
  ];
  for (const item of lower) {
    test(`可販果率 ${item.rate}（損傷 ${String(item.damaged)} + 誤収穫 ${String(item.wrong)} / 収穫 100）は、${item.status}`, async ({
      page,
      request,
    }) => {
      await prepare(request);
      await seed(request, harvestAccuracyBoundary(item.damaged, item.wrong));

      await openDetail(page, 'harvestAccuracy');

      await expectMetric(page, 'marketableFruitRatePercent', {
        value: item.rate,
        judgement: item.status,
      });
    });
  }

  // 走行停止率の判断基準（上限型）: 5%未満 正常／5%以上10%未満 注意／10%以上 異常。収穫稼働時間 1h に対する走行停止時間
  const upper: readonly { stopped: number; rate: string; status: string }[] = [
    { stopped: 0.049, rate: '4.9%', status: '正常' },
    { stopped: 0.05, rate: '5.0%', status: '注意' },
    { stopped: 0.099, rate: '9.9%', status: '注意' },
    { stopped: 0.1, rate: '10.0%', status: '異常' },
  ];
  for (const item of upper) {
    test(`走行停止率 ${item.rate} は、${item.status}`, async ({ page, request }) => {
      await prepare(request);
      await seed(request, travelStoppedBoundary(item.stopped));

      await openDetail(page, 'harvestSpeed');

      await expectMetric(page, 'travelStoppedRatePercent', {
        value: item.rate,
        judgement: item.status,
      });
    });
  }
});

test.describe('ステータスコードで判定する観点: カテゴリ名ではなく、名称で表示する', () => {
  const codes: readonly { code: string; name: string; status: string }[] = [
    { code: 'HARVESTING', name: '収穫中', status: '正常' },
    { code: 'STOPPED', name: '停止中', status: '注意' },
    { code: 'HARVEST_ERROR', name: '収穫異常', status: '異常' },
    { code: 'FALLEN', name: '転倒（姿勢異常）', status: '異常' },
  ];
  for (const item of codes) {
    test(`収穫速度: ステータスコード ${item.code} は、名称「${item.name}」で表示し、判定は${item.status}`, async ({
      page,
      request,
    }, testInfo) => {
      await prepare(request);
      await seed(request, harvestSpeedData('NORMAL', item.code));

      await openDetail(page, 'harvestSpeed');

      const row = page.getByTestId('metric-status');
      await expect(row.locator('td').first()).toHaveText(item.name);
      await expect(row.locator('td').nth(1)).toContainText(item.status);
      await expect(badge(page)).toContainText(item.status);
      await expect(page.getByTestId('diagnostic-message')).toContainText(
        `ステータス ${item.name}（${item.status}）`,
      );
      await expect(page.getByTestId('criteria-status-note')).toContainText('ステータスコード管理');
      if (item.code === 'HARVEST_ERROR') {
        await shot(page, testInfo, 'detail-status-code');
      }
    });
  }

  test('メンテナンス性・耐久性も、ステータスコードの名称を表示する（待機中）', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(
      request,
      merge(maintainabilityData('NORMAL', 'STANDBY'), durabilityData('NORMAL', 'STANDBY')),
    );

    await openDetail(page, 'maintainability');
    await expect(page.getByTestId('metric-status').locator('td').first()).toHaveText('待機中');
    await openDetail(page, 'durability');
    await expect(page.getByTestId('metric-status').locator('td').first()).toHaveText('待機中');
  });

  test('ステータスコードが未取得のとき、名称は「—」・判定なし', async ({ page, request }) => {
    await prepare(request);
    await seed(request, {
      series: [],
      observations: [
        { equipmentId: ROBOT, itemKey: 'harvestCount', value: 100, observedAt: hoursAgo(1) },
        { equipmentId: ROBOT, itemKey: 'harvestOperatingHours', value: 1, observedAt: hoursAgo(1) },
        { equipmentId: ROBOT, itemKey: 'travelStoppedHours', value: 0.01, observedAt: hoursAgo(1) },
      ],
    });

    await openDetail(page, 'harvestSpeed');

    await expect(badge(page)).toContainText('不明');
    await expect(page.getByTestId('diagnostic-message')).toContainText('未取得の項目: ステータス');
    await expect(page.getByTestId('metric-status').locator('td').first()).toHaveText('—');
    await expect(page.getByTestId('metric-status').locator('td').nth(1)).toContainText('判定なし');
  });
});

test.describe('メトリクスの良否の直感的な表示（NFR-7.2。色・アイコン・文字）', () => {
  const cases = [
    { status: '正常', iconName: 'status-normal', klass: 'normal', temperature: 20 },
    { status: '注意', iconName: 'status-caution', klass: 'caution', temperature: 27 },
    { status: '異常', iconName: 'status-error', klass: 'error', temperature: 40 },
  ] as const;
  for (const item of cases) {
    test(`温度 ${String(item.temperature)}℃（${item.status}）のとき、診断の枠・見出し・メトリクスの判定が、色・アイコン・文字の3つで${item.status}と分かる`, async ({
      page,
      request,
    }, testInfo) => {
      await prepare(request);
      await seed(request, environmentData({ temperature: item.temperature }));

      await openDetail(page, 'environmentalAdaptability');

      // 診断結果の枠（色）、見出し・診断のバッジ（色・アイコン・文字）
      await expect(page.locator('.diagnosis')).toHaveClass(
        new RegExp(`diagnosis-${item.klass}(\\s|$)`),
      );
      for (const target of [badge(page), heading(page).locator('.status-badge')]) {
        await expect(target).toHaveClass(new RegExp(`status-${item.klass}(\\s|$)`));
        await expect(target.locator(`[data-icon="${item.iconName}"]`)).toBeVisible();
        await expect(target).toContainText(item.status);
      }
      // 指標ごとの判定（温度）も、同じ3つで示す
      const judgement = page
        .getByTestId('metric-temperatureCelsius')
        .locator('td')
        .nth(1)
        .locator('.status-badge');
      await expect(judgement).toHaveClass(new RegExp(`status-${item.klass}(\\s|$)`));
      await expect(judgement.locator(`[data-icon="${item.iconName}"]`)).toBeVisible();
      await expect(judgement).toContainText(item.status);
      await shot(page, testInfo, `detail-visual-${item.klass}`);
    });
  }

  test('不明（欠けた指標）は、「?」のアイコンと文字「不明」で示し、評価できた指標の判定とは区別できる', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, environmentData({ temperature: 27, humidity: null }));

    await openDetail(page, 'environmentalAdaptability');

    const unknown = page
      .getByTestId('metric-humidityPercent')
      .locator('td')
      .nth(1)
      .locator('.status-badge');
    await expect(unknown).toHaveClass(/status-unknown(\s|$)/);
    await expect(unknown.locator('[data-icon="status-unknown"]')).toBeVisible();
    await expect(unknown).toContainText('不明');
    const caution = page
      .getByTestId('metric-temperatureCelsius')
      .locator('td')
      .nth(1)
      .locator('.status-badge');
    await expect(caution).toHaveClass(/status-caution(\s|$)/);
    await expect(caution).not.toHaveClass(/status-unknown/);
  });

  test('評価できない観点（不明）の診断の枠・見出しのバッジも、「?」のアイコンと文字「不明」で示す', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, {});

    await openDetail(page, 'harvestAccuracy');

    await expect(badge(page)).toHaveClass(/status-unknown(\s|$)/);
    await expect(badge(page).locator('[data-icon="status-unknown"]')).toBeVisible();
    await expect(badge(page)).toContainText('不明');
    await expect(page.locator('.diagnosis')).toHaveClass(/diagnosis-unknown(\s|$)/);
  });
});

test.describe('根拠のメトリクス・判断基準', () => {
  test('ダッシュボードに出さないメトリクスも含めて、全メトリクスを表示し、主要メトリクスに印を付ける', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, harvestAccuracyData('NORMAL'));

    await openDetail(page, 'harvestAccuracy');

    const rows = page.getByTestId('basis').locator('tbody tr');
    await expect(rows).toHaveCount(4);
    // 主要メトリクス（ダッシュボードに表示）は、可販果率・認識精度
    await expect(page.getByTestId('metric-marketableFruitRatePercent')).toContainText('主要');
    await expect(page.getByTestId('metric-recognitionAccuracyPercent')).toContainText('主要');
    await expect(page.getByTestId('metric-missedFruitRatePercent')).not.toContainText('主要');
    await expect(page.getByTestId('metric-damagedFruitRatePercent')).not.toContainText('主要');
    await shot(page, testInfo, 'detail-basis');
  });

  test('判断基準: 指標ごとの条件名と、正常・注意・異常の条件（下限型・上限型・範囲型）を表示し、既定値であることを示す', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, {});

    await openDetail(page, 'harvestAccuracy');
    const accuracy = page.getByTestId('criterion-marketableFruitRatePercent');
    await expect(page.getByTestId('criteria-state')).toHaveText('既定値');
    await expect(accuracy).toContainText('可販果率');
    await expect(accuracy.locator('td').nth(1)).toHaveText('90%以上');
    await expect(accuracy.locator('td').nth(2)).toHaveText('80%以上90%未満');
    await expect(accuracy.locator('td').nth(3)).toHaveText('80%未満');

    await openDetail(page, 'harvestSpeed');
    const stopped = page.getByTestId('criterion-travelStoppedRatePercent');
    await expect(stopped.locator('td').nth(1)).toHaveText('5%未満');
    await expect(stopped.locator('td').nth(2)).toHaveText('5%以上10%未満');
    await expect(stopped.locator('td').nth(3)).toHaveText('10%以上');

    await openDetail(page, 'environmentalAdaptability');
    const temperature = page.getByTestId('criterion-temperatureCelsius');
    await expect(temperature.locator('td').nth(1)).toHaveText('10℃以上25℃未満');
    await expect(temperature.locator('td').nth(2)).toHaveText('0℃以上10℃未満、25℃以上35℃未満');
    await expect(temperature.locator('td').nth(3)).toHaveText('0℃未満、35℃以上');
    await expect(page.getByTestId('criterion-illuminanceLux').locator('td').nth(1)).toHaveText(
      '20,000lx以上40,000lx未満',
    );
    await expect(page.getByTestId('criterion-co2Ppm').locator('td').nth(1)).toHaveText(
      '800ppm以上1,000ppm未満',
    );
    await shot(page, testInfo, 'detail-criteria');

    // 判断基準の編集（SC-13）への導線
    await page.getByTestId('criteria').getByRole('link', { name: '判断基準を編集' }).click();
    await expect(page).toHaveURL(/\/viewpoints\/environmentalAdaptability\/criteria$/);
  });
});

test.describe('視点（短期・長期）と期間の選択', () => {
  test('短期は最新の観測値、長期は期間の平均で診断する。選択は URL に反映される', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(
      request,
      merge(environmentData({ temperature: 20 }, 48), environmentData({ temperature: 30 }, 1)),
    );
    await openDetail(page, 'environmentalAdaptability');
    await expectMetric(page, 'temperatureCelsius', { value: '25.0℃', judgement: '注意' });

    await page.getByRole('radio', { name: '短期' }).check();

    await expect(page).toHaveURL(/\?horizon=SHORT&periodDays=7$/);
    await expectMetric(page, 'temperatureCelsius', { value: '30.0℃', judgement: '注意' });
    await expect(page.locator('.diagnosis-horizon')).toContainText('短期（直近24時間）');
    await expect(
      page
        .locator('.diagnosis')
        .getByText('判定の対象期間: 2026/10/08 12:00:00 〜 2026/10/09 12:00:00'),
    ).toBeVisible();
  });

  test('長期の期間を選ぶと、その期間の平均で診断する（当日・7・30日で、正常 → 注意に変わる）', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(
      request,
      merge(
        environmentData({ temperature: 20 }, 2),
        environmentData({ temperature: 30 }, 10 * 24),
        environmentData({ temperature: 30 }, 15 * 24),
        environmentData({ temperature: 30 }, 20 * 24),
      ),
    );
    await openDetail(page, 'environmentalAdaptability', '?horizon=LONG&periodDays=1');
    await expectMetric(page, 'temperatureCelsius', { value: '20.0℃', judgement: '正常' });
    await expect(page.locator('.diagnosis-horizon')).toContainText('長期（当日）');

    await page.getByLabel('長期の期間').selectOption({ label: '直近7日' });
    await expectMetric(page, 'temperatureCelsius', { value: '20.0℃', judgement: '正常' });

    await page.getByLabel('長期の期間').selectOption({ label: '直近30日' });
    await expect(page).toHaveURL(/periodDays=30$/);
    await expectMetric(page, 'temperatureCelsius', { value: '27.5℃', judgement: '注意' });
    await expect(page.locator('.diagnosis-horizon')).toContainText('長期（直近30日）');
    await expect(badge(page)).toContainText('注意');
  });

  test('短期評価を持たない観点（耐久性）は、短期を選んでも長期の結果を表示し、その旨を示す', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, durabilityData('NORMAL'));

    await openDetail(page, 'durability', '?horizon=SHORT&periodDays=7');

    await expect(
      page
        .getByTestId('diagnosis')
        .getByText('この観点は短期評価を持たないため、長期の結果を表示しています'),
    ).toBeVisible();
    await expect(page.getByTestId('horizon-short')).toContainText('短期評価はありません');
    await expect(page.locator('.diagnosis-horizon')).toContainText('長期（直近7日）');
    await expectMetric(page, 'mtbfHours', { value: '600.3時間', judgement: '正常' });
    await shot(page, testInfo, 'detail-no-short-horizon');
  });
});

test.describe('元データ: 分析に使った取り込みデータ・手動入力データ', () => {
  /** 環境センサー 4項目を15分ごとに 2時間分（各9件 = 36件）。 */
  function sensorRows(): SeedBody {
    const series = (itemKey: string, value: number) => ({
      equipmentId: SENSOR,
      itemKey,
      from: hoursAgo(3),
      to: hoursAgo(1),
      intervalMinutes: 15,
      value,
    });
    return {
      series: [
        series('temperatureCelsius', 20),
        series('humidityPercent', 60),
        series('illuminanceLux', 30_000),
        series('co2Ppm', 900),
      ],
    };
  }

  test('一覧（日時の新しい順）に、計測日時・設備・項目・値（単位つき）・取得元・状態を表示し、10件ごとにページを分ける', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, sensorRows());

    await openDetail(page, 'environmentalAdaptability');

    const source = page.getByTestId('source-data');
    const rows = source.locator('tbody tr');
    await expect(rows).toHaveCount(10);
    // 同じ計測日時は、項目名の昇順。計測日時は日本時間
    await expect(rows.first()).toContainText('2026/10/09 11:00:00');
    await expect(rows.first()).toContainText('環境センサー1');
    await expect(rows.first()).toContainText('CO2濃度（環境情報）');
    await expect(rows.first()).toContainText('900ppm');
    await expect(rows.first()).toContainText('自動取り込み');
    await expect(rows.first()).toContainText('有効');
    await expect(source.getByTestId('source-data-page')).toHaveText('1');
    await shot(page, testInfo, 'detail-source-data');

    // ページ分割（36件 = 10件 × 3ページ + 6件）
    await expect(source.getByRole('button', { name: '前へ' })).toBeDisabled();
    await source.getByRole('button', { name: '次へ' }).click();
    await expect(source.getByTestId('source-data-page')).toHaveText('2');
    await source.getByRole('button', { name: '次へ' }).click();
    await source.getByRole('button', { name: '次へ' }).click();
    await expect(source.getByTestId('source-data-page')).toHaveText('4');
    await expect(rows).toHaveCount(6);
    await expect(source.getByRole('button', { name: '次へ' })).toBeDisabled();
    await source.getByRole('button', { name: '前へ' }).click();
    await expect(source.getByTestId('source-data-page')).toHaveText('3');
    await expect(rows).toHaveCount(10);
  });

  test('キーワードで絞り込める（項目名・設備名・値・取得元）。一致するデータがなければ、その旨を示す', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(
      request,
      merge(sensorRows(), {
        observations: [
          {
            equipmentId: SENSOR,
            itemKey: 'temperatureCelsius',
            value: 21,
            observedAt: hoursAgo(5),
            source: 'MANUAL',
          },
        ],
      }),
    );
    await openDetail(page, 'environmentalAdaptability');
    const source = page.getByTestId('source-data');
    const rows = source.locator('tbody tr');

    await source.getByLabel('キーワード').fill('湿度');
    await expect(rows).toHaveCount(9);
    await expect(rows.filter({ hasNotText: '湿度' })).toHaveCount(0);

    await source.getByLabel('キーワード').fill('手動');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('手動入力');
    await expect(rows.first()).toContainText('21℃');

    await source.getByLabel('キーワード').fill('30000');
    await expect(rows).toHaveCount(9);
    await expect(rows.first()).toContainText('照度');

    // 設備名（センサーの値だけなので、すべての行が一致する。ロボットの名称では、一致しない）
    await source.getByLabel('キーワード').fill('環境センサー1');
    await expect(rows).toHaveCount(10);
    await expect(rows.filter({ hasNotText: '環境センサー1' })).toHaveCount(0);
    await source.getByLabel('キーワード').fill('収穫ロボット');
    await expect(source.getByTestId('source-data-empty')).toBeVisible();

    await source.getByLabel('キーワード').fill('該当しない語');
    await expect(source.getByTestId('source-data-empty')).toContainText(
      '該当するデータがありません',
    );

    await source.getByLabel('キーワード').fill('');
    await expect(rows).toHaveCount(10);
  });

  test('並べ替え（日時・値）と向き（昇順・降順）を変えられる。条件を変えると、先頭のページに戻る', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, sensorRows());
    await openDetail(page, 'environmentalAdaptability');
    const source = page.getByTestId('source-data');
    const rows = source.locator('tbody tr');
    await source.getByRole('button', { name: '次へ' }).click();
    await expect(source.getByTestId('source-data-page')).toHaveText('2');

    await source
      .locator('label', { hasText: '並べ替え' })
      .locator('select')
      .selectOption({ label: '値' });

    await expect(source.getByTestId('source-data-page')).toHaveText('1');
    // 値の降順: 照度 30,000lx が先頭
    await expect(rows.first()).toContainText('30,000lx');
    await source.getByLabel('並べ替えの向き').selectOption({ label: '昇順' });
    // 値の昇順: 温度 20℃ が先頭
    await expect(rows.first()).toContainText('20℃');
    await source
      .locator('label', { hasText: '並べ替え' })
      .locator('select')
      .selectOption({ label: '計測日時' });
    // 計測日時の昇順: 最も古い 3時間前（09:00）が先頭
    await expect(rows.first()).toContainText('2026/10/09 09:00:00');
  });

  test('手動入力・遅延・欠損のデータも、取得元と状態を示して表示する。ステータスコードは名称', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, {
      observations: [
        { equipmentId: ROBOT, itemKey: 'harvestCount', value: 100, observedAt: hoursAgo(1) },
        {
          equipmentId: ROBOT,
          itemKey: 'damagedFruitCount',
          value: 3,
          observedAt: hoursAgo(2),
          source: 'MANUAL',
        },
        {
          equipmentId: ROBOT,
          itemKey: 'wrongHarvestCount',
          value: 1,
          observedAt: hoursAgo(3),
          source: 'MANUAL',
          quality: 'LATE',
          receivedAt: hoursAgo(2),
        },
        {
          equipmentId: ROBOT,
          itemKey: 'missedFruitCount',
          value: null,
          observedAt: hoursAgo(4),
          source: 'MANUAL',
          quality: 'MISSING',
        },
      ],
    });

    await openDetail(page, 'harvestAccuracy');

    const rows = page.getByTestId('source-data').locator('tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('収穫数');
    await expect(rows.nth(0)).toContainText('100個');
    await expect(rows.nth(0)).toContainText('収穫ロボット1');
    await expect(rows.nth(1)).toContainText('手動入力');
    await expect(rows.nth(1)).toContainText('果実損傷数（収穫情報）');
    await expect(rows.nth(2)).toContainText('遅延');
    await expect(rows.nth(3)).toContainText('欠損');
    await expect(rows.nth(3)).toContainText('—');
    await shot(page, testInfo, 'detail-source-data-kinds');

    // 収穫速度: ステータスコードの値は名称（収穫中）
    await seed(request, harvestSpeedData('NORMAL'));
    await openDetail(page, 'harvestSpeed');
    await expect(
      page.getByTestId('source-data').locator('tbody tr', { hasText: 'ステータスコード' }).first(),
    ).toContainText('収穫中');
  });

  test('元データがなければ、その旨を示す。取り込み済みデータの一覧（SC-09）への導線がある', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, {});

    await openDetail(page, 'environmentalAdaptability');

    const source = page.getByTestId('source-data');
    await expect(source.getByTestId('source-data-empty')).toContainText(
      '該当するデータがありません',
    );
    await source.getByRole('link', { name: '取り込み済みデータ一覧へ' }).click();
    await expect(page).toHaveURL(/\/observations$/);
  });

  test('診断の対象期間の外のデータと、他の観点の項目は、元データに含めない', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(
      request,
      merge(
        environmentData({ temperature: 20 }, 1),
        environmentData({ temperature: 21 }, 24 * 10),
        {
          observations: [
            { equipmentId: ROBOT, itemKey: 'harvestCount', value: 5, observedAt: hoursAgo(1) },
          ],
        },
      ),
    );

    await openDetail(page, 'environmentalAdaptability');

    // 直近7日の環境の4件のみ（10日前の4件と、収穫数は含めない）
    await expect(page.getByTestId('source-data').locator('tbody tr')).toHaveCount(4);
    await expect(page.getByTestId('source-data')).not.toContainText('収穫数');
  });
});

test.describe('画面の表示（レイアウト）', () => {
  test('タブレット幅（768px）でも、横スクロールや要素の重なりなく、全欄を表示できる', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await page.setViewportSize({ width: 768, height: 1024 });

    await openDetail(page, 'harvestSpeed');

    // 診断・根拠のメトリクス・判断基準・推移・元データの各欄が表示される
    for (const section of ['diagnosis', 'basis', 'criteria', 'trend', 'source-data']) {
      await expect(page.getByTestId(section)).toBeVisible();
    }
    await shot(page, testInfo, 'detail-tablet');
  });

  test('タブレット幅（768px）の元データの表は、計測日時・取得元・状態の文字を折り返さない（1文字ずつ縦に並ばない）', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, harvestSpeedData('NORMAL'));
    await page.setViewportSize({ width: 768, height: 1024 });

    await openDetail(page, 'harvestSpeed');
    await expect(page.getByTestId('source-data').locator('tbody tr').first()).toBeVisible();

    // 計測日時（1列目）・取得元（5列目）・状態（6列目）は、1行で表示する
    const wrapped = await page.evaluate(() => {
      const found: string[] = [];
      document.querySelectorAll('[data-testid="source-data"] tbody tr').forEach((row, index) => {
        for (const column of [1, 5, 6]) {
          const cell = row.querySelector(`td:nth-child(${String(column)})`);
          if (cell === null) {
            continue;
          }
          const range = document.createRange();
          range.selectNodeContents(cell);
          const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
          if (lines.size > 1) {
            found.push(`行${String(index + 1)} の ${String(column)} 列目: ${cell.textContent}`);
          }
        }
      });
      return found;
    });
    expect(wrapped, '折り返した文字').toEqual([]);
    await shot(page, testInfo, 'detail-tablet-source-data');
  });
});
