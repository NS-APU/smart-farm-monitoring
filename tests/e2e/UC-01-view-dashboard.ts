/**
 * UC-01 観点別の状態をダッシュボードで確認する（SC-02。FR-5.1〜5.4、FR-6.1〜6.3、6.6、6.7 / NFR-3.3、NFR-3.4）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者がダッシュボードを開く
 *               2. システムが、評価観点ごとの状態とメトリクスの状態を表示する
 *               3. 農作業者が、対象のハウス・ロボット・センサーを選んで状態を確認する
 *   代替フロー  データがまだ取り込まれていない・古い場合は、その旨を表示する
 *
 * 値の同値分割: ステータス（正常・注意・異常・不明）、視点（短期・長期）、期間（当日・7・30・60・90日）、
 * 設備の種別（ハウス・ロボット・センサー）、データの状態（なし・古い・新しい・欠損・不正・遅延）、境界値（古いの基準 45分）。
 */

import { expect, test, type Page } from '@playwright/test';
import { gotoAuthenticated, loginViaUi } from './support/helpers.ts';
import { dashboardCard as card, openDashboard } from './support/pages.ts';
import {
  MIXED_EXPECTED,
  NOW,
  SENSOR,
  VIEWPOINT_ORDER,
  daysAgo,
  environmentData,
  harvestAccuracyData,
  hoursAgo,
  merge,
  mixedScenario,
  prepare,
  runEvaluation,
  seed,
  shot,
} from './support/viewpoint-scenarios.ts';

async function summaryCount(page: Page, status: string): Promise<number> {
  return Number(
    await page.getByTestId(`summary-${status}`).locator('.summary-count').textContent(),
  );
}

test.describe('基本フロー: ダッシュボードを開き、観点ごとの状態とメトリクスを確認する', () => {
  test('4つのステータスが混在するとき、10観点が表示順に並び、観点ごとのステータス・件数・診断メッセージ・推奨アクション・対象期間が表示される', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, mixedScenario());

    await openDashboard(page);

    // 10観点のカードが、表示順（evaluation.md 1章）に並ぶ
    await expect(page.locator('.viewpoint-card')).toHaveCount(10);
    await expect(page.locator('.viewpoint-card h3')).toHaveText(
      VIEWPOINT_ORDER.map(([, name]) => name),
    );
    // 観点ごとのステータス
    for (const [viewpointId] of VIEWPOINT_ORDER) {
      await expect(card(page, viewpointId).locator('.status-badge')).toContainText(
        MIXED_EXPECTED[viewpointId],
      );
    }
    // ステータスごとの件数（正常2・注意2・異常3・不明3）
    expect(await summaryCount(page, 'NORMAL')).toBe(2);
    expect(await summaryCount(page, 'CAUTION')).toBe(2);
    expect(await summaryCount(page, 'ERROR')).toBe(3);
    expect(await summaryCount(page, 'UNKNOWN')).toBe(3);
    // 診断メッセージ・推奨アクション・判定の対象期間（2026/10/02 12:00 〜 2026/10/09 12:00）
    const accuracy = card(page, 'harvestAccuracy');
    await expect(accuracy.locator('.diagnostic')).toContainText('収穫精度: 正常');
    await expect(accuracy.locator('.action')).toContainText(
      '推奨アクション: 現在の状態を維持し、引き続き推移を確認してください',
    );
    await expect(accuracy.locator('.evaluated-period')).toContainText(
      '判定の対象期間: 2026/10/02 12:00:00 〜 2026/10/09 12:00:00',
    );
    // 対象の設備と、最終の評価日時
    await expect(page.locator('.page-meta')).toContainText('対象: ハウス1');
    await expect(page.locator('.page-meta')).toContainText('最終の評価: 2026/10/09 12:00:00');
    await shot(page, testInfo, 'dashboard-mixed');
  });

  test('主要メトリクスの値と、メトリクスごとの判定（アイコン・文字・色）が表示される。ステータスコードは名称で表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, mixedScenario());

    await openDashboard(page);

    // 収穫精度（正常）: 可販果率 98.7%、認識精度 98.7%
    const accuracy = card(page, 'harvestAccuracy');
    await expect(accuracy.locator('dd.metric-normal').first()).toContainText('98.7%');
    await expect(accuracy.locator('dt', { hasText: '可販果率' })).toBeVisible();
    await expect(accuracy.locator('dt', { hasText: '認識精度' })).toBeVisible();
    // 収穫速度（注意）: 平均処理時間 64.8秒/果実（注意）、走行停止率 2.0%（正常）、ステータスは名称（収穫中）
    const speed = card(page, 'harvestSpeed');
    await expect(speed.locator('dd.metric-caution')).toContainText('64.8秒/果実');
    await expect(speed.locator('dd.metric-normal').filter({ hasText: '2.0%' })).toBeVisible();
    await expect(speed.locator('dd', { hasText: '収穫中' })).toHaveClass(/metric-normal/);
    // 環境適応性（異常）: 温度 40.0℃（異常）、湿度・照度・CO2 は正常
    const environment = card(page, 'environmentalAdaptability');
    await expect(environment.locator('dd.metric-error')).toContainText('40.0℃');
    await expect(environment.locator('dd.metric-normal')).toHaveCount(3);
    await expect(environment.locator('dd', { hasText: '30000lx' })).toHaveClass(/metric-normal/);
    // 不明の観点: メトリクスは「—」
    await expect(card(page, 'operability').locator('dd').first()).toHaveText('—');
    await shot(page, testInfo, 'dashboard-metrics');
  });

  test('観点のカードを選ぶと、観点の詳細へ移る（選んだ視点・期間を引き継ぐ）。満足度は、満足度の詳細へ移る', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await openDashboard(page, '?horizon=SHORT&periodDays=30');

    await card(page, 'environmentalAdaptability').locator('h3').getByRole('link').click();
    await expect(page).toHaveURL(
      /\/viewpoints\/environmentalAdaptability\?horizon=SHORT&periodDays=30$/,
    );
    await expect(page.getByRole('heading', { name: /環境適応性/, level: 1 })).toBeVisible();

    await page
      .getByRole('navigation', { name: 'パンくず' })
      .getByRole('link', { name: 'ダッシュボード' })
      .click();
    await expect(page).toHaveURL(/\/\?horizon=SHORT&periodDays=30$/);
    await card(page, 'satisfaction').locator('h3').getByRole('link').click();
    await expect(page).toHaveURL(/\/satisfaction\?periodDays=30$/);
    await expect(page.getByRole('heading', { name: /満足度の詳細/, level: 1 })).toBeVisible();
  });
});

test.describe('基本フロー 3: 対象のハウス・ロボット・センサーを選んで状態を確認する（設備の種別）', () => {
  test('ハウスは10観点、ロボットは7観点、センサーは環境適応性のみを表示し、設備ごとのデータだけで評価する', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await openDashboard(page);
    await expect(page.locator('.viewpoint-card')).toHaveCount(10);

    // ロボット: ロボットの観点（収穫精度・収穫速度・操作性・メンテナンス性・コスト効率・安全性・耐久性）
    await page.getByLabel('対象の設備').selectOption({ label: '　収穫ロボット1' });
    await expect(page.locator('.viewpoint-card')).toHaveCount(7);
    await expect(page.locator('.viewpoint-card h3')).toHaveText([
      '収穫精度',
      '収穫速度',
      '操作性',
      'メンテナンス性',
      'コスト効率',
      '安全性',
      '耐久性',
    ]);
    await expect(page.locator('.page-meta')).toContainText('対象: 収穫ロボット1');
    await expect(card(page, 'harvestSpeed').locator('.status-badge')).toContainText('注意');
    await expect(card(page, 'safety').locator('.status-badge')).toContainText('注意');
    await shot(page, testInfo, 'dashboard-robot');

    // センサー: 環境適応性のみ（センサーの観測値だけで評価する）
    await page.getByLabel('対象の設備').selectOption({ label: '　環境センサー1' });
    await expect(page.locator('.viewpoint-card')).toHaveCount(1);
    await expect(card(page, 'environmentalAdaptability').locator('.status-badge')).toContainText(
      '異常',
    );
    await expect(page.locator('.page-meta')).toContainText('対象: 環境センサー1');
    await shot(page, testInfo, 'dashboard-sensor');

    // ハウスへ戻す
    await page.getByLabel('対象の設備').selectOption({ label: 'ハウス1' });
    await expect(page.locator('.viewpoint-card')).toHaveCount(10);
    await shot(page, testInfo, 'dashboard-house');
  });

  test('ロボットを選んだとき、他の設備のデータは評価に使わない（センサーのデータだけがある場合、ロボットの観点は不明）', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, environmentData({ temperature: 20 }));
    await openDashboard(page);

    await page.getByLabel('対象の設備').selectOption({ label: '　収穫ロボット1' });

    await expect(page.locator('.viewpoint-card')).toHaveCount(7);
    await expect(page.locator('.viewpoint-card .status-badge', { hasText: '不明' })).toHaveCount(7);
  });
});

test.describe('ステータスの同値分割（正常・注意・異常・不明）', () => {
  const cases = [
    {
      name: '正常',
      status: 'NORMAL',
      temperature: 20,
      expected: '正常',
      icon: '✔',
      border: 'normal',
    },
    {
      name: '注意',
      status: 'CAUTION',
      temperature: 27,
      expected: '注意',
      icon: '▲',
      border: 'caution',
    },
    {
      name: '異常',
      status: 'ERROR',
      temperature: 40,
      expected: '異常',
      icon: '✖',
      border: 'error',
    },
  ] as const;

  for (const item of cases) {
    test(`環境適応性が${item.name}（温度 ${String(item.temperature)}℃）のとき、色・アイコン・文字でステータスを示し、件数に反映される`, async ({
      page,
      request,
    }, testInfo) => {
      await prepare(request);
      await seed(request, environmentData({ temperature: item.temperature }));

      await openDashboard(page);

      const environment = card(page, 'environmentalAdaptability');
      await expect(environment).toHaveClass(new RegExp(`status-border-${item.border}`));
      const badge = environment.locator('.status-badge');
      await expect(badge).toContainText(item.expected);
      await expect(badge).toContainText(item.icon);
      await expect(badge).toHaveClass(new RegExp(`status-${item.border}`));
      // 環境適応性だけが評価できる。データ活用度合いは、ロボット・手動入力の取得がないため異常（取得の割合が低い）。他の8観点は不明
      const expectedCounts = { NORMAL: 0, CAUTION: 0, ERROR: 1, UNKNOWN: 8 };
      expectedCounts[item.status] += 1;
      for (const [status, count] of Object.entries(expectedCounts)) {
        expect(await summaryCount(page, status), status).toBe(count);
      }
      await shot(page, testInfo, `dashboard-status-${item.border}`);
    });
  }

  test('不明（評価に必要なデータがない）のとき、データ不足の旨と、取得・入力を確認する推奨アクションを表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, {});

    await openDashboard(page);

    const accuracy = card(page, 'harvestAccuracy');
    await expect(accuracy.locator('.status-badge')).toContainText('不明');
    await expect(accuracy.locator('.status-badge')).toContainText('?');
    await expect(accuracy.locator('.diagnostic')).toContainText('データ不足のため評価できません');
    await expect(accuracy.locator('.action')).toContainText('データの取得・入力を確認してください');
    expect(await summaryCount(page, 'UNKNOWN')).toBe(10);
    await shot(page, testInfo, 'dashboard-all-unknown');
  });

  test('観点の最終ステータスは、短期・長期のうち「不明」を除いた悪い方（短期が異常・長期が注意なら異常）', async ({
    page,
    request,
  }) => {
    await prepare(request);
    // 直近24時間の外（2日前）が正常な温度 20℃、直近が異常な温度 40℃ → 短期は異常、長期（7日）の平均 30℃ は注意
    await seed(
      request,
      merge(environmentData({ temperature: 20 }, 48), environmentData({ temperature: 40 }, 1)),
    );

    await openDashboard(page);

    await expect(card(page, 'environmentalAdaptability').locator('.status-badge')).toContainText(
      '異常',
    );
    // 観点の詳細で、短期（異常）と長期（注意）が、それぞれ別に示される
    await gotoAuthenticated(page, '/viewpoints/environmentalAdaptability');
    await expect(page.getByTestId('horizon-short').locator('.status-badge')).toContainText('異常');
    await expect(page.getByTestId('horizon-long').locator('.status-badge')).toContainText('注意');
  });
});

test.describe('視点（短期・長期）と期間の選択', () => {
  test('短期と長期を切り替えられる（短期は最新の観測値、長期は期間の平均）。選択は URL に反映され、再読み込みで保持される', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    // 2日前: 温度 20℃、1時間前: 温度 30℃ → 短期（最新）30℃、長期（7日の平均）25℃
    await seed(
      request,
      merge(environmentData({ temperature: 20 }, 48), environmentData({ temperature: 30 }, 1)),
    );
    await openDashboard(page);
    const environment = card(page, 'environmentalAdaptability');
    await expect(environment.locator('dd', { hasText: '25.0℃' })).toBeVisible();

    await page.getByRole('radio', { name: '短期' }).check();

    await expect(page).toHaveURL(/\?horizon=SHORT&periodDays=7$/);
    await expect(environment.locator('dd', { hasText: '30.0℃' })).toBeVisible();
    await expect(environment.locator('.evaluated-period')).toContainText(
      '判定の対象期間: 2026/10/08 12:00:00 〜 2026/10/09 12:00:00',
    );
    await shot(page, testInfo, 'dashboard-short');

    await page.reload();
    await expect(page.getByRole('radio', { name: '短期' })).toBeChecked();
    await expect(environment.locator('dd', { hasText: '30.0℃' })).toBeVisible();

    await page.getByRole('radio', { name: '長期' }).check();
    await expect(environment.locator('dd', { hasText: '25.0℃' })).toBeVisible();
  });

  test('短期評価を持たない観点（コスト効率・耐久性・データ活用度合い・満足度）は、短期を選んでも長期の結果を表示し、その旨を示す', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await openDashboard(page, '?horizon=SHORT&periodDays=7');

    const withoutShort = ['costEfficiency', 'durability', 'dataUtilization', 'satisfaction'];
    for (const viewpointId of withoutShort) {
      await expect(card(page, viewpointId)).toContainText(
        'この観点は短期評価を持たないため、長期の結果を表示しています',
      );
      await expect(card(page, viewpointId).locator('.evaluated-period').first()).toContainText(
        '2026/10/02 12:00:00 〜 2026/10/09 12:00:00',
      );
    }
    // 短期評価を持つ観点には、示さない
    await expect(card(page, 'harvestAccuracy')).not.toContainText('短期評価を持たない');
    // 評価前の観点（満足度・コスト効率は、データなしで「不明」と評価済み）にも、長期の期間を示す
    await expect(card(page, 'durability').locator('.evaluated-period').first()).toContainText(
      '2026/10/02 12:00:00 〜 2026/10/09 12:00:00',
    );
  });

  test.describe('長期の期間（当日・直近7日・30日・60日・90日）で、評価の対象期間とステータスが変わる', () => {
    // 温度: 直近7日=20℃（正常）、7〜30日前=30℃、30〜60日前=44℃、60〜90日前=5℃（6時間ごと）
    // 期間ごとの平均: 当日 20（正常）、7日 20（正常）、30日 約27.6（注意）、60日 約35.8（異常）、90日 約25.6（注意）
    const periods = [
      { days: 1, label: '当日', status: '正常', from: '2026/10/08 12:00:00', value: /20\.0℃/ },
      { days: 7, label: '直近7日', status: '正常', from: '2026/10/02 12:00:00', value: /20\.0℃/ },
      {
        days: 30,
        label: '直近30日',
        status: '注意',
        from: '2026/09/09 12:00:00',
        value: /27\.\d℃/,
      },
      {
        days: 60,
        label: '直近60日',
        status: '異常',
        from: '2026/08/10 12:00:00',
        value: /35\.\d℃/,
      },
      {
        days: 90,
        label: '直近90日',
        status: '注意',
        from: '2026/07/11 12:00:00',
        value: /25\.\d℃/,
      },
    ] as const;

    for (const period of periods) {
      test(`${period.label}: 判定の対象期間は ${period.from} から、ステータスは${period.status}`, async ({
        page,
        request,
      }, testInfo) => {
        await prepare(request);
        await seed(request, periodScenario());
        await openDashboard(page);

        await page.getByLabel('長期の期間').selectOption({ label: period.label });

        const environment = card(page, 'environmentalAdaptability');
        await expect(page).toHaveURL(new RegExp(`periodDays=${String(period.days)}$`));
        await expect(environment.locator('.evaluated-period')).toContainText(
          `判定の対象期間: ${period.from} 〜 2026/10/09 12:00:00`,
        );
        await expect(environment.locator('.status-badge')).toContainText(period.status);
        await expect(
          environment.locator('dl.metrics > div').filter({ hasText: '温度' }).locator('dd'),
        ).toHaveText(period.value);
        await shot(page, testInfo, `dashboard-period-${String(period.days)}`);
      });
    }
  });
});

/** 期間ごとに、環境適応性の温度が変わるデータ（直近7日 20℃ → 7〜30日前 30℃ → 30〜60日前 44℃ → 60〜90日前 5℃）。 */
function periodScenario() {
  const series = (from: number, to: number, value: number) => ({
    equipmentId: SENSOR,
    itemKey: 'temperatureCelsius',
    from: daysAgo(from),
    to: daysAgo(to),
    intervalMinutes: 360,
    value,
  });
  return {
    series: [series(90, 60, 5), series(60, 30, 44), series(30, 7, 30), series(7, 0.05, 20)],
  };
}

test.describe('代替フロー: データがまだ取り込まれていない・古い場合は、その旨を表示する', () => {
  test('データが1件もない（未取得）とき、その旨と、データ入力・取り込み設定への導線を表示し、観点は評価前の「不明」', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);

    await openDashboard(page);

    const notice = page.getByText(
      'データがまだ取り込まれていません。データ入力または取り込み設定を確認してください',
    );
    await expect(notice).toBeVisible();
    await expect(page.getByText('最終のデータ取得:')).toBeVisible();
    await expect(page.locator('.header-data-status')).toContainText('未取得');
    await expect(card(page, 'harvestAccuracy').locator('.diagnostic')).toContainText(
      '評価がまだ行われていません',
    );
    expect(await summaryCount(page, 'UNKNOWN')).toBe(10);
    await shot(page, testInfo, 'dashboard-none');

    // 導線: データ入力・取り込み設定
    await page.locator('.notice').getByRole('link', { name: 'データ入力へ' }).click();
    await expect(page).toHaveURL(/\/data-entry$/);
    await page.goBack();
    await page.locator('.notice').getByRole('link', { name: '取り込み設定・状況へ' }).click();
    await expect(page).toHaveURL(/\/settings\/ingestion$/);
  });

  test('設備が1つも登録されていなければ、その旨と、設備の登録への導線を表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request, { equipment: false });

    await page.goto('/');
    await loginViaUi(page);

    await expect(page.getByText('設備が登録されていません。設備を登録してください')).toBeVisible();
    await expect(page.getByLabel('対象の設備')).toBeDisabled();
    await shot(page, testInfo, 'dashboard-no-equipment');
    await page.locator('main').getByRole('link', { name: '設備' }).click();
    await expect(page).toHaveURL(/\/settings\/equipment$/);
    await shot(page, testInfo, 'dashboard-no-equipment-link');
  });

  // 「古い」の基準: 最終のデータ取得（受信）から、取得間隔（15分）× 3 = 45分を超えたら古い（境界値 45分・46分）
  const freshness = [
    { minutes: 0, stale: false },
    { minutes: 44, stale: false },
    { minutes: 45, stale: false },
    { minutes: 46, stale: true },
    { minutes: 600, stale: true },
  ] as const;

  for (const item of freshness) {
    test(`最終のデータ取得が ${String(item.minutes)} 分前なら、${item.stale ? '古い旨の警告を表示する' : '警告を表示しない'}`, async ({
      page,
      request,
    }, testInfo) => {
      await prepare(request);
      await seed(request, {
        observations: [
          {
            equipmentId: SENSOR,
            itemKey: 'temperatureCelsius',
            value: 20,
            observedAt: new Date(NOW.getTime() - item.minutes * 60_000).toISOString(),
          },
        ],
      });

      await openDashboard(page);

      const warning = page.getByRole('alert').filter({ hasText: 'データが古くなっています' });
      if (item.stale) {
        await expect(warning).toBeVisible();
        await expect(page.locator('.header-data-status')).toContainText('（古い）');
      } else {
        await expect(warning).toHaveCount(0);
        await expect(page.locator('.header-data-status')).not.toContainText('古い');
      }
      await expect(page.locator('.header-data-status')).toContainText('最終のデータ取得');
      if (item.minutes === 46 || item.minutes === 0) {
        await shot(page, testInfo, `dashboard-freshness-${String(item.minutes)}min`);
      }
    });
  }
});

test.describe('データの欠損・不正・遅延', () => {
  test('一部のデータだけがある（センサーのみ・ロボットのみ）とき、取得できた観点だけを評価し、他は不明にする', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, harvestAccuracyData('CAUTION'));

    await openDashboard(page);

    await expect(card(page, 'harvestAccuracy').locator('.status-badge')).toContainText('注意');
    await expect(card(page, 'environmentalAdaptability').locator('.status-badge')).toContainText(
      '不明',
    );
    expect(await summaryCount(page, 'CAUTION')).toBe(1);

    // センサーのデータだけがあるとき: 環境適応性だけを評価し、ロボットの観点は不明にする
    await prepare(request);
    await seed(request, environmentData({ temperature: 27 }));

    await openDashboard(page);

    await expect(card(page, 'environmentalAdaptability').locator('.status-badge')).toContainText(
      '注意',
    );
    await expect(card(page, 'harvestAccuracy').locator('.status-badge')).toContainText('不明');
    expect(await summaryCount(page, 'CAUTION')).toBe(1);
  });

  test('環境の一部の指標だけ取得できているとき、取得できた指標だけで判定し、欠けた指標のメトリクスは「—」にする', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(
      request,
      environmentData({ temperature: 27, humidity: null, illuminance: null, co2: null }),
    );

    await openDashboard(page);

    const environment = card(page, 'environmentalAdaptability');
    await expect(environment.locator('.status-badge')).toContainText('注意');
    await expect(environment.locator('dd', { hasText: '—' })).toHaveCount(3);
    await expect(environment.locator('dd.metric-caution')).toContainText('27.0℃');
  });

  test('不正な値（品質 INVALID）・欠損（MISSING）は評価に使わない。遅延（LATE）の値は使う', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, {
      observations: [
        {
          equipmentId: SENSOR,
          itemKey: 'temperatureCelsius',
          value: 99,
          observedAt: hoursAgo(2),
          quality: 'INVALID',
        },
        {
          equipmentId: SENSOR,
          itemKey: 'humidityPercent',
          value: null,
          observedAt: hoursAgo(2),
          quality: 'MISSING',
        },
        {
          equipmentId: SENSOR,
          itemKey: 'illuminanceLux',
          value: 30_000,
          observedAt: hoursAgo(3),
          receivedAt: hoursAgo(1),
          quality: 'LATE',
        },
      ],
    });

    await openDashboard(page);

    const environment = card(page, 'environmentalAdaptability');
    // 使えるのは、遅延の照度（正常）だけ
    await expect(environment.locator('.status-badge')).toContainText('正常');
    await expect(environment.locator('dd', { hasText: '30000lx' })).toBeVisible();
    await expect(environment.getByText('99.0℃')).toHaveCount(0);
    await expect(environment.locator('dd', { hasText: '—' })).toHaveCount(3);
  });
});

test.describe('更新（FR-6.7）', () => {
  test('約10秒間隔で、最新の評価結果を読み直す（再読み込みせずに、状態の変化が反映される）', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(60_000);
    await prepare(request);
    await seed(request, environmentData({ temperature: 20 }));
    await openDashboard(page);
    const environment = card(page, 'environmentalAdaptability');
    await expect(environment.locator('.status-badge')).toContainText('正常');
    await shot(page, testInfo, 'dashboard-before-refresh');

    // 別の経路（取り込み・手動入力）でデータが変わり、評価が更新される
    await seed(request, environmentData({ temperature: 40 }, 0.5));

    await expect(environment.locator('.status-badge')).toContainText('異常', { timeout: 20_000 });
    await shot(page, testInfo, 'dashboard-after-refresh');
  });

  test('変化がなければ、読み直しの応答は小さな応答（304）になり、表示はそのまま保たれる。変化があれば、200 で新しい内容に変わる', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90_000);
    await prepare(request);
    await seed(request, environmentData({ temperature: 20 }));
    const statuses: number[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/v1/dashboard') {
        statuses.push(response.status());
      }
    });
    await openDashboard(page);
    const environment = card(page, 'environmentalAdaptability');
    await expect(environment.locator('.status-badge')).toContainText('正常');

    // 約10秒後の読み直し（1回目は 200、変化がなければ 2回目は 304）
    await expect.poll(() => statuses.length, { timeout: 25_000 }).toBeGreaterThanOrEqual(2);
    expect(statuses.slice(0, 2)).toEqual([200, 304]);
    await expect(environment.locator('.status-badge')).toContainText('正常');
    await expect(page.locator('.viewpoint-card')).toHaveCount(10);
    await shot(page, testInfo, 'dashboard-not-modified');

    // 評価が変わると、次の読み直しは 200 になり、画面が変わる
    await seed(request, environmentData({ temperature: 40 }, 0.5));
    await expect(environment.locator('.status-badge')).toContainText('異常', { timeout: 25_000 });
    expect(statuses).toContain(200);
    expect(statuses.at(-1)).toBe(200);
  });

  test('評価の更新（定期の評価。JB-02）の後も、保存済みの評価結果を表示する', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await runEvaluation(request);

    await openDashboard(page);

    expect(await summaryCount(page, 'NORMAL')).toBe(2);
    expect(await summaryCount(page, 'ERROR')).toBe(3);
  });
});

test.describe('性能（NFR-3.4）', () => {
  test('ダッシュボードの初期表示（再読み込みから、10観点のカードの表示まで）が3秒以内に完了する', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await openDashboard(page);

    const startedAt = Date.now();
    await page.reload();
    await expect(page.locator('.viewpoint-card')).toHaveCount(10);

    expect(Date.now() - startedAt).toBeLessThan(3000);
  });
});

test.describe('画面の表示（レイアウト）', () => {
  test('タブレット幅（768px）でも、横スクロールや要素の重なりなく表示できる', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await page.setViewportSize({ width: 768, height: 1024 });

    await openDashboard(page);

    await expect(page.locator('.viewpoint-card')).toHaveCount(10);
    await shot(page, testInfo, 'dashboard-tablet');
  });

  test('ロボットを選ぶと、カードが奇数（7）でも、最後のカードが横幅いっぱいに広がり、隙間ができない', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await openDashboard(page);

    await page.getByLabel('対象の設備').selectOption({ label: '　収穫ロボット1' });
    await expect(page.locator('.viewpoint-card')).toHaveCount(7);

    const boxes = await page.locator('.viewpoint-card').evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: Math.round(rect.left), right: Math.round(rect.right) };
      }),
    );
    const last = boxes.at(-1);
    const first = boxes[0];
    expect(last?.left).toBe(first?.left);
    expect(last?.right).toBe(Math.max(...boxes.map((box) => box.right)));
  });
});
