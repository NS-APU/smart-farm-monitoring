/**
 * UC-19 判断基準を編集する（SC-13。観点の詳細〔SC-03〕・満足度の詳細〔SC-04〕の「判断基準を編集」から。FR-5.7、FR-5.8、NFR-7.4、NFR-8.2）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、観点・満足度の詳細の「判断基準を編集」から、判断基準の編集画面を開き、現在の閾値（上限型・下限型・範囲型）を確認する（実装は、一覧の画面を持たない）
 *               2. 農作業者が、閾値を編集して保存する
 *               3. システムが、入力内容を検証して保存する。変更はシステム全体に適用し、変更済みであることを識別できるようにする
 *               4. 農作業者が、必要に応じて、既定値へ戻す
 *   代替フロー  大小関係が成り立たない、数値でない、条件名が空欄または長すぎるなどの不正な組み合わせは、保存できない（エラーを表示する）
 *   事後条件    変更した判断基準が、以降の評価に使われる。変更した基準による判定には、診断メッセージでその旨が示される（UC-02）
 *   補足        変更が過去の評価に影響するかは未確定（暫定: 過去の評価は保持し、現在の評価のみ再評価する）
 *
 * 値の同値分割: 閾値の型（上限型・下限型・範囲型）、大小関係（成立・等しい・逆転）、数値（数値・空・数値でない・負・小数）、
 * 条件名の長さの境界（1・200・201・空）、操作（保存・既定値へ戻す・確認の取り消し）、利用者（変更する人・見る人。別のブラウザ）、権限。
 * 関連するユースケース: UC-02（診断メッセージ・判断基準の表示）、UC-01（ダッシュボードの評価）、UC-10（再評価の通知）、
 * UC-17（ステータスコードの指標は編集できない）、UC-18（変更履歴）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  USER_B,
  VIEWER,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  api,
  confirmDialog,
  newUserSession,
  openAs,
  prepareApp,
} from './support/app.ts';
import {
  durabilityData,
  environmentData,
  harvestAccuracyData,
  harvestSpeedData,
  merge,
  satisfactionData,
  seed,
  shot,
} from './support/viewpoint-scenarios.ts';
import { listNotifications } from './support/notifications.ts';
import { locatorOf, userIdText } from './support/pages.ts';

const card = (page: Page, indicator: string) => page.getByTestId(`criterion-edit-${indicator}`);
const notice = locatorOf('criteria-notice');
const state = (page: Page) => page.getByTestId('criteria-state');
const save = (page: Page) => page.getByRole('button', { name: '保存する' });
const fieldError = (page: Page, indicator: string, name: string) =>
  card(page, indicator).locator(`[data-field="${name}"] .field-error`);

async function openCriteria(
  page: Page,
  viewpointId: string,
  user?: Parameters<typeof openAs>[2],
): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, `/viewpoints/${viewpointId}`, user);
  // 観点の詳細（SC-03）の判断基準の欄から、編集（SC-13）へ移る
  await page.getByRole('link', { name: '判断基準を編集' }).click();
  await expect(page.getByRole('heading', { name: /判断基準の編集/, level: 1 })).toBeVisible();
}

test.describe('基本フロー: 現在の閾値（上限型・下限型・範囲型）を確認し、編集して保存し、既定値へ戻す', () => {
  test('観点の詳細の判断基準の欄から、判断基準の編集を開くと、指標ごとの型・条件名・閾値の現在値を表示する（範囲型・下限型・上限型）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, {});

    await openCriteria(page, 'environmentalAdaptability');

    await expect(state(page)).toContainText('既定値');
    // 範囲型（温度）: 異常下限 0 < 正常下限 10 < 正常上限 25 < 異常上限 35
    const temperature = card(page, 'temperatureCelsius');
    await expect(temperature).toContainText('範囲型');
    await expect(temperature.getByLabel('条件名')).toHaveValue('温度');
    await expect(temperature.getByLabel('異常下限（未満で異常）')).toHaveValue('0');
    await expect(temperature.getByLabel('正常下限（以上で正常）')).toHaveValue('10');
    await expect(temperature.getByLabel('正常上限（未満で正常）')).toHaveValue('25');
    await expect(temperature.getByLabel('異常上限（以上で異常）')).toHaveValue('35');
    await shot(page, testInfo, 'uc19-range');
    // 下限型（収穫精度の可販果率）・上限型（収穫速度の走行停止率）
    await page.goto('/viewpoints/harvestAccuracy/criteria');
    const rate = card(page, 'marketableFruitRatePercent');
    await expect(rate).toContainText('下限型');
    await expect(rate.getByLabel('条件名')).toHaveValue('可販果率');
    await expect(rate.getByLabel('注意下限（未満で注意）')).toHaveValue('90');
    await expect(rate.getByLabel('異常下限（未満で異常）')).toHaveValue('80');
    await page.goto('/viewpoints/harvestSpeed/criteria');
    const stopped = card(page, 'travelStoppedRatePercent');
    await expect(stopped).toContainText('上限型');
    await expect(stopped.getByLabel('条件名')).toHaveValue('走行停止率');
    await expect(stopped.getByLabel('注意開始値（以上で注意）')).toHaveValue('5');
    await expect(stopped.getByLabel('異常開始値（以上で異常）')).toHaveValue('10');
  });

  test('閾値を編集して保存すると、変更済み（版・変更者・日時つき）になり、現在の評価が更新され、診断メッセージで、変更した基準による判定である旨を示す', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    // 温度 27℃: 既定値（正常は 10℃以上 25℃未満）では「注意」
    await seed(request, environmentData({ temperature: 27 }));
    await alignBrowserClock(page);
    await openAs(page, '/viewpoints/environmentalAdaptability');
    await expect(
      page.getByTestId('diagnosis').locator('.diagnosis-head .status-badge'),
    ).toContainText('注意');
    await page.getByRole('link', { name: '判断基準を編集' }).click();

    // 1. 現在の閾値を確認し、2. 正常上限を 30℃に変更する、条件名も変更する
    const temperature = card(page, 'temperatureCelsius');
    await temperature.getByLabel('条件名').fill('温度（イチゴの適温）');
    await temperature.getByLabel('正常上限（未満で正常）').fill('30');
    await save(page).click();

    // 3. 保存し、変更済みであることを識別できる
    await expect(notice(page)).toHaveText('保存しました。現在の評価を更新しました');
    await expect(state(page)).toContainText('変更済み');
    await expect(state(page)).toContainText('版: CUSTOM-1');
    await expect(state(page)).toContainText('変更者: e2e-user');
    await expect(state(page)).toContainText('2026/10/09');
    await shot(page, testInfo, 'uc19-saved');
    // 観点の詳細: 変更済みの判断基準・評価の更新・診断メッセージ
    await page.getByRole('link', { name: '観点の詳細へ戻る' }).click();
    await expect(
      page.getByTestId('diagnosis').locator('.diagnosis-head .status-badge'),
    ).toContainText('正常');
    await expect(page.getByTestId('diagnostic-message')).toContainText(
      'カスタムの判断基準による判定です',
    );
    await expect(page.getByTestId('criteria-state')).toContainText('変更済み（版: CUSTOM-1）');
    await expect(page.getByTestId('criterion-temperatureCelsius')).toContainText(
      '温度（イチゴの適温）',
    );
    await expect(page.getByTestId('criterion-temperatureCelsius')).toContainText('10℃以上30℃未満');
    // ダッシュボードにも反映される（カスタムの判断基準の表示）
    await page.goto('/');
    await expect(
      page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('正常');
    await expect(page.getByTestId('card-environmentalAdaptability')).toContainText(
      'カスタムの判断基準',
    );
  });

  test('「既定値へ戻す」は、確認を求め、戻すと、既定値の閾値・評価に戻る。変更していない（既定値の）ときは、選べない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, environmentData({ temperature: 27 }));
    await openCriteria(page, 'environmentalAdaptability');
    await expect(page.getByRole('button', { name: '既定値へ戻す' })).toBeDisabled();
    await card(page, 'temperatureCelsius').getByLabel('正常上限（未満で正常）').fill('30');
    await save(page).click();
    await expect(state(page)).toContainText('変更済み');

    await page.getByRole('button', { name: '既定値へ戻す' }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('既定値へ戻しますか');
    await shot(page, testInfo, 'uc19-reset-confirm');
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'キャンセル' }).click();
    await expect(state(page)).toContainText('変更済み');
    await page.getByRole('button', { name: '既定値へ戻す' }).click();
    await confirmDialog(page, '既定値へ戻す');

    await expect(notice(page)).toHaveText('既定値へ戻しました');
    await expect(state(page)).toContainText('既定値');
    await expect(card(page, 'temperatureCelsius').getByLabel('正常上限（未満で正常）')).toHaveValue(
      '25',
    );
    await page.goto('/');
    await expect(
      page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('注意');
    await expect(page.getByTestId('card-environmentalAdaptability')).not.toContainText(
      'カスタムの判断基準',
    );
  });

  test('変更を繰り返すと、版が進む（CUSTOM-1 → CUSTOM-2）。再読み込みしても、変更後の閾値が保持される', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {});
    await openCriteria(page, 'harvestAccuracy');
    const rate = card(page, 'marketableFruitRatePercent');

    await rate.getByLabel('注意下限（未満で注意）').fill('92');
    await save(page).click();
    await expect(state(page)).toContainText('版: CUSTOM-1');
    await rate.getByLabel('注意下限（未満で注意）').fill('93');
    await save(page).click();

    await expect(state(page)).toContainText('版: CUSTOM-2');
    await page.reload();
    await expect(
      card(page, 'marketableFruitRatePercent').getByLabel('注意下限（未満で注意）'),
    ).toHaveValue('93');
  });
});

test.describe('閾値の型ごとの、変更後の判定（境界は「以上」「未満」）', () => {
  test('上限型（収穫速度の平均処理時間）: 注意開始値を 40秒に下げると、36秒/果実のデータ（既定では正常）が、変更後は正常のまま。注意開始値を 36秒にすると注意になる（境界: 以上）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, harvestSpeedData('NORMAL'));
    await openCriteria(page, 'harvestSpeed');
    const seconds = card(page, 'averageSecondsPerFruit');

    await seconds.getByLabel('注意開始値（以上で注意）').fill('40');
    await save(page).click();
    await expect(notice(page)).toBeVisible();
    await page.goto('/');
    await expect(page.getByTestId('card-harvestSpeed').locator('.status-badge')).toContainText(
      '正常',
    );

    await page.goto('/viewpoints/harvestSpeed/criteria');
    await seconds.getByLabel('注意開始値（以上で注意）').fill('36');
    await save(page).click();
    await expect(notice(page)).toBeVisible();
    await page.goto('/');
    await expect(page.getByTestId('card-harvestSpeed').locator('.status-badge')).toContainText(
      '注意',
    );
  });

  test('下限型（収穫精度の可販果率）: 注意下限を 99% に上げると、98.7% のデータ（既定では正常）が、注意になる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, harvestAccuracyData('NORMAL'));
    await openCriteria(page, 'harvestAccuracy');

    await card(page, 'marketableFruitRatePercent').getByLabel('注意下限（未満で注意）').fill('99');
    await card(page, 'recognitionAccuracyPercent').getByLabel('注意下限（未満で注意）').fill('99');
    await save(page).click();
    await expect(notice(page)).toBeVisible();

    await page.goto('/');
    await expect(page.getByTestId('card-harvestAccuracy').locator('.status-badge')).toContainText(
      '注意',
    );
  });

  test('範囲型（環境適応性の温度）: 正常下限を 20℃に上げると、15℃のデータ（既定では正常）が、注意になる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, environmentData({ temperature: 15 }));
    await openCriteria(page, 'environmentalAdaptability');

    await card(page, 'temperatureCelsius').getByLabel('正常下限（以上で正常）').fill('20');
    await save(page).click();
    await expect(notice(page)).toBeVisible();

    await page.goto('/');
    await expect(
      page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('注意');
  });

  test('満足度（下限型 4.0・3.0）も、編集できる（注意下限を 3.5 にすると、総合満足度 3.9（既定値では注意）は、正常になる）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, satisfactionData([4, 4, 4, 4, 4, 4, 4, 4, 3]));
    await alignBrowserClock(page);
    await openAs(page, '/viewpoints/satisfaction/criteria');
    const overall = card(page, 'overallSatisfaction');
    await expect(overall.getByLabel('注意下限（未満で注意）')).toHaveValue('4');
    await expect(overall.getByLabel('異常下限（未満で異常）')).toHaveValue('3');

    await overall.getByLabel('注意下限（未満で注意）').fill('3.5');
    await save(page).click();
    await expect(notice(page)).toBeVisible();

    await page.goto('/satisfaction');
    await expect(page.getByTestId('overall-score')).toHaveText('3.9');
    await expect(page.locator('.overall .status-badge')).toContainText('正常');
  });
});

test.describe('代替フロー: 不正な組み合わせは、保存できない（エラーを表示する）', () => {
  const invalid: readonly {
    name: string;
    viewpointId: string;
    indicator: string;
    values: Record<string, string>;
    message: string;
  }[] = [
    {
      name: '上限型: 注意開始値と異常開始値が等しい（5 = 5）',
      viewpointId: 'harvestSpeed',
      indicator: 'travelStoppedRatePercent',
      values: { '注意開始値（以上で注意）': '5', '異常開始値（以上で異常）': '5' },
      message: '注意開始値は異常開始値より小さくしてください',
    },
    {
      name: '上限型: 注意開始値が異常開始値より大きい（12 > 10）',
      viewpointId: 'harvestSpeed',
      indicator: 'travelStoppedRatePercent',
      values: { '注意開始値（以上で注意）': '12' },
      message: '注意開始値は異常開始値より小さくしてください',
    },
    {
      name: '下限型: 異常下限が注意下限と等しい（90 = 90）',
      viewpointId: 'harvestAccuracy',
      indicator: 'marketableFruitRatePercent',
      values: { '異常下限（未満で異常）': '90' },
      message: '異常下限は注意下限より小さくしてください',
    },
    {
      name: '下限型: 異常下限が注意下限より大きい（95 > 90）',
      viewpointId: 'harvestAccuracy',
      indicator: 'marketableFruitRatePercent',
      values: { '異常下限（未満で異常）': '95' },
      message: '異常下限は注意下限より小さくしてください',
    },
    {
      name: '範囲型: 正常下限が正常上限より大きい（30 > 25）',
      viewpointId: 'environmentalAdaptability',
      indicator: 'temperatureCelsius',
      values: { '正常下限（以上で正常）': '30' },
      message: '異常下限 < 正常下限 < 正常上限 < 異常上限 になるように指定してください',
    },
    {
      name: '範囲型: 異常上限が正常上限と等しい（25 = 25）',
      viewpointId: 'environmentalAdaptability',
      indicator: 'temperatureCelsius',
      values: { '異常上限（以上で異常）': '25' },
      message: '異常下限 < 正常下限 < 正常上限 < 異常上限 になるように指定してください',
    },
    {
      name: '範囲型: 異常下限が正常下限と等しい（10 = 10）',
      viewpointId: 'environmentalAdaptability',
      indicator: 'temperatureCelsius',
      values: { '異常下限（未満で異常）': '10' },
      message: '異常下限 < 正常下限 < 正常上限 < 異常上限 になるように指定してください',
    },
  ];

  for (const item of invalid) {
    test(`${item.name}: エラーを表示し、保存しない`, async ({ page, request }) => {
      await prepareApp(request);
      await seed(request, {});
      await openCriteria(page, item.viewpointId);

      for (const [label, value] of Object.entries(item.values)) {
        await card(page, item.indicator).getByLabel(label).fill(value);
      }
      await save(page).click();

      await expect(page.getByTestId(`criterion-error-${item.indicator}`)).toHaveText(item.message);
      await expect(notice(page)).toHaveCount(0);
      await expect(state(page)).toContainText('既定値');
    });
  }

  const notNumbers: readonly { name: string; value: string }[] = [
    { name: '空', value: '' },
    { name: '空白のみ', value: '   ' },
    { name: '数値でない（abc）', value: 'abc' },
    { name: '数値でない（1,5）', value: '1,5' },
    { name: '数値として表せない大きさ（1e999）', value: '1e999' },
  ];

  for (const item of notNumbers) {
    test(`閾値が${item.name}: 「数値で指定してください」のエラーを表示し、保存しない`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await seed(request, {});
      await openCriteria(page, 'harvestAccuracy');

      await card(page, 'marketableFruitRatePercent')
        .getByLabel('注意下限（未満で注意）')
        .fill(item.value);
      await save(page).click();

      await expect(
        fieldError(page, 'marketableFruitRatePercent', 'criteria.0.thresholds.cautionBelow'),
      ).toHaveText('閾値は数値で指定してください');
      await expect(notice(page)).toHaveCount(0);
    });
  }

  test('負の値・小数の閾値は、数値として入力でき、大小関係が成り立てば、保存できる（温度の異常下限 -5.5）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {});
    await openCriteria(page, 'environmentalAdaptability');

    await card(page, 'temperatureCelsius').getByLabel('異常下限（未満で異常）').fill('-5.5');
    await save(page).click();

    await expect(notice(page)).toHaveText('保存しました。現在の評価を更新しました');
  });

  const labels: readonly { name: string; value: string; ok: boolean }[] = [
    { name: '空', value: '', ok: false },
    { name: '空白のみ', value: '   ', ok: false },
    { name: '1文字（境界）', value: 'a', ok: true },
    { name: '200文字（境界）', value: 'あ'.repeat(200), ok: true },
    { name: '201文字（境界の外）', value: 'あ'.repeat(201), ok: false },
  ];

  for (const item of labels) {
    test(`条件名が${item.name}: ${item.ok ? '保存できる' : 'エラーを表示し、保存しない'}`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await seed(request, {});
      await openCriteria(page, 'harvestAccuracy');

      await card(page, 'marketableFruitRatePercent').getByLabel('条件名').fill(item.value);
      await save(page).click();

      if (item.ok) {
        await expect(notice(page)).toHaveText('保存しました。現在の評価を更新しました');
      } else {
        await expect(
          fieldError(page, 'marketableFruitRatePercent', 'criteria.0.label'),
        ).toBeVisible();
        await expect(notice(page)).toHaveCount(0);
      }
    });
  }

  test('エラーを直して、もう一度保存できる。一部の指標だけ不正でも、全体を保存しない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {});
    await openCriteria(page, 'harvestAccuracy');
    await card(page, 'recognitionAccuracyPercent').getByLabel('注意下限（未満で注意）').fill('70');
    await card(page, 'marketableFruitRatePercent').getByLabel('注意下限（未満で注意）').fill('91');
    await save(page).click();
    await expect(page.getByTestId('criterion-error-recognitionAccuracyPercent')).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
    // 同時に入力した正しい指標（可販果率）も、保存されていない
    await page.reload();
    await expect(
      card(page, 'marketableFruitRatePercent').getByLabel('注意下限（未満で注意）'),
    ).toHaveValue('90');
    await card(page, 'recognitionAccuracyPercent').getByLabel('注意下限（未満で注意）').fill('70');
    await card(page, 'marketableFruitRatePercent').getByLabel('注意下限（未満で注意）').fill('91');
    await save(page).click();
    await expect(page.getByTestId('criterion-error-recognitionAccuracyPercent')).toBeVisible();

    await card(page, 'recognitionAccuracyPercent').getByLabel('注意下限（未満で注意）').fill('92');
    await save(page).click();

    await expect(notice(page)).toHaveText('保存しました。現在の評価を更新しました');
    await expect(page.getByTestId('criterion-error-recognitionAccuracyPercent')).toHaveCount(0);
    await page.reload();
    await expect(
      card(page, 'marketableFruitRatePercent').getByLabel('注意下限（未満で注意）'),
    ).toHaveValue('91');
    await expect(
      card(page, 'recognitionAccuracyPercent').getByLabel('注意下限（未満で注意）'),
    ).toHaveValue('92');
  });
});

test.describe('ステータスコードで判定する指標・存在しない観点', () => {
  test('ステータスコードでも判定する観点（収穫速度・メンテナンス性・耐久性）では、ステータスの判定は、ここでは編集できない旨と、ステータスコードへの導線を示す', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, merge(harvestSpeedData('NORMAL'), durabilityData('NORMAL')));

    for (const viewpointId of ['harvestSpeed', 'maintainability', 'durability']) {
      await page.goto(`/viewpoints/${viewpointId}/criteria`);
      if (viewpointId === 'harvestSpeed') {
        await alignBrowserClock(page);
        await openAs(page, `/viewpoints/${viewpointId}/criteria`);
      }
      await expect(page.getByTestId('criteria-status-note')).toContainText(
        'ステータスコードのカテゴリ（正常・注意・異常）でも判定します',
      );
      await expect(
        page.getByTestId('criteria-status-note').getByRole('link', { name: 'ステータスコードへ' }),
      ).toHaveAttribute('href', '/settings/status-codes');
    }
    // ステータスを使わない観点では、表示しない
    await page.goto('/viewpoints/harvestAccuracy/criteria');
    await expect(page.getByTestId('criteria-status-note')).toHaveCount(0);
  });

  test('存在しない観点を開くと、その旨を表示する', async ({ page, request }) => {
    await prepareApp(request);
    await alignBrowserClock(page);

    await openAs(page, '/viewpoints/no-such-viewpoint/criteria');

    await expect(page.getByRole('alert')).toContainText('観点が見つかりません');
  });
});

test.describe('事後条件: 変更はシステム全体（すべての利用者）に適用される。変更の履歴を残す', () => {
  test('利用者Aが判断基準を変更すると、利用者Bの画面にも、変更済みの基準・評価が反映される（複数ユーザーのシナリオ）', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await seed(request, environmentData({ temperature: 27 }));
    // 利用者B: 変更前の画面（注意）
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/viewpoints/environmentalAdaptability', USER_B);
    await expect(
      b.page.getByTestId('diagnosis').locator('.diagnosis-head .status-badge'),
    ).toContainText('注意');
    await expect(b.page.getByTestId('criteria-state')).toContainText('既定値');

    // 利用者A: 変更して保存する
    await openCriteria(page, 'environmentalAdaptability');
    await card(page, 'temperatureCelsius').getByLabel('正常上限（未満で正常）').fill('30');
    await save(page).click();
    await expect(notice(page)).toBeVisible();

    // 利用者B: 再読み込みで、変更済みの基準・評価になる
    await b.page.reload();
    await expect(
      b.page.getByTestId('diagnosis').locator('.diagnosis-head .status-badge'),
    ).toContainText('正常');
    await expect(b.page.getByTestId('criteria-state')).toContainText('変更済み（版: CUSTOM-1）');
    await expect(b.page.getByTestId('diagnostic-message')).toContainText(
      'カスタムの判断基準による判定です',
    );
    await shot(b.page, testInfo, 'uc19-user-b');
    await b.context.close();
  });

  test('同時編集の検出（SC-13-1）: 2 人の管理者が同じ判断基準を開き、先に保存すると、後から保存した人には、「他の管理者が変更しました」と示す。読み込み直せば、保存できる。先の変更は、上書きされない', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await seed(request, {});
    const b = await newUserSession(browser, testInfo, 'user-b');
    // 2 人とも、既定値の判断基準を開く
    await openCriteria(page, 'environmentalAdaptability');
    await openCriteria(b.page, 'environmentalAdaptability', USER_B);
    await expect(state(b.page)).toContainText('既定値');

    // 先に、利用者Aが保存する
    await card(page, 'temperatureCelsius').getByLabel('正常上限（未満で正常）').fill('30');
    await save(page).click();
    await expect(state(page)).toContainText('版: CUSTOM-1');

    // 後から、利用者Bが（古い画面から）保存する: 競合の案内。保存されない
    await card(b.page, 'humidityPercent').getByLabel('正常上限（未満で正常）').fill('75');
    await save(b.page).click();
    const conflict = b.page.getByTestId('criteria-conflict');
    await expect(conflict).toContainText('他の管理者が変更しました。読み込み直してください');
    await expect(conflict.getByRole('button', { name: '読み込み直す' })).toBeVisible();
    await expect(notice(b.page)).toHaveCount(0);
    await shot(b.page, testInfo, 'uc19-conflict');
    const stored = (await (
      await api(request, 'GET', '/viewpoints/environmentalAdaptability/criteria')
    ).json()) as {
      version: string;
      criteria: { indicator: string; thresholds: Record<string, number> }[];
    };
    expect(stored.version).toBe('CUSTOM-1');
    expect(
      stored.criteria.find((item) => item.indicator === 'temperatureCelsius')?.thresholds
        .normalUpper,
    ).toBe(30);
    expect(
      stored.criteria.find((item) => item.indicator === 'humidityPercent')?.thresholds.normalUpper,
    ).not.toBe(75);

    // 読み込み直すと、利用者Aの変更（版 CUSTOM-1）が表示され、案内は消える。もう一度保存できる
    await conflict.getByRole('button', { name: '読み込み直す' }).click();
    await expect(state(b.page)).toContainText('版: CUSTOM-1');
    await expect(conflict).toHaveCount(0);
    await expect(
      card(b.page, 'temperatureCelsius').getByLabel('正常上限（未満で正常）'),
    ).toHaveValue('30');
    await card(b.page, 'humidityPercent').getByLabel('正常上限（未満で正常）').fill('75');
    await save(b.page).click();
    await expect(notice(b.page)).toBeVisible();
    await expect(state(b.page)).toContainText('版: CUSTOM-2');
    await b.context.close();
  });

  test('同時編集の検出（SC-13-1）: 既定値へ戻す操作も、他の管理者が先に変更していれば、戻さず、案内を示す', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await seed(request, {});
    const first = await newUserSession(browser, testInfo, 'user-b');
    await openCriteria(page, 'harvestAccuracy');
    await card(page, 'marketableFruitRatePercent').getByLabel('注意下限（未満で注意）').fill('92');
    await save(page).click();
    await expect(state(page)).toContainText('版: CUSTOM-1');
    // 利用者B: 変更済みの画面を開いたあと、利用者Aがさらに変更する
    await openCriteria(first.page, 'harvestAccuracy', USER_B);
    await card(page, 'marketableFruitRatePercent').getByLabel('注意下限（未満で注意）').fill('93');
    await save(page).click();
    await expect(state(page)).toContainText('版: CUSTOM-2');

    await first.page.getByRole('button', { name: '既定値へ戻す' }).click();
    await confirmDialog(first.page, '既定値へ戻す');

    await expect(first.page.getByTestId('criteria-conflict')).toContainText(
      '他の管理者が変更しました',
    );
    const stored = (await (
      await api(request, 'GET', '/viewpoints/harvestAccuracy/criteria')
    ).json()) as { version: string; isDefault: boolean };
    expect(stored).toMatchObject({ version: 'CUSTOM-2', isDefault: false });
    await first.context.close();
  });

  test('変更・既定値へ戻す操作は、変更履歴に、変更者・変更前後とともに残る（UC-18）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {});
    await openCriteria(page, 'harvestAccuracy');
    await card(page, 'marketableFruitRatePercent').getByLabel('注意下限（未満で注意）').fill('92');
    await save(page).click();
    await expect(notice(page)).toBeVisible();
    await page.getByRole('button', { name: '既定値へ戻す' }).click();
    await confirmDialog(page, '既定値へ戻す');
    await expect(notice(page)).toHaveText('既定値へ戻しました');

    await page.goto('/data-entry/history?targetType=criteria');

    const history = page.getByTestId('audit-row');
    await expect(history).toHaveCount(2);
    await expect(history.first()).toContainText('判断基準');
    await expect(history.first()).toContainText('harvestAccuracy');
    await expect(history.first()).toContainText(userIdText('e2e-user'));
    await expect(history.first()).toContainText('編集');
    // 変更（1件目）と、既定値へ戻す操作（2件目）の、2件。どちらも、操作種別は「編集」
    await expect(history.nth(1)).toContainText('harvestAccuracy');
    await expect(history.nth(1)).toContainText(userIdText('e2e-user'));
    await expect(history.nth(1)).toContainText('編集');
    const body: unknown = await (
      await api(request, 'GET', '/audit-logs?targetType=criteria')
    ).json();
    expect(JSON.stringify(body)).toContain('CUSTOM-1');
    // 変更前後の版: 変更（DEFAULT → CUSTOM-1）、既定値へ戻す（CUSTOM-1 → DEFAULT）
    const versions = (
      body as { items: { before: { version: string }; after: { version: string } }[] }
    ).items
      .map((item) => `${item.before.version}→${item.after.version}`)
      .sort();
    expect(versions).toEqual(['CUSTOM-1→DEFAULT', 'DEFAULT→CUSTOM-1']);
  });

  test('変更した基準で、状態が悪化すると（注意 → 異常）、通知を作る（UC-10への連携）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, environmentData({ temperature: 27 }));
    const before = await listNotifications(request);
    await openCriteria(page, 'environmentalAdaptability');

    // 温度の異常上限を 26℃に下げる（27℃ は、異常になる）。正常上限・注意の範囲も合わせる
    const temperature = card(page, 'temperatureCelsius');
    await temperature.getByLabel('正常上限（未満で正常）').fill('20');
    await temperature.getByLabel('異常上限（以上で異常）').fill('26');
    await save(page).click();
    await expect(notice(page)).toBeVisible();

    const after = await listNotifications(request);
    const sensorErrors = after.filter(
      (item) => item.viewpointId === 'environmentalAdaptability' && item.status === 'ERROR',
    );
    expect(sensorErrors.length).toBeGreaterThan(0);
    expect(sensorErrors[0]?.message).toContain('カスタムの判断基準による判定です');
    expect(after.length).toBeGreaterThan(before.length);
  });

  test('過去の評価は、再計算せず保持する（ステータスの推移に、変更前の状態が残る）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, environmentData({ temperature: 27 }));
    // 状態の変化は、時刻ごとに記録する（変更前の評価と、変更後の評価を、別の時刻にする）
    await advanceMinutes(request, 1);
    await openCriteria(page, 'environmentalAdaptability');
    await card(page, 'temperatureCelsius').getByLabel('正常上限（未満で正常）').fill('30');
    await save(page).click();
    await expect(notice(page)).toBeVisible();

    await page.goto('/viewpoints/environmentalAdaptability?equipmentId=SENSOR-01');

    // 変更前（注意）→ 変更後（正常）の推移が、残る
    await expect(page.getByTestId('status-history').locator('.status-segment')).toHaveText([
      '注意',
      '正常',
    ]);
  });
});

test.describe('権限: 編集する権限のない利用者（閲覧者）は、参照のみ', () => {
  test('閲覧者には、保存・既定値へ戻す操作を表示せず、閾値を変更できない。サーバー側でも拒否する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, VIEWER);
    await seed(request, {});

    await openCriteria(page, 'harvestAccuracy', VIEWER);

    await expect(page.getByTestId('permission-notice')).toHaveText(
      '判断基準を編集する権限がありません。参照のみできます',
    );
    await expect(save(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '既定値へ戻す' })).toHaveCount(0);
    await expect(
      card(page, 'marketableFruitRatePercent').getByLabel('注意下限（未満で注意）'),
    ).toHaveAttribute('readonly', '');
    await shot(page, testInfo, 'uc19-readonly');
    const login = await request.post('/api/v1/auth/login', {
      data: { userId: VIEWER.userId, password: VIEWER.password },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const denied = await request.fetch('/api/v1/viewpoints/harvestAccuracy/criteria/reset', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(denied.status()).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 境界値・最大長（条件名 200 文字・大きな閾値）と、画面の幅（1280・768・375px）: 表・入力欄が、潰れず、はみ出さない
// ---------------------------------------------------------------------------

const LONG_LABEL_JAPANESE = 'あ'.repeat(200);
const LONG_LABEL_ASCII = 'W'.repeat(200);
const HUGE_THRESHOLD = -123456789012345;

const LAYOUT_VIEWPORTS = [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 720 },
  { name: 'タブレット幅（768px。NFR-7.3）', width: 768, height: 1024 },
  { name: 'スマートフォン幅（375px）', width: 375, height: 667 },
] as const;

/** 左のメニューの幅（app.css の .app-sidebar）と、メニューが引き出しになる幅（900px 以下）。引き出しでない幅では、本文は、メニューの分だけ狭い */
const SIDEBAR_WIDTH = 236;
const DRAWER_MAX_VIEWPORT_WIDTH = 900;

/** 判断基準のカードの幅の下限。メニューが左にある幅では、本文（画面幅 − メニュー）の 90%、引き出しの幅では、画面幅の 80%。 */
function minCardWidth(viewportWidth: number): number {
  return viewportWidth > DRAWER_MAX_VIEWPORT_WIDTH
    ? (viewportWidth - SIDEBAR_WIDTH) * 0.9
    : viewportWidth * 0.8;
}

/** 環境適応性のすべての指標の条件名を最大長にし、温度の異常下限を桁の多い値にして、API で保存する（温度 40℃は異常のまま）。 */
async function saveLongCriteria(request: Parameters<typeof api>[0], label: string): Promise<void> {
  const read = await api(request, 'GET', '/viewpoints/environmentalAdaptability/criteria');
  // 判断基準の更新は、読み込んだ時点の版（ETag）を If-Match に付ける（SC-13-1）
  const etag = read.headers().etag ?? '';
  const current = (await read.json()) as {
    criteria: {
      indicator: string;
      kind: string;
      label: string;
      thresholds: Record<string, number>;
    }[];
  };
  const criteria = current.criteria.map((criterion) => ({
    ...criterion,
    label,
    thresholds:
      criterion.indicator === 'temperatureCelsius'
        ? { ...criterion.thresholds, errorLower: HUGE_THRESHOLD }
        : criterion.thresholds,
  }));
  const saved = await api(
    request,
    'PUT',
    '/viewpoints/environmentalAdaptability/criteria',
    { criteria },
    { 'if-match': etag },
  );
  expect(saved.status(), '最大長の判断基準の保存').toBe(200);
}

/** 画面が横にはみ出さず、要素が、1文字幅へ潰れていない（指定した要素の最小の幅・高さ）。 */
async function expectNotCrushed(
  page: Page,
  selector: string,
  limits: { minWidth: number; maxHeight: number },
): Promise<void> {
  const sizes = await page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  expect(sizes.length, `${selector} の数`).toBeGreaterThan(0);
  for (const size of sizes) {
    expect(size.width, `${selector} の幅 ${JSON.stringify(sizes)}`).toBeGreaterThanOrEqual(
      limits.minWidth,
    );
    expect(size.height, `${selector} の高さ ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(
      limits.maxHeight,
    );
  }
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(widths.scroll, `ページの横幅 ${JSON.stringify(widths)}`).toBeLessThanOrEqual(widths.inner);
}

for (const viewport of LAYOUT_VIEWPORTS) {
  test.describe(`${viewport.name}: 条件名が最大長（200文字）・閾値の桁が多くても、判断基準の画面が、潰れず、はみ出さない`, () => {
    for (const [kind, label] of [
      ['ja', LONG_LABEL_JAPANESE],
      ['ascii', LONG_LABEL_ASCII],
    ] as const) {
      test(`判断基準の編集（SC-13）・観点の詳細の判断基準の表（SC-03）・診断メッセージ・変更履歴・通知: 条件名 ${kind === 'ja' ? '日本語' : '区切りのない英字'}200文字`, async ({
        page,
        request,
      }, testInfo) => {
        await prepareApp(request);
        await seed(request, environmentData({ temperature: 40 }));
        await saveLongCriteria(request, label);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const suffix = `${String(viewport.width)}-${kind}`;

        // SC-13: 条件名・閾値の入力欄が、読める幅で並び、ページが横にはみ出さない
        await openCriteria(page, 'environmentalAdaptability');
        await expect(card(page, 'temperatureCelsius').getByLabel('条件名')).toHaveValue(label);
        await expect(
          card(page, 'temperatureCelsius').getByLabel('異常下限（未満で異常）'),
        ).toHaveValue(String(HUGE_THRESHOLD));
        await expectNoPageOverflow(page);
        await expectNotCrushed(page, '.criterion-card input', { minWidth: 120, maxHeight: 60 });
        await expectNotCrushed(page, '.criterion-card', {
          minWidth: minCardWidth(viewport.width),
          maxHeight: 1400,
        });
        await shot(page, testInfo, `uc19-long-edit-${suffix}`);

        // SC-03: 判断基準の表（条件名・条件）が、列ごとに1文字幅へ潰れない。診断メッセージも、枠の中に収まる
        await page.getByRole('link', { name: '観点の詳細へ戻る' }).click();
        await expect(page.getByTestId('criterion-temperatureCelsius')).toContainText(
          label.slice(0, 20),
        );
        await expectNoPageOverflow(page);
        await expectNotCrushed(page, '[data-testid="criteria"] tbody tr', {
          minWidth: 200,
          maxHeight: 1000,
        });
        await expectNotCrushed(page, '[data-testid="criteria"] tbody td', {
          minWidth: 60,
          maxHeight: 700,
        });
        await expect(page.getByTestId('diagnostic-message').first()).toBeVisible();
        await shot(page, testInfo, `uc19-long-detail-${suffix}`);

        // ダッシュボード（SC-01）: 環境適応性のカードの診断メッセージ（条件名つき）
        await page.goto('/');
        await expect(page.getByTestId('card-environmentalAdaptability')).toContainText(
          label.slice(0, 20),
        );
        await expectNoPageOverflow(page);
        await shot(page, testInfo, `uc19-long-dashboard-${suffix}`);

        // 変更履歴（SC-08）: 判断基準の変更の行
        await page.goto('/data-entry/history?targetType=criteria');
        await expect(page.getByTestId('audit-row')).toHaveCount(1);
        await expectNoPageOverflow(page);
        if (viewport.width > DRAWER_MAX_VIEWPORT_WIDTH) {
          await expectNotCrushed(page, '.audit-table thead th', { minWidth: 60, maxHeight: 60 });
        } else {
          // 狭い幅（900px 以下）では、1 行が 1 枚のカードになる（見出しの行は、視覚的に隠す）
          await expectNotCrushed(page, '.audit-table tbody tr', {
            minWidth: viewport.width * 0.8,
            maxHeight: 1400,
          });
        }
        await shot(page, testInfo, `uc19-long-history-${suffix}`);

        // 通知（SC-10）: 異常の通知（温度 40℃ の異常は、判断基準の変更の前に通知済み。条件名は含まない）
        await page.goto('/notifications');
        await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
        await expect(page.getByTestId('notification-row').first()).toContainText('異常');
        await expectNoPageOverflow(page);
        await shot(page, testInfo, `uc19-long-notifications-${suffix}`);
      });
    }

    test('不正な入力のエラー（項目・条件の大小関係）は、狭い幅でも、入力欄と被らず、はみ出さない', async ({
      page,
      request,
    }, testInfo) => {
      await prepareApp(request);
      await seed(request, {});
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openCriteria(page, 'environmentalAdaptability');
      const temperature = card(page, 'temperatureCelsius');
      await temperature.getByLabel('条件名').fill('');
      await temperature.getByLabel('異常下限（未満で異常）').fill('abc');
      await temperature.getByLabel('正常下限（以上で正常）').fill('30');
      await card(page, 'humidityPercent').getByLabel('正常上限（未満で正常）').fill('1');
      await save(page).click();

      await expect(fieldError(page, 'temperatureCelsius', 'criteria.0.label')).toBeVisible();
      // 条件の大小関係のエラー（湿度の正常上限 1 は、正常下限より小さい）
      await expect(page.getByTestId('criterion-error-humidityPercent')).toBeVisible();
      await expectNoPageOverflow(page);
      await shot(page, testInfo, `uc19-error-${String(viewport.width)}`);
    });
  });
}

test.describe('閾値のスライダー・帯・現在値と変更後の値（Issue #358。全観点で共通の部品）', () => {
  const slider = (page: Page, indicator: string, name: string) =>
    card(page, indicator).getByRole('slider', { name });
  const meta = (page: Page, indicator: string, index: number) =>
    card(page, indicator).getByTestId('threshold-meta').nth(index);

  test('閾値ごとに、スライダーと数値の欄が連動し、範囲の目安・単位・現在値と変更後の値を示す。スライダーで調整して保存すると、評価に反映される', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, environmentData({ temperature: 15 }));
    await openCriteria(page, 'environmentalAdaptability');
    const temperature = card(page, 'temperatureCelsius');

    // 範囲型（温度）: 4 つのスライダー。目安の範囲・単位・現在値・変更なし
    await expect(temperature.getByRole('slider')).toHaveCount(4);
    await expect(slider(page, 'temperatureCelsius', '正常下限のスライダー')).toHaveValue('10');
    await expect(meta(page, 'temperatureCelsius', 1)).toHaveText(
      '目安の範囲: -10℃〜50℃現在値: 10℃変更後: 10℃（変更なし）',
    );
    // 変更前は、現在の帯だけ（範囲型は 5 区分）
    await expect(page.getByTestId('zone-current-temperatureCelsius')).toBeVisible();
    await expect(page.getByTestId('zone-after-temperatureCelsius')).toHaveCount(0);
    await expect(
      page.getByTestId('zone-current-temperatureCelsius').locator('.zone-seg-label'),
    ).toHaveText(['異常', '注意', '正常', '注意', '異常']);

    // スライダーを動かす → 数値の欄・変更後の値・変更後の帯が連動する
    await slider(page, 'temperatureCelsius', '正常下限のスライダー').fill('20');
    await expect(temperature.getByLabel('正常下限（以上で正常）')).toHaveValue('20');
    await expect(meta(page, 'temperatureCelsius', 1)).toHaveText(
      '目安の範囲: -10℃〜50℃現在値: 10℃変更後: 20℃',
    );
    await expect(page.getByTestId('zone-after-temperatureCelsius')).toBeVisible();
    await shot(page, testInfo, 'uc19-slider-changed');

    // 数値の欄に入力 → スライダーが連動する
    await temperature.getByLabel('正常下限（以上で正常）').fill('18');
    await expect(slider(page, 'temperatureCelsius', '正常下限のスライダー')).toHaveValue('18');

    // 保存すると、評価に反映される（温度 15℃ は、正常下限 18 未満で、注意）
    await save(page).click();
    await expect(notice(page)).toBeVisible();
    await expect(page.getByTestId('zone-after-temperatureCelsius')).toHaveCount(0);
    await expect(meta(page, 'temperatureCelsius', 1)).toContainText('現在値: 18℃');
    await page.goto('/');
    await expect(
      page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('注意');
  });

  test('キーボード（矢印キー・Home・End）でも、スライダーを操作できる。目盛り（0.5）ごとに動く', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {});
    await openCriteria(page, 'environmentalAdaptability');
    const upper = slider(page, 'temperatureCelsius', '異常上限のスライダー');

    await upper.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(card(page, 'temperatureCelsius').getByLabel('異常上限（以上で異常）')).toHaveValue(
      '36',
    );
    await page.keyboard.press('End');
    await expect(card(page, 'temperatureCelsius').getByLabel('異常上限（以上で異常）')).toHaveValue(
      '50',
    );
    await page.keyboard.press('Home');
    await expect(card(page, 'temperatureCelsius').getByLabel('異常上限（以上で異常）')).toHaveValue(
      '-10',
    );
    // 大小関係が成り立たない間は、変更後の帯を出さず、その旨を示す（保存の検証のエラーとは別）
    await expect(page.getByTestId('zone-invalid-temperatureCelsius')).toBeVisible();
    await expect(page.getByTestId('zone-after-temperatureCelsius')).toHaveCount(0);
    await expect(page.getByTestId('criterion-error-temperatureCelsius')).toHaveCount(0);
  });

  test('すべての観点（9 観点）の判断基準の編集に、同じ部品（スライダー・帯・現在値と変更後の値）がある', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {});
    const viewpoints = [
      ['harvestAccuracy', 'marketableFruitRatePercent'],
      ['harvestSpeed', 'travelStoppedRatePercent'],
      ['environmentalAdaptability', 'co2Ppm'],
      ['operability', 'operationMinutes'],
      ['maintainability', 'mttrHours'],
      ['costEfficiency', 'economicProductivity'],
      ['safety', 'emergencyStopPerHour'],
      ['dataUtilization', 'dataCoveragePercent'],
      ['durability', 'mtbfHours'],
    ] as const;
    await alignBrowserClock(page);
    for (const [viewpointId, indicator] of viewpoints) {
      await openAs(page, `/viewpoints/${viewpointId}/criteria`);
      await expect(card(page, indicator).getByRole('slider').first()).toBeVisible();
      await expect(page.getByTestId(`zone-current-${indicator}`)).toBeVisible();
      await expect(meta(page, indicator, 0)).toContainText('変更なし');
    }
  });

  test('下限型の満足度（総合満足度）も、同じ部品で編集できる。満足度の詳細から入り、スライダーで注意下限を 3.5 にすると、総合満足度 3.9 は正常になる（Issue #359）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, satisfactionData([4, 4, 4, 4, 4, 4, 4, 4, 3]));
    await alignBrowserClock(page);
    await openAs(page, '/satisfaction');
    await expect(page.getByTestId('overall-score')).toHaveText('3.9');
    await expect(page.locator('.overall .status-badge')).toContainText('注意');
    await expect(page.getByTestId('criteria-state')).toHaveText('既定値');

    // 満足度の詳細の「判断基準を編集」から、判断基準の編集へ
    await page.getByRole('link', { name: '判断基準を編集' }).click();
    await expect(page.getByRole('heading', { name: /判断基準の編集/, level: 1 })).toBeVisible();
    const overall = card(page, 'overallSatisfaction');
    await expect(overall.getByRole('slider', { name: '注意下限のスライダー' })).toHaveValue('4');
    await expect(meta(page, 'overallSatisfaction', 0)).toHaveText(
      '目安の範囲: 1〜5現在値: 4変更後: 4（変更なし）',
    );
    await overall.getByRole('slider', { name: '注意下限のスライダー' }).fill('3.5');
    await expect(overall.getByLabel('注意下限（未満で注意）')).toHaveValue('3.5');
    await expect(page.getByTestId('zone-after-overallSatisfaction')).toBeVisible();
    await shot(page, testInfo, 'uc19-satisfaction-slider');
    await save(page).click();
    await expect(notice(page)).toBeVisible();

    // 満足度の詳細へ戻ると、変更済みで、総合満足度は、変更後の基準で、正常
    await page.getByRole('link', { name: '観点の詳細へ戻る' }).click();
    await expect(page).toHaveURL(/\/satisfaction$/);
    await expect(page.locator('.overall .status-badge')).toContainText('正常');
    await expect(page.getByTestId('criteria-state')).toContainText('変更済み');
    await expect(page.getByRole('list', { name: '判断基準' })).toContainText('3.5以上');
  });

  test('編集の権限がなければ、スライダーは操作できない（無効）。現在値・帯は見える', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seed(request, {});
    await addUser(request, VIEWER);
    await openCriteria(page, 'harvestAccuracy', VIEWER);

    const sliders = card(page, 'marketableFruitRatePercent').getByRole('slider');
    await expect(sliders).toHaveCount(2);
    for (const index of [0, 1]) {
      await expect(sliders.nth(index)).toBeDisabled();
    }
    await expect(page.getByTestId('zone-current-marketableFruitRatePercent')).toBeVisible();
  });

  for (const viewport of [
    { name: 'デスクトップ幅（1280px）', width: 1280, height: 900 },
    { name: 'タブレット幅（768px）', width: 768, height: 1024 },
    { name: 'スマートフォン幅（375px）', width: 375, height: 800 },
  ]) {
    test(`${viewport.name}: スライダー・数値の欄・目安・帯が、はみ出さず、押せる大きさで、並ぶ`, async ({
      page,
      request,
    }, testInfo) => {
      await prepareApp(request);
      await seed(request, environmentData({ temperature: 15 }));
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openCriteria(page, 'environmentalAdaptability');
      await slider(page, 'temperatureCelsius', '正常下限のスライダー').fill('20');

      await expectNoPageOverflow(page);
      // スライダー・数値の欄は、潰れない（幅・高さ）
      await expectNotCrushed(page, '.criterion-card .threshold-slider', {
        minWidth: 90,
        maxHeight: 60,
      });
      await expectNotCrushed(
        page,
        '.criterion-card .threshold-controls input:not([type="range"])',
        {
          minWidth: 70,
          maxHeight: 60,
        },
      );
      await expectNotCrushed(page, '.criterion-card .zone-bar', { minWidth: 200, maxHeight: 40 });
      // スライダーは、指で押せる大きさ（高さ 44px 以上）
      const box = await slider(page, 'temperatureCelsius', '異常上限のスライダー').boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      await shot(page, testInfo, `uc19-slider-layout-${String(viewport.width)}`);
    });
  }
});
