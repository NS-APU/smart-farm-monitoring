/**
 * UC-04 推奨アクションを確認する（SC-02、SC-03。FR-5.5、FR-6.2）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、診断結果を確認する（UC-02）
 *               2. システムが、診断結果に応じた推奨アクションを表示する
 *               3. 農作業者が、推奨アクションを参考に、対応を判断する
 *   補足        システムはロボット・ハウスを自動で操作しない。実際の対応は農作業者が行う
 *
 * 値の同値分割: ステータス（正常・注意・異常・不明）、観点（10観点。観点ごとの注意・異常時の文言）、画面（ダッシュボード・観点の詳細）、
 * 視点（短期・長期）、評価前（評価結果がまだない）。
 * 関連するユースケース: UC-02（診断結果の確認から続く）、UC-05（通知から確認する流れは UC-05 のシナリオテスト）。
 */

import { expect, test } from '@playwright/test';
import { gotoAuthenticated } from './support/helpers.ts';
import { dashboardCard as card, openDashboard } from './support/pages.ts';
import {
  costEfficiencyData,
  dataUtilizationData,
  durabilityData,
  environmentData,
  harvestAccuracyData,
  harvestSpeedData,
  maintainabilityData,
  merge,
  operabilityData,
  prepare,
  safetyData,
  satisfactionData,
  seed,
  shot,
  type SeedBody,
} from './support/viewpoint-scenarios.ts';

const ENVIRONMENT_ACTION =
  'ハウスの環境を現場で確認し、調整してください（本システムは環境を自動では制御しません）';
const NORMAL_ACTION = '現在の状態を維持し、引き続き推移を確認してください';
const UNKNOWN_ACTION = 'データの取得・入力を確認してください（取り込みの状況、手動入力）';
const CAUTION_PREFIX = '確認が望ましい状態です。';
const ERROR_PREFIX = '対応が必要な状態です。';

test.describe('基本フロー: 診断結果を確認し、推奨アクションを表示する', () => {
  test('ダッシュボードのカードに推奨アクションを表示し、観点の詳細でも同じ内容を確認できる', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, environmentData({ temperature: 40 }));

    await openDashboard(page);
    const action = card(page, 'environmentalAdaptability').locator('.action');
    await expect(action).toContainText(`推奨アクション: ${ERROR_PREFIX}${ENVIRONMENT_ACTION}`);
    const onDashboard = (await action.textContent()) ?? '';
    await shot(page, testInfo, 'uc04-dashboard-action');

    // 診断結果を確認する（UC-02）→ 推奨アクションを確認する
    await card(page, 'environmentalAdaptability').locator('h3').getByRole('link').click();
    const detailAction = page.getByTestId('recommended-action');
    await expect(detailAction).toBeVisible();
    expect(onDashboard).toContain((await detailAction.locator('span').textContent()) ?? '');
    await expect(detailAction.locator('strong')).toHaveText('推奨アクション');
    await shot(page, testInfo, 'uc04-detail-action');
  });

  test('推奨アクションは参考情報で、ロボット・ハウスを操作する部品（ボタン・入力欄）を、推奨アクションの欄に持たない', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, environmentData({ temperature: 40 }));
    await gotoAuthenticated(page, '/viewpoints/environmentalAdaptability');

    const action = page.getByTestId('recommended-action');
    await expect(action).toBeVisible();
    await expect(action.getByRole('button')).toHaveCount(0);
    await expect(action.locator('input, select, textarea')).toHaveCount(0);
  });

  test('システムはロボット・ハウスを自動で操作しない: ダッシュボードと詳細を見て推奨アクションを確認する間、状態を変更する API を呼ばない', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, environmentData({ temperature: 40 }));
    const changing: string[] = [];
    page.on('request', (item) => {
      const url = new URL(item.url());
      // ログイン・トークンの更新（認証）は対象外。それ以外の /api/v1 の呼び出しは、参照（GET）だけであること
      if (url.pathname.startsWith('/api/v1/') && !url.pathname.startsWith('/api/v1/auth/')) {
        if (item.method() !== 'GET') {
          changing.push(`${item.method()} ${url.pathname}`);
        }
      }
    });

    await openDashboard(page);
    await expect(card(page, 'environmentalAdaptability').locator('.action')).toContainText(
      ERROR_PREFIX,
    );
    await card(page, 'environmentalAdaptability').locator('h3').getByRole('link').click();
    await expect(page.getByTestId('recommended-action')).toContainText(ERROR_PREFIX);
    // 推奨アクションを確認している間に、定期の読み直し（約10秒）が走っても、参照だけである
    await page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/viewpoints/environmentalAdaptability' &&
        response.request().method() === 'GET',
      { timeout: 20_000 },
    );

    expect(changing, '参照（GET）以外の API 呼び出し').toEqual([]);
  });
});

test.describe('ステータスの同値分割: 推奨アクションは診断結果（ステータス）に応じる', () => {
  const partitions = [
    { name: '正常（温度 20℃）', temperature: 20, status: '正常', expected: NORMAL_ACTION },
    { name: '注意（温度 27℃）', temperature: 27, status: '注意', expected: CAUTION_PREFIX },
    { name: '異常（温度 40℃）', temperature: 40, status: '異常', expected: ERROR_PREFIX },
  ] as const;

  for (const item of partitions) {
    test(`${item.name}: ダッシュボードと観点の詳細の両方に、${item.status}に応じた推奨アクションを表示する`, async ({
      page,
      request,
    }) => {
      await prepare(request);
      await seed(request, environmentData({ temperature: item.temperature }));

      await openDashboard(page);
      await expect(card(page, 'environmentalAdaptability').locator('.status-badge')).toContainText(
        item.status,
      );
      await expect(card(page, 'environmentalAdaptability').locator('.action')).toContainText(
        item.expected,
      );
      await page.goto('/viewpoints/environmentalAdaptability');
      await expect(page.getByTestId('recommended-action')).toContainText(item.expected);
    });
  }

  test('不明（データなし）: データの取得・入力を確認する推奨アクションと、データ入力・取り込みの状況への導線を表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    await seed(request, {});

    await openDashboard(page);
    await expect(card(page, 'operability').locator('.action')).toContainText(UNKNOWN_ACTION);
    await page.goto('/viewpoints/operability');
    await expect(page.getByTestId('recommended-action')).toContainText(UNKNOWN_ACTION);
    const guide = page.getByTestId('unknown-guide');
    await expect(guide.getByRole('link', { name: 'データ入力へ' })).toHaveAttribute(
      'href',
      '/data-entry',
    );
    await expect(guide.getByRole('link', { name: '取り込み設定・状況へ' })).toHaveAttribute(
      'href',
      '/settings/ingestion',
    );
    await shot(page, testInfo, 'uc04-unknown-action');
  });

  test('注意と異常で、推奨アクションの強さ（確認が望ましい／対応が必要）が異なる', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await seed(request, merge(safetyData('CAUTION'), operabilityData('ERROR')));

    await openDashboard(page);

    await expect(card(page, 'safety').locator('.action')).toContainText(CAUTION_PREFIX);
    await expect(card(page, 'safety').locator('.action')).not.toContainText(ERROR_PREFIX);
    await expect(card(page, 'operability').locator('.action')).toContainText(ERROR_PREFIX);
  });
});

test.describe('視点（短期・長期）に応じた推奨アクション', () => {
  test('短期が異常・長期が注意のとき、視点を切り替えると、ダッシュボードと観点の詳細の推奨アクションも、その視点の診断結果に切り替わる', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);
    // 48時間前は正常（20℃）、1時間前は異常（40℃）: 短期（直近24時間）は異常、長期（直近7日）は平均 30℃ で注意
    await seed(
      request,
      merge(environmentData({ temperature: 20 }, 48), environmentData({ temperature: 40 }, 1)),
    );

    await openDashboard(page);
    // 既定は長期
    await expect(card(page, 'environmentalAdaptability').locator('.action')).toContainText(
      `${CAUTION_PREFIX}${ENVIRONMENT_ACTION}`,
    );
    await page.getByRole('radio', { name: '短期' }).check();
    await expect(card(page, 'environmentalAdaptability').locator('.action')).toContainText(
      `${ERROR_PREFIX}${ENVIRONMENT_ACTION}`,
    );
    await shot(page, testInfo, 'uc04-dashboard-short');

    // 短期を選んだまま詳細へ進む
    await card(page, 'environmentalAdaptability').locator('h3').getByRole('link').click();
    await expect(page.getByTestId('recommended-action')).toContainText(
      `${ERROR_PREFIX}${ENVIRONMENT_ACTION}`,
    );
    await page.getByRole('radio', { name: '長期' }).check();
    await expect(page.getByTestId('recommended-action')).toContainText(
      `${CAUTION_PREFIX}${ENVIRONMENT_ACTION}`,
    );
  });
});

test.describe('評価が行われていない（評価前）の観点', () => {
  test('評価前は「不明」として、データの取得・入力を確認する推奨アクションを、ダッシュボードと観点の詳細に表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepare(request);

    await openDashboard(page);
    await expect(card(page, 'operability').locator('.status-badge')).toContainText('不明');
    await expect(card(page, 'operability').locator('.action')).toContainText(UNKNOWN_ACTION);

    await card(page, 'operability').locator('h3').getByRole('link').click();
    await expect(page.getByTestId('diagnosis')).toContainText('まだ評価されていません');
    await expect(page.getByTestId('recommended-action')).toContainText(UNKNOWN_ACTION);
    const guide = page.getByTestId('unknown-guide');
    await expect(guide.getByRole('link', { name: 'データ入力へ' })).toHaveAttribute(
      'href',
      '/data-entry',
    );
    await expect(guide.getByRole('link', { name: '取り込み設定・状況へ' })).toHaveAttribute(
      'href',
      '/settings/ingestion',
    );
    await shot(page, testInfo, 'uc04-not-evaluated-action');
  });
});

test.describe('観点ごとの推奨アクション（異常のとき。観点の文言を、ダッシュボードのカードと、観点の詳細（満足度の詳細は、推奨アクションを表示しないため除く）で確認する）', () => {
  const viewpoints: readonly { id: string; name: string; data: SeedBody; action: string }[] = [
    {
      id: 'harvestAccuracy',
      name: '収穫精度',
      data: harvestAccuracyData('ERROR'),
      action: '傷つけや取り残しの原因を現場で確認し、収穫の条件を調整してください',
    },
    {
      id: 'harvestSpeed',
      name: '収穫速度',
      data: harvestSpeedData('ERROR'),
      action: '走行・収穫が滞っている原因を確認し、復旧・調整してください',
    },
    {
      id: 'operability',
      name: '操作性',
      data: operabilityData('ERROR'),
      action: '操作の手順や設定を見直し、ミスしやすい操作がないか確認してください',
    },
    {
      id: 'maintainability',
      name: 'メンテナンス性',
      data: maintainabilityData('ERROR'),
      action: '復旧し、故障回数と復旧に要した時間を記録してください',
    },
    {
      id: 'costEfficiency',
      name: 'コスト効率',
      data: costEfficiencyData(),
      action: '稼働状況と費用を見直してください',
    },
    {
      id: 'safety',
      name: '安全性',
      data: safetyData('ERROR'),
      action: '現場で安全を確認し、緊急停止・ヒヤリハットの原因を確認してください',
    },
    {
      id: 'dataUtilization',
      name: 'データ活用度合い',
      data: dataUtilizationData('ERROR'),
      action: '取り込みの失敗や入力の漏れを確認し、データを補ってください',
    },
    {
      id: 'durability',
      name: '耐久性',
      data: durabilityData('ERROR'),
      action: '故障の傾向を確認し、保守を判断してください',
    },
    {
      id: 'satisfaction',
      name: '満足度',
      data: satisfactionData([1, 1, 1, 1, 1, 1, 1, 1, 1]),
      action: '満足度の低い観点について、農作業者から所感を聞き取り、改善につなげてください',
    },
  ];

  for (const viewpoint of viewpoints) {
    test(`${viewpoint.name}が異常: 「${ERROR_PREFIX}${viewpoint.action}」を表示する`, async ({
      page,
      request,
    }) => {
      await prepare(request);
      await seed(request, viewpoint.data);

      await openDashboard(page);

      await expect(card(page, viewpoint.id).locator('.status-badge')).toContainText('異常');
      await expect(card(page, viewpoint.id).locator('.action')).toContainText(
        `${ERROR_PREFIX}${viewpoint.action}`,
      );

      // カードから観点の詳細へ進み、同じ推奨アクションを確認する（満足度は専用の詳細（SC-04）へ進む）
      await card(page, viewpoint.id).locator('h3').getByRole('link').click();
      if (viewpoint.id === 'satisfaction') {
        await expect(page).toHaveURL(/\/satisfaction/);
      } else {
        await expect(page.getByTestId('recommended-action')).toContainText(
          `${ERROR_PREFIX}${viewpoint.action}`,
        );
      }
    });
  }

  test('環境適応性が異常: 観点固有の文言を表示する', async ({ page, request }) => {
    await prepare(request);
    await seed(request, environmentData({ humidity: 95 }));

    await openDashboard(page);

    await expect(card(page, 'environmentalAdaptability').locator('.status-badge')).toContainText(
      '異常',
    );
    await expect(card(page, 'environmentalAdaptability').locator('.action')).toContainText(
      `${ERROR_PREFIX}${ENVIRONMENT_ACTION}`,
    );

    // カードから観点の詳細へ進み、同じ推奨アクションを確認する
    await card(page, 'environmentalAdaptability').locator('h3').getByRole('link').click();
    await expect(page.getByTestId('recommended-action')).toContainText(
      `${ERROR_PREFIX}${ENVIRONMENT_ACTION}`,
    );
  });
});
