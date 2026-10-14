/**
 * UC-03 状態の推移を確認する（SC-03。FR-5.6、FR-6.5、FR-6.10）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、観点またはメトリクスと、期間（短期／中長期）を選ぶ
 *               2. システムが、推移をグラフ等で表示する（メトリクスの推移、観点のステータスの推移）
 *               3. システムが、短期・中長期の視点でフィードバックを提示する
 *   代替フロー  短期評価を持たない観点では、短期のフィードバックは表示しない
 *
 * 値の同値分割: 視点（短期・当日・7・30・60・90日）、データの状態（全区間にある・途中に欠損・1区間のみ・なし）、
 * 区間の境界（日本時間 0:00）、観点（状態値の平均・割合の指標）、ステータスの変化（変化なし・1回・複数回）。
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoAuthenticated } from './support/helpers.ts';
import {
  ROBOT,
  SENSOR,
  daysAgo,
  durabilityData,
  environmentData,
  hoursAgo,
  merge,
  NOW,
  prepare,
  runEvaluation,
  seed,
  setClock,
  shot,
  type SeededObservation,
} from './support/viewpoint-scenarios.ts';

async function openDetail(page: Page, viewpointId: string, query = ''): Promise<void> {
  await gotoAuthenticated(page, `/viewpoints/${viewpointId}${query}`);
  await expect(page.getByTestId('trend')).toBeVisible();
}

const trend = (page: Page) => page.getByTestId('trend');
const metric = (page: Page, metricId: string) => page.getByTestId(`trend-${metricId}`);
const dots = (locator: Locator) => locator.locator('circle.chart-dot');
const lines = (locator: Locator) => locator.locator('path.chart-line');

function temperatureAt(daysBefore: number, value: number): SeededObservation {
  return {
    equipmentId: SENSOR,
    itemKey: 'temperatureCelsius',
    value,
    observedAt: daysAgo(daysBefore),
  };
}

/** 数値の部分（例: 「期間の平均値: 25.0℃」→ 25）。 */
async function numberOf(locator: Locator): Promise<number> {
  const text = (await locator.textContent()) ?? '';
  const matched = /(-?[\d.]+)/.exec(text.replace(/,/g, ''));
  if (matched?.[1] === undefined) {
    throw new Error(`数値がありません: ${text}`);
  }
  return Number(matched[1]);
}

test.describe('基本フロー: 観点と期間を選び、メトリクスの推移をグラフで確認する', () => {
  test('直近7日の推移を、日ごとのグラフ（値のある日を点、連続する日を線）と期間の平均値で表示する。欠損の日は線を途切れさせる', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    // 6日前〜今日の日ごとの温度。3日前（k=4）は欠損
    await seed(request, {
      observations: [
        temperatureAt(6, 20),
        temperatureAt(5, 22),
        temperatureAt(3, 24),
        temperatureAt(2, 26),
        temperatureAt(1, 28),
        temperatureAt(0, 30),
      ],
    });

    await openDetail(page, 'environmentalAdaptability');

    await expect(trend(page)).toContainText(
      '推移の期間: 2026/10/03 00:00:00 〜 2026/10/09 12:00:00（日ごと）',
    );
    const temperature = metric(page, 'temperatureCelsius');
    await expect(temperature).toHaveAttribute('open', '');
    await expect(dots(temperature)).toHaveCount(6);
    // 連続する区間ごとの線: 2日（20,22）と4日（24〜30）
    await expect(lines(temperature)).toHaveCount(2);
    await expect(page.getByTestId('trend-average-temperatureCelsius')).toContainText(
      '期間の平均値: 25.0℃',
    );
    await expect(temperature.locator('svg')).toHaveAttribute(
      'aria-label',
      '温度の推移（6区間にデータあり）',
    );
    // 点の説明（日付: 値）
    await expect(temperature.locator('circle.chart-dot title').first()).toHaveText('10/03: 20.0℃');
    await expect(temperature.locator('circle.chart-dot title').last()).toHaveText('10/09: 30.0℃');
    // 判断基準の帯（温度は範囲型。注意・正常・注意…）と平均の破線
    await expect(temperature.locator('rect.chart-band').first()).toBeVisible();
    // 水平の線は、高さのない図形のため、表示の判定ではなく、存在で確認する
    await expect(temperature.getByTestId('chart-average-line')).toBeAttached();
    await temperature.scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'trend-daily-7');
    await temperature.screenshot({ path: testInfo.outputPath('trend-chart-temperature.png') });
  });

  test('ダッシュボードで観点と期間を選んで詳細へ進み、推移（グラフ・ステータスの推移）とフィードバックを確認できる。期間を短期へ切り替えると、短期のグラフとフィードバックになる', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, environmentData());

    // 1. 農作業者が、ダッシュボードで、期間（直近30日）を選び、観点（環境適応性）を選ぶ
    await gotoAuthenticated(page, '/?horizon=LONG&periodDays=30');
    await expect(page.getByTestId('card-environmentalAdaptability')).toBeVisible();
    await page
      .getByTestId('card-environmentalAdaptability')
      .locator('h3')
      .getByRole('link')
      .click();
    await expect(page).toHaveURL(
      /\/viewpoints\/environmentalAdaptability\?horizon=LONG&periodDays=30$/,
    );

    // 2. システムが、推移（メトリクスの推移・ステータスの推移）を表示する
    await expect(trend(page)).toContainText(
      '推移の期間: 2026/09/10 00:00:00 〜 2026/10/09 12:00:00（日ごと）',
    );
    await expect(dots(metric(page, 'temperatureCelsius'))).toHaveCount(1);
    await expect(page.getByTestId('status-history')).toBeVisible();
    // 3. システムが、長期のフィードバックを提示する
    await expect(page.getByTestId('feedback-long')).toContainText('長期（直近30日）');

    // 1. 農作業者が、期間を短期へ切り替える → 2・3. 短期の推移（1時間ごと）とフィードバック
    await page.getByRole('radio', { name: '短期' }).check();
    await expect(page).toHaveURL(/horizon=SHORT/);
    await expect(trend(page)).toContainText('（1時間ごと）');
    await expect(page.getByTestId('feedback-short')).toContainText('短期（直近24時間）');
    await expect(page.getByTestId('feedback-short')).toContainText('正常');
    await trend(page).scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'trend-from-dashboard');
  });

  test('主要メトリクスのグラフは開き、それ以外は閉じている。指標ごとに開閉できる', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, environmentData());
    await openDetail(page, 'environmentalAdaptability');

    // 環境適応性は、4指標すべてが主要
    for (const id of ['temperatureCelsius', 'humidityPercent', 'illuminanceLux', 'co2Ppm']) {
      await expect(metric(page, id)).toHaveAttribute('open', '');
    }
    await metric(page, 'humidityPercent').locator('summary').click();
    await expect(metric(page, 'humidityPercent')).not.toHaveAttribute('open', '');
    await expect(metric(page, 'humidityPercent').locator('svg')).toBeHidden();
    await metric(page, 'humidityPercent').locator('summary').click();
    await expect(metric(page, 'humidityPercent').locator('svg')).toBeVisible();

    // 収穫精度は、ダッシュボードに出さないメトリクス（取り残し率・果実損傷率）が閉じている
    await page
      .getByRole('navigation', { name: 'パンくず' })
      .getByRole('link', { name: 'ダッシュボード' })
      .click();
    await page.goto('/viewpoints/harvestAccuracy');
    await expect(trend(page)).toBeVisible();
    await expect(metric(page, 'marketableFruitRatePercent')).toHaveAttribute('open', '');
    await expect(metric(page, 'missedFruitRatePercent')).not.toHaveAttribute('open', '');
    await metric(page, 'missedFruitRatePercent').locator('summary').click();
    await expect(metric(page, 'missedFruitRatePercent')).toHaveAttribute('open', '');
  });
});

test.describe('期間（短期・当日・直近7・30・60・90日）の選択', () => {
  test('短期は、直近24時間の1時間ごとのグラフで、横軸は日本時間の時刻', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    // -23h〜-13h は 18℃、-12h〜-1h は 24℃（1時間ごと）
    const series = (from: number, to: number, value: number) => ({
      equipmentId: SENSOR,
      itemKey: 'temperatureCelsius',
      from: hoursAgo(from),
      to: hoursAgo(to),
      intervalMinutes: 60,
      value,
    });
    await seed(request, { series: [series(23, 13, 18), series(12, 1, 24)] });

    await openDetail(page, 'environmentalAdaptability', '?horizon=SHORT&periodDays=7');

    await expect(trend(page)).toContainText('（1時間ごと）');
    await expect(trend(page)).toContainText(
      '推移の期間: 2026/10/08 13:00:00 〜 2026/10/09 12:00:00',
    );
    const temperature = metric(page, 'temperatureCelsius');
    await expect(dots(temperature)).toHaveCount(23);
    await expect(page.getByTestId('trend-average-temperatureCelsius')).toContainText(
      /期間の平均値: 2[01]\.\d℃/,
    );
    await expect(temperature.locator('circle.chart-dot title').first()).toHaveText('13:00: 18.0℃');
    await expect(temperature.locator('circle.chart-dot title').last()).toHaveText('11:00: 24.0℃');
    await expect(temperature.locator('text.chart-axis-text', { hasText: '13:00' })).toBeVisible();
    await shot(page, testInfo, 'trend-short-hourly');
  });

  test('当日（1日）も、1時間ごとのグラフで、期間の平均値を表示する', async ({ page, request }) => {
    await prepare(request);
    await seed(request, environmentData({ temperature: 22 }, 5));

    await openDetail(page, 'environmentalAdaptability', '?horizon=LONG&periodDays=1');

    await expect(trend(page)).toContainText('（1時間ごと）');
    await expect(dots(metric(page, 'temperatureCelsius'))).toHaveCount(1);
    await expect(page.getByTestId('trend-average-temperatureCelsius')).toContainText(
      '期間の平均値: 22.0℃',
    );
  });

  // 温度: 直近7日=20℃、7〜30日前=30℃、30〜60日前=44℃、60〜90日前=5℃（6時間ごと）。期間の平均値（日ごとの平均の平均）の範囲
  const periods: readonly {
    days: number;
    label: string;
    from: string;
    points: number;
    min: number;
    max: number;
  }[] = [
    { days: 7, label: '直近7日', from: '2026/10/03 00:00:00', points: 7, min: 19.9, max: 20.1 },
    { days: 30, label: '直近30日', from: '2026/09/10 00:00:00', points: 30, min: 27, max: 28.5 },
    { days: 60, label: '直近60日', from: '2026/08/11 00:00:00', points: 60, min: 35, max: 37 },
    { days: 90, label: '直近90日', from: '2026/07/12 00:00:00', points: 90, min: 25, max: 26.5 },
  ];
  for (const period of periods) {
    test(`${period.label}: ${String(period.points)}日分の日ごとのグラフと、期間の平均値を表示する`, async ({
      page,
      request,
    }, testInfo) => {
      await prepare(request);
      const series = (from: number, to: number, value: number) => ({
        equipmentId: SENSOR,
        itemKey: 'temperatureCelsius',
        from: daysAgo(from),
        to: daysAgo(to),
        intervalMinutes: 360,
        value,
      });
      await seed(request, {
        series: [series(90, 60, 5), series(60, 30, 44), series(30, 7, 30), series(7, 0.05, 20)],
      });

      await openDetail(
        page,
        'environmentalAdaptability',
        `?horizon=LONG&periodDays=${String(period.days)}`,
      );

      await expect(trend(page)).toContainText(
        `推移の期間: ${period.from} 〜 2026/10/09 12:00:00（日ごと）`,
      );
      const temperature = metric(page, 'temperatureCelsius');
      await expect(temperature.locator('svg')).toHaveAttribute(
        'aria-label',
        `温度の推移（${String(period.points)}区間にデータあり）`,
      );
      await expect(dots(temperature)).toHaveCount(period.points);
      await expect(lines(temperature)).toHaveCount(1);
      const average = await numberOf(page.getByTestId('trend-average-temperatureCelsius'));
      expect(average).toBeGreaterThanOrEqual(period.min);
      expect(average).toBeLessThanOrEqual(period.max);
      await shot(page, testInfo, `trend-daily-${String(period.days)}`);
    });
  }

  test('期間を選ぶと、推移の期間・グラフ・フィードバックが切り替わる（URL に反映）', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, environmentData());
    await openDetail(page, 'environmentalAdaptability');
    await expect(trend(page)).toContainText('（日ごと）');
    await expect(page.getByTestId('feedback-long')).toContainText('長期（直近7日）');

    await page.getByLabel('長期の期間').selectOption({ label: '直近30日' });

    await expect(page).toHaveURL(/periodDays=30$/);
    await expect(page.getByTestId('feedback-long')).toContainText('長期（直近30日）');
    await expect(trend(page)).toContainText('推移の期間: 2026/09/10 00:00:00');

    await page.getByRole('radio', { name: '短期' }).check();
    await expect(trend(page)).toContainText('（1時間ごと）');
  });
});

test.describe('データの状態（欠損・1区間のみ・境界）', () => {
  test('期間にデータがないとき、グラフの代わりに、データがない旨を示し、平均値は「—」', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, {});

    await openDetail(page, 'environmentalAdaptability');

    for (const id of ['temperatureCelsius', 'humidityPercent', 'illuminanceLux', 'co2Ppm']) {
      await expect(metric(page, id)).toContainText('この期間のデータがありません');
      await expect(metric(page, id).locator('svg')).toHaveCount(0);
      await expect(page.getByTestId(`trend-average-${id}`)).toContainText('期間の平均値: —');
    }
    // 評価は行われている（データなしで「不明」）。最初の評価の「不明」が、状態の記録になる
    await expect(page.getByTestId('status-history').locator('.status-segment')).toHaveText([
      '不明',
    ]);
    await shot(page, testInfo, 'trend-no-data');
  });

  test('評価がまだ行われていなくても、推移の欄は表示し、フィードバックは評価前と示す', async ({
    page,
    request,
  }) => {
    await prepare(request);

    await openDetail(page, 'environmentalAdaptability');

    await expect(page.getByTestId('feedback-long')).toContainText('まだ評価されていません');
    await expect(page.getByTestId('feedback-short')).toContainText('まだ評価されていません');
    await expect(metric(page, 'temperatureCelsius')).toContainText('この期間のデータがありません');
  });

  test('1区間だけにデータがあるとき、点を1つ描き、線は引かない', async ({ page, request }) => {
    await prepare(request);
    await seed(request, { observations: [temperatureAt(0, 22)] });

    await openDetail(page, 'environmentalAdaptability');

    const temperature = metric(page, 'temperatureCelsius');
    await expect(dots(temperature)).toHaveCount(1);
    await expect(lines(temperature)).toHaveCount(0);
    await expect(temperature.locator('circle.chart-dot title')).toHaveText('10/09: 22.0℃');
    await expect(page.getByTestId('trend-average-temperatureCelsius')).toContainText(
      '期間の平均値: 22.0℃',
    );
  });

  test('日の境界（日本時間 0:00）: 0:00 ちょうどの値は新しい日、その1ミリ秒前は前の日の区間に入る', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, {
      observations: [
        {
          equipmentId: SENSOR,
          itemKey: 'temperatureCelsius',
          value: 21,
          observedAt: '2026-10-08T14:59:59.999Z',
        },
        {
          equipmentId: SENSOR,
          itemKey: 'temperatureCelsius',
          value: 29,
          observedAt: '2026-10-08T15:00:00.000Z',
        },
      ],
    });

    await openDetail(page, 'environmentalAdaptability');

    const titles = metric(page, 'temperatureCelsius').locator('circle.chart-dot title');
    await expect(titles).toHaveText(['10/08: 21.0℃', '10/09: 29.0℃']);
  });

  test('割合の指標（収穫精度の可販果率）は、区間ごとに分子・分母のそろった区間だけを点にし、判断基準の帯を背景に描く', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    const hour = (hours: number, damaged: number, wrong: number): SeededObservation[] => [
      { equipmentId: ROBOT, itemKey: 'harvestCount', value: 100, observedAt: hoursAgo(hours) },
      {
        equipmentId: ROBOT,
        itemKey: 'damagedFruitCount',
        value: damaged,
        observedAt: hoursAgo(hours),
        source: 'MANUAL',
      },
      {
        equipmentId: ROBOT,
        itemKey: 'wrongHarvestCount',
        value: wrong,
        observedAt: hoursAgo(hours),
        source: 'MANUAL',
      },
      {
        equipmentId: ROBOT,
        itemKey: 'missedFruitCount',
        value: 0,
        observedAt: hoursAgo(hours),
        source: 'MANUAL',
      },
    ];
    // 3時間前 95%、2時間前 85%、1時間前 70%。4時間前は、分母（収穫数）のみ（可販果率は算出できない）
    await seed(request, {
      observations: [
        ...hour(3, 3, 2),
        ...hour(2, 10, 5),
        ...hour(1, 20, 10),
        { equipmentId: ROBOT, itemKey: 'harvestCount', value: 100, observedAt: hoursAgo(4) },
      ],
    });

    await openDetail(page, 'harvestAccuracy', '?horizon=SHORT&periodDays=7');

    const rate = metric(page, 'marketableFruitRatePercent');
    await expect(dots(rate)).toHaveCount(3);
    await expect(rate.locator('circle.chart-dot title')).toHaveText([
      '09:00: 95.0%',
      '10:00: 85.0%',
      '11:00: 70.0%',
    ]);
    await expect(page.getByTestId('trend-average-marketableFruitRatePercent')).toContainText(
      '期間の平均値: 83.3%',
    );
    // 判断基準（下限型）の3つの帯: 異常・注意・正常
    await expect(rate.locator('rect.chart-band-error')).toHaveCount(1);
    await expect(rate.locator('rect.chart-band-caution')).toHaveCount(1);
    await expect(rate.locator('rect.chart-band-normal')).toHaveCount(1);
    await shot(page, testInfo, 'trend-ratio-metric');
  });
});

test.describe('観点のステータスの推移（FR-6.10）', () => {
  test('ステータスの変化（期間の開始時点・期間内の変化）を、時系列の帯と一覧で表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    // 20日前: 正常 → 5日前: 注意 → 1日前: 異常 → 現在: 注意（直近24時間の観測がなくなり、長期の平均で判定）
    const at = (daysBack: number) => new Date(NOW.getTime() - daysBack * 86_400_000);
    const readingAt = (daysBack: number, value: number): SeededObservation => ({
      equipmentId: SENSOR,
      itemKey: 'temperatureCelsius',
      value,
      observedAt: new Date(at(daysBack).getTime() - 3_600_000).toISOString(),
    });
    await setClock(request, at(20));
    await seed(request, { observations: [readingAt(20, 20)] });
    await setClock(request, at(5));
    await seed(request, { observations: [readingAt(5, 27)] });
    await setClock(request, at(1));
    await seed(request, { observations: [readingAt(1, 40)] });
    await setClock(request, NOW);
    await runEvaluation(request);

    await openDetail(page, 'environmentalAdaptability', '?horizon=LONG&periodDays=30');

    const history = page.getByTestId('status-history');
    await expect(history.locator('.status-segment')).toHaveText(['正常', '注意', '異常', '注意']);
    const items = history.locator('ol li');
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toContainText('2026/09/19 12:00:00');
    await expect(items.nth(0)).toContainText('正常');
    await expect(items.nth(1)).toContainText('2026/10/04 12:00:00');
    await expect(items.nth(1)).toContainText('注意');
    await expect(items.nth(2)).toContainText('2026/10/08 12:00:00');
    await expect(items.nth(2)).toContainText('異常');
    await expect(items.nth(3)).toContainText('2026/10/09 12:00:00');
    await expect(items.nth(3)).toContainText('注意');
    await history.scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'trend-status-history-30');

    // 直近7日: 期間の開始時点（20日前に正常になった状態）から始まる
    await page.getByLabel('長期の期間').selectOption({ label: '直近7日' });
    await expect(history.locator('ol li').first()).toContainText('期間の開始時点');
    await expect(history.locator('ol li').first()).toContainText('正常');
    await expect(history.locator('.status-segment')).toHaveText(['正常', '注意', '異常', '注意']);
    // 期間の開始時点の1件 + 期間内の変化の3件
    await expect(history.locator('ol li')).toHaveCount(4);
    await shot(page, testInfo, 'trend-status-history-7');
  });

  test('期間内にステータスの変化がなく、開始時点のステータスが続くとき、その状態を1本の帯で示す', async ({
    page,
    request,
  }) => {
    await prepare(request);
    // 40日前に、そのときの時刻の1時間前の観測値で「正常」になり、現在まで変化がない
    await setClock(request, new Date(NOW.getTime() - 40 * 86_400_000));
    await seed(request, environmentData({ temperature: 20 }, 40 * 24 + 1));
    await setClock(request, NOW);
    await seed(request, environmentData({ temperature: 20 }, 1));

    await openDetail(page, 'environmentalAdaptability', '?periodDays=7');

    const history = page.getByTestId('status-history');
    await expect(history.locator('.status-segment')).toHaveText(['正常']);
    await expect(history.locator('ol li')).toHaveCount(1);
    await expect(history.locator('ol li')).toContainText('期間の開始時点');
  });
});

test.describe('視点ごとのフィードバック（短期・中長期）と、短期評価を持たない観点', () => {
  test('短期・長期それぞれの診断メッセージと推奨アクションを提示する（短期が異常、長期が注意）', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(
      request,
      merge(environmentData({ temperature: 20 }, 48), environmentData({ temperature: 40 }, 1)),
    );

    await openDetail(page, 'environmentalAdaptability');

    const short = page.getByTestId('feedback-short');
    const long = page.getByTestId('feedback-long');
    await expect(short).toContainText('短期（直近24時間）');
    await expect(short).toContainText('異常');
    await expect(short).toContainText('環境適応性: 異常。温度 40.0℃（異常）');
    await expect(short).toContainText('対応が必要な状態です');
    await expect(long).toContainText('長期（直近7日）');
    await expect(long).toContainText('注意');
    await expect(long).toContainText('温度 30.0℃（注意）');
    await expect(long).toContainText('確認が望ましい状態です');
    await short.scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'trend-feedback');
  });

  test('短期評価を持たない観点（耐久性）は、短期のフィードバックを表示せず、その旨を示す。推移は長期（日ごと）', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, durabilityData('NORMAL'));

    await openDetail(page, 'durability', '?horizon=SHORT&periodDays=30');

    await expect(page.getByTestId('feedback-short')).toHaveCount(0);
    await expect(page.getByTestId('no-short-note')).toContainText('短期評価はありません');
    await expect(page.getByTestId('feedback-long')).toContainText('長期（直近30日）');
    await expect(trend(page)).toContainText(
      'この観点は短期評価を持たないため、長期の結果を表示しています',
    );
    await expect(trend(page)).toContainText('（日ごと）');
    await expect(dots(metric(page, 'mtbfHours'))).toHaveCount(1);
    await shot(page, testInfo, 'trend-no-short-horizon');
  });

  test('短期評価を持たない他の観点（コスト効率・データ活用度合い）も、短期のフィードバックを表示しない', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, durabilityData('NORMAL'));

    for (const viewpointId of ['costEfficiency', 'dataUtilization']) {
      await openDetail(page, viewpointId, '?horizon=SHORT');
      await expect(page.getByTestId('feedback-short')).toHaveCount(0);
      await expect(page.getByTestId('feedback-long')).toBeVisible();
    }
  });
});

test.describe('画面の表示（レイアウト）', () => {
  for (const viewport of [
    { name: 'デスクトップ幅（1280px）', width: 1280, height: 720 },
    { name: 'タブレット幅（768px）', width: 768, height: 1024 },
  ]) {
    test(`${viewport.name}: グラフ（目盛りの文字から軸の右端まで）が、カードの中で左右に偏らず、余計な隙間もない`, async ({
      page,
      request,
    }) => {
      await prepare(request);
      await seed(request, {
        observations: [temperatureAt(6, 20), temperatureAt(3, 24), temperatureAt(0, 30)],
      });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openDetail(page, 'environmentalAdaptability');

      const temperature = metric(page, 'temperatureCelsius');
      await temperature.scrollIntoViewIfNeeded();
      const gaps = await temperature.evaluate((details) => {
        const card = details.getBoundingClientRect();
        const rects = [...details.querySelectorAll('svg.line-chart text, svg.line-chart rect')].map(
          (element) => element.getBoundingClientRect(),
        );
        const left = Math.min(...rects.map((rect) => rect.left));
        const right = Math.max(...rects.map((rect) => rect.right));
        return { left: left - card.left, right: card.right - right, card: card.width };
      });
      // 左右の隙間の差が小さい（偏らない）。隙間は、カードの幅の2割以内（余計な隙間がない）
      expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(16);
      expect(gaps.left).toBeLessThanOrEqual(gaps.card * 0.2);
      expect(gaps.right).toBeLessThanOrEqual(gaps.card * 0.2);
    });
  }

  test('タブレット幅（768px）でも、グラフが横幅に収まり、重ならない', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, {
      observations: [
        temperatureAt(6, 20),
        temperatureAt(4, 22),
        temperatureAt(2, 24),
        temperatureAt(0, 30),
      ],
    });
    await page.setViewportSize({ width: 768, height: 1024 });

    await openDetail(page, 'environmentalAdaptability');

    await expect(dots(metric(page, 'temperatureCelsius'))).toHaveCount(4);
    await trend(page).scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'trend-tablet');
  });
});
