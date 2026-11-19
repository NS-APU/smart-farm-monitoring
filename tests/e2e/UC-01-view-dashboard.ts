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
import { HOUSE_ID, apiOk, setEquipmentInterval } from './support/app.ts';
import { assignPlaceholderPaths } from './support/http-files.ts';
import { gotoAuthenticated, loginViaUi } from './support/helpers.ts';
import {
  dashboardCard as card,
  expectEquipmentFieldIntact,
  expectNoHorizontalScroll,
  openDashboard,
} from './support/pages.ts';
import {
  MIXED_EXPECTED,
  NOW,
  ROBOT,
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
    // 対象のハウスと、最終の評価日時
    await expect(page.getByLabel('対象のハウス')).toHaveValue(HOUSE_ID);
    await expect(page.getByTestId('dashboard-meta')).toContainText(
      '最終の評価: 2026/10/09 12:00:00',
    );
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

  test('観点のカード・観点別の状態の表を選ぶと、観点の詳細が、右からのドロワーに開く（選んだ期間を引き継ぐ）。満足度は、満足度の詳細が開く（詳しい確認は、scenario-viewpoint-drawer.ts）', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await openDashboard(page, '?periodDays=30');

    await card(page, 'environmentalAdaptability').locator('h3').getByRole('link').click();
    await expect(page).toHaveURL(/\/\?viewpoint=environmentalAdaptability&periodDays=30$/);
    const dialog = page.getByRole('dialog', { name: '環境適応性の詳細' });
    await expect(dialog.getByRole('heading', { name: /環境適応性/, level: 2 })).toBeVisible();
    await dialog.getByRole('button', { name: '観点の詳細を閉じる' }).click();
    // 閉じると、ダッシュボードの期間が残る
    await expect(page).toHaveURL(/\/\?periodDays=30$/);

    await card(page, 'satisfaction').locator('h3').getByRole('link').click();
    await expect(page).toHaveURL(/\/\?viewpoint=satisfaction&periodDays=30$/);
    await expect(
      page.getByRole('dialog', { name: '満足度の詳細' }).getByRole('heading', {
        name: /満足度の詳細/,
        level: 2,
      }),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    // 観点別の状態の表の行からも、同じ詳細が開く
    await page.getByTestId('status-row-safety').getByRole('link').click();
    await expect(page).toHaveURL(/\/\?viewpoint=safety&periodDays=30$/);
    await expect(page.getByRole('dialog', { name: '安全性の詳細' })).toBeVisible();
  });
});

test.describe('基本フロー 3: 対象のハウスを選んで状態を確認する。ロボット・センサーの状態は、観点の詳細で確認する（Issue #355）', () => {
  test('ダッシュボードはハウス単位: 「対象のハウス」は、ハウスだけを選べ、10 観点を示す（ヘッダーに、対象の設備の選択はない）', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await openDashboard(page);

    await expect(page.locator('.viewpoint-card')).toHaveCount(10);
    const select = page.getByLabel('対象のハウス');
    await expect(select.locator('option')).toHaveText(['ハウス1']);
    await expect(select).toHaveValue(HOUSE_ID);
    await expect(page.getByRole('banner').getByLabel('対象の設備')).toHaveCount(0);
    await shot(page, testInfo, 'dashboard-house');
  });

  test('ロボットは、観点の詳細で「対象の設備」に選んで確認する。ロボットの観点（収穫速度など）は評価し、センサーでは評価しない（この設備では評価しない旨）', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await gotoAuthenticated(page, '/viewpoints/harvestSpeed');
    await expect(page.getByRole('heading', { name: /収穫速度/, level: 1 })).toBeVisible();

    await page.getByLabel('対象の設備').selectOption({ label: '　収穫ロボット1' });
    await expect(page.getByRole('heading', { name: /収穫速度/, level: 1 })).toContainText('注意');
    await shot(page, testInfo, 'detail-robot');

    await page.getByLabel('対象の設備').selectOption({ label: '　環境センサー1' });
    await expect(page.getByTestId('not-applicable')).toBeVisible();
  });

  test('センサーは、観点の詳細で選んで確認する（環境適応性。センサーの観測値だけで評価する）', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await gotoAuthenticated(page, '/viewpoints/environmentalAdaptability');

    await page.getByLabel('対象の設備').selectOption({ label: '　環境センサー1' });

    await expect(page.getByRole('heading', { name: /環境適応性/, level: 1 })).toContainText('異常');
    await shot(page, testInfo, 'detail-sensor');
  });

  test('ロボットを選んだとき、他の設備のデータは評価に使わない（センサーのデータだけがある場合、ロボットの観点は不明）', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, environmentData({ temperature: 20 }));
    await gotoAuthenticated(page, '/viewpoints/harvestAccuracy');

    await page.getByLabel('対象の設備').selectOption({ label: '　収穫ロボット1' });

    await expect(page.getByRole('heading', { name: /収穫精度/, level: 1 })).toContainText('不明');
  });

  test('詳細で、ロボット・センサーを選んだあと、ダッシュボードへ戻ると、その設備のハウスを対象にする（ダッシュボードはハウス単位）', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await gotoAuthenticated(page, '/viewpoints/environmentalAdaptability');
    await page.getByLabel('対象の設備').selectOption({ label: '　環境センサー1' });

    await page
      .getByRole('navigation', { name: 'パンくず' })
      .getByRole('link', { name: 'ダッシュボード' })
      .click();

    await expect(page.getByLabel('対象のハウス')).toHaveValue(HOUSE_ID);
    await expect(page.locator('.viewpoint-card')).toHaveCount(10);
  });
});

test.describe('ステータスの同値分割（正常・注意・異常・不明）', () => {
  const cases = [
    {
      name: '正常',
      status: 'NORMAL',
      temperature: 20,
      expected: '正常',
      iconName: 'status-normal',
      border: 'normal',
    },
    {
      name: '注意',
      status: 'CAUTION',
      temperature: 27,
      expected: '注意',
      iconName: 'status-caution',
      border: 'caution',
    },
    {
      name: '異常',
      status: 'ERROR',
      temperature: 40,
      expected: '異常',
      iconName: 'status-error',
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
      await expect(badge.locator(`[data-icon="${item.iconName}"]`)).toBeVisible();
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
    await expect(accuracy.locator('.status-badge [data-icon="status-unknown"]')).toBeVisible();
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

test.describe('期間の選択（視点〔短期・長期〕の切り替えはない。Issue #355）', () => {
  test('ダッシュボードは、長期の評価（期間の平均）を示す。視点の切り替えはなく、古い URL の視点（?horizon=SHORT）は、使わない', async ({
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
    await expect(page.getByRole('radio', { name: '短期' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: '長期' })).toHaveCount(0);

    // 古い URL の視点は、使わない（長期の結果を示す。短期評価を持たない旨の注記も出ない）
    await openDashboard(page, '?horizon=SHORT');
    await expect(environment.locator('dd', { hasText: '25.0℃' })).toBeVisible();
    await expect(page.getByText('この観点は短期評価を持たないため')).toHaveCount(0);
    await shot(page, testInfo, 'dashboard-long-only');
  });

  test('期間を選ぶと、URL に反映され、再読み込みで保持される（視点は、URL に付かない）', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await openDashboard(page);

    await page.getByLabel('期間').selectOption({ label: '直近30日' });

    await expect(page).toHaveURL(/\/\?periodDays=30$/);
    await page.reload();
    await expect(page.getByLabel('期間')).toHaveValue('30');
  });

  test('短期（直近 24 時間）の評価が、この期間の評価より悪いときは、カードのステータスが短期で決まっている旨を示す。長期と同じ・短期評価のない観点には、示さない', async ({
    page,
    request,
  }) => {
    await prepare(request);
    // 2日前: 温度 20℃（正常）、直近: 温度 40℃（異常）→ 短期は異常、長期（7日）の平均 30℃ は注意
    await seed(
      request,
      merge(environmentData({ temperature: 20 }, 48), environmentData({ temperature: 40 }, 1)),
    );

    await openDashboard(page);

    await expect(card(page, 'environmentalAdaptability').locator('.status-badge')).toContainText(
      '異常',
    );
    await expect(page.getByTestId('short-worse-environmentalAdaptability')).toHaveText(
      '直近 24 時間の評価は「異常」です（この期間の評価は「注意」）。ステータスは、悪い方を示しています',
    );
    // 観点別の状態の表も、同じ（最終ステータス）
    await expect(
      page.getByTestId('status-row-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('異常');
    // 短期評価を持たない観点には、示さない
    await expect(page.getByTestId('short-worse-durability')).toHaveCount(0);
  });

  test.describe('期間（当日・直近7日・30日・60日・90日）で、評価の対象期間とステータスが変わる', () => {
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

        await page.getByLabel('期間').selectOption({ label: period.label });

        const environment = card(page, 'environmentalAdaptability');
        await expect(page).toHaveURL(new RegExp(`periodDays=${String(period.days)}$`));
        // 期間を選ぶと、全観点で判定の対象期間が同じになるため、上部に 1 回だけ示す（カードには示さない）
        await expect(page.getByTestId('evaluated-period-common')).toContainText(
          `判定の対象期間: ${period.from} 〜 2026/10/09 12:00:00`,
        );
        await expect(environment.locator('.evaluated-period')).toHaveCount(0);
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
    // 自動取り込みの運用（ファイルのパスを持つ設備がある。ADR-0023）にする
    await assignPlaceholderPaths(request);

    await openDashboard(page);

    const notice = page.getByText(
      'データがまだ取り込まれていません。データ入力または取り込み設定を確認してください',
    );
    await expect(notice).toBeVisible();
    await expect(page.getByText('最終のデータ取得:')).toBeVisible();
    await expect(page.getByTestId('data-status')).toContainText('未取得');
    await expect(card(page, 'harvestAccuracy').locator('.diagnostic')).toContainText(
      // 設備にファイルのパスを設定した時点で、評価が 1 回行われる（データがないため、不明）
      'データ不足のため評価できません。未取得の項目: 収穫数、果実損傷数、誤収穫数、取り残し数',
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
    // 設備がなければ、対象のハウスの選択でなく、設備の登録の案内を示す
    await expect(page.getByLabel('対象のハウス')).toHaveCount(0);
    await shot(page, testInfo, 'dashboard-no-equipment');
    await page.locator('main').getByRole('link', { name: '設備' }).click();
    await expect(page).toHaveURL(/\/settings\/equipment$/);
    await shot(page, testInfo, 'dashboard-no-equipment-link');
  });

  // 「古い」の基準: 最終のデータ取得（受信）から、取得間隔（設備ごとの設定。ここでは 15分）× 3 = 45分を超えたら古い（境界値 45分・46分）
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
      // 自動取り込みの運用（ファイルのパスを持つ設備がある。ADR-0023）にする
      await assignPlaceholderPaths(request);
      // 取得間隔は、設備ごとの設定（#197。既定は、ロボット 1 分・センサー 5 分）。この検証は、15 分にする
      await setEquipmentInterval(request, ROBOT, 15);
      await setEquipmentInterval(request, SENSOR, 15);
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
        await expect(page.getByTestId('data-status')).toContainText('（古い）');
      } else {
        await expect(warning).toHaveCount(0);
        await expect(page.getByTestId('data-status')).not.toContainText('古い');
      }
      await expect(page.getByTestId('data-status')).toContainText('最終のデータ取得');
      if (item.minutes === 46 || item.minutes === 0) {
        await shot(page, testInfo, `dashboard-freshness-${String(item.minutes)}min`);
      }
    });
  }
});

test.describe('設備ごとの「古い」の基準（取得間隔 × 3、最低 3 分。#198）', () => {
  test('ハウスは、配下のいずれかの設備が古ければ警告し、古い設備の名前を示す。基準は、設備の取得間隔で変わる（取得間隔を変えて「更新」すると、警告が消える）', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    // 自動取り込みの運用（ファイルのパスを持つ設備がある。ADR-0023）にする
    await assignPlaceholderPaths(request);
    // 既定の取得間隔（ロボット 1 分 → 3 分・センサー 5 分 → 15 分）。どちらも、10 分前に受け取った
    const tenMinutesAgo = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    await seed(request, {
      observations: [
        { equipmentId: ROBOT, itemKey: 'harvestCount', value: 1, observedAt: tenMinutesAgo },
        {
          equipmentId: SENSOR,
          itemKey: 'temperatureCelsius',
          value: 20,
          observedAt: tenMinutesAgo,
        },
      ],
    });

    await openDashboard(page);

    const warning = page.getByRole('alert').filter({ hasText: 'データが古くなっています' });
    await expect(warning).toBeVisible();
    await expect(page.getByTestId('stale-equipment')).toContainText('収穫ロボット1');
    await expect(page.getByTestId('stale-equipment')).not.toContainText('環境センサー1');
    await shot(page, testInfo, 'dashboard-stale-equipment');

    // ロボットの取得間隔を 5 分にすると、基準は 15 分になり、10 分前のデータは、古くない（「更新」で、すぐ読み直す）
    await setEquipmentInterval(request, ROBOT, 5);
    await page.getByRole('button', { name: '更新' }).click();
    await expect(warning).toHaveCount(0);
    await expect(page.getByTestId('data-status')).toContainText('最終のデータ取得');
    await expect(page.getByTestId('data-status')).not.toContainText('古い');
  });
});

test.describe('手動のみの運用（自動取り込みが有効でない間。Issue #202）', () => {
  test('取り込み設定で、ロボット・センサーの自動取り込みを無効にすると、「古い」「未取得」の警告を出さず、ヘッダーに「最終の手動入力」を示す。自動取り込みを有効に戻すと、従来どおり', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    // 自動取り込みの運用（ファイルのパスを持つ設備がある。ADR-0023）にする
    await assignPlaceholderPaths(request);
    // 手動入力のデータ（30 分前に入力）と、古い自動取り込みのデータ
    const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
    await seed(request, {
      observations: [
        { equipmentId: SENSOR, itemKey: 'temperatureCelsius', value: 20, observedAt: at(600) },
        {
          equipmentId: SENSOR,
          itemKey: 'temperatureCelsius',
          value: 21,
          observedAt: at(30),
          source: 'MANUAL',
        },
      ],
    });
    const setEnabled = (isEnabled: boolean) =>
      apiOk(request, 'PUT', '/ingestion/settings', {
        sources: ['robot', 'environment-sensor'].map((sourceId) => ({
          sourceId,
          isEnabled,
        })),
      });

    // 自動取り込みが有効（既定）: 自動取り込みのデータが古いため、警告する
    await openDashboard(page);
    await expect(
      page.getByRole('alert').filter({ hasText: 'データが古くなっています' }),
    ).toBeVisible();

    // 手動のみの運用（自動取り込みを無効）: 警告せず、最終の手動入力を示す
    await setEnabled(false);
    await openDashboard(page);
    await expect(page.getByTestId('freshness-manual')).toContainText('自動取り込みが有効でない');
    await expect(
      page.getByRole('alert').filter({ hasText: 'データが古くなっています' }),
    ).toHaveCount(0);
    await expect(page.getByText('データがまだ取り込まれていません')).toHaveCount(0);
    await expect(page.getByTestId('data-status')).toContainText('最終の手動入力');
    await expect(page.getByTestId('data-status')).toContainText('2026/10/09 11:30');
    await expect(page.getByTestId('data-status')).not.toContainText('古い');
    await expect(page.getByTestId('data-status')).not.toContainText('未取得');
    await shot(page, testInfo, 'dashboard-manual-only');

    // 自動取り込みを有効に戻すと、従来どおり
    await setEnabled(true);
    await openDashboard(page);
    await expect(page.getByTestId('freshness-manual')).toHaveCount(0);
    await expect(
      page.getByRole('alert').filter({ hasText: 'データが古くなっています' }),
    ).toBeVisible();
    await expect(page.getByTestId('data-status')).toContainText('最終のデータ取得');
  });
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
});

test.describe('手動の更新（Issue #355）', () => {
  test('「更新」を押すと、約 10 秒の自動更新を待たずに、最新の評価結果を読み直す', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, environmentData({ temperature: 20 }, 3));
    await openDashboard(page);
    const badge = card(page, 'environmentalAdaptability').locator('.status-badge');
    await expect(badge).toContainText('正常');

    // 評価結果だけを更新する（画面は、次の自動更新まで、読み直さない）
    await seed(request, environmentData({ temperature: 40 }, 1));
    await runEvaluation(request);
    await page.getByRole('button', { name: '更新' }).click();

    await expect(badge).toContainText('異常');
    await expect(page.getByRole('button', { name: '更新' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });
});

test.describe('観点別の状態の表（Issue #356）', () => {
  test('正常・注意・異常・不明の件数の下に、10 観点の状態を、観点名と状態の表で示す（カードのステータスと同じ）。見出しは、3 つとも違う', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await openDashboard(page);

    await expect(page.locator('main h2')).toHaveText([
      '状態ごとの観点の数',
      '観点別の状態',
      '観点ごとの診断と推奨アクション',
    ]);
    const rows = page.getByTestId('viewpoint-status-table').locator('tbody tr');
    await expect(rows).toHaveCount(10);
    await expect(rows.locator('th')).toHaveText(VIEWPOINT_ORDER.map(([, name]) => name));
    for (const [viewpointId] of VIEWPOINT_ORDER) {
      await expect(
        page.getByTestId(`status-row-${viewpointId}`).locator('.status-badge'),
      ).toContainText(MIXED_EXPECTED[viewpointId]);
      await expect(card(page, viewpointId).locator('.status-badge')).toContainText(
        MIXED_EXPECTED[viewpointId],
      );
    }
    // 件数のタイルの下、カードの上に並ぶ
    const tiles = await page.getByTestId('summary-NORMAL').boundingBox();
    const table = await page.getByTestId('viewpoint-status-table').boundingBox();
    const firstCard = await page.locator('.viewpoint-card').first().boundingBox();
    expect(table?.y ?? 0).toBeGreaterThan((tiles?.y ?? 0) + (tiles?.height ?? 0) - 1);
    expect(firstCard?.y ?? 0).toBeGreaterThan((table?.y ?? 0) + (table?.height ?? 0) - 1);
    await shot(page, testInfo, 'dashboard-status-table');
  });

  test('スマートフォン幅（375px）でも、表は、ページの幅に収まり、横スクロールが出ない', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, mixedScenario());
    await page.setViewportSize({ width: 375, height: 800 });
    await openDashboard(page);

    const table = await page.getByTestId('viewpoint-status-table').boundingBox();
    expect(table?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((table?.x ?? 0) + (table?.width ?? 0)).toBeLessThanOrEqual(375);
    await expectNoHorizontalScroll(page);
    await shot(page, testInfo, 'dashboard-status-table-375');
  });
});

for (const viewport of [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 720 },
  { name: 'タブレット幅（768px）', width: 768, height: 1024 },
  { name: 'スマートフォン幅（375px）', width: 375, height: 800 },
]) {
  test(`長い設備名（200 文字）のハウスでも、「対象のハウス」・期間・更新が、ページの幅に収まり、ラベルが潰れない（${viewport.name}）`, async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await apiOk(request, 'POST', '/equipment', {
      equipmentId: 'HOUSE-LONG',
      equipmentType: 'FACILITY',
      name: 'ハウス'.repeat(67).slice(0, 200),
    });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openDashboard(page);

    await page.getByLabel('対象のハウス').selectOption('HOUSE-LONG');

    await expect(page.getByLabel('対象のハウス')).toHaveValue('HOUSE-LONG');
    await expectEquipmentFieldIntact(page);
    await expectNoHorizontalScroll(page);
    const controls = await page
      .locator('.page-controls > *')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
    for (const rect of controls) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(viewport.width);
    }
    await shot(page, testInfo, `dashboard-long-name-${String(viewport.width)}`);
  });
}
