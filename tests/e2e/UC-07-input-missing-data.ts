/**
 * UC-07 取得できないデータを手動で入力・補完する（SC-06。FR-4.1.1、FR-4.1.3〜FR-4.1.5）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、入力画面を開き、対象のハウス・ロボット・センサーと、補完する項目を選ぶ
 *               2. 農作業者が、値と対象の期間・時刻を入力する
 *               3. システムが、入力内容を検証して保存する
 *               4. システムが、手動入力であることを区別できる形でデータを保持する
 *               5. システムが、評価を更新し、「注意」「異常」があれば通知につなげる（UC-10）
 *   代替フロー  自動取り込みと手動入力で同じ項目・時刻の値が重なる場合の扱い（暫定: 手動入力を評価に使い、両方を保持する）
 *               入力内容が不正な場合は、UC-06 と同様にエラーを表示する
 *
 * 値の同値分割: カテゴリ（手動入力できる7カテゴリ）、設備の種別（ハウス・ロボット・センサー）、環境の値の範囲（湿度 0〜100・温度 −50〜100・照度 0〜200,000・CO2 濃度 0〜10,000 の境界、
 * 温度の正常・注意・異常）、満足度（1〜5 の境界）、自動取り込みとの重なり（同じ時刻・別の時刻）。
 * 関連するユースケース: UC-20（取得元の区別を一覧で確認）、UC-10（保存後の通知）、UC-01（評価の反映）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  HOUSE_ID,
  ROBOT_ID,
  SENSOR_ID,
  VIEWER,
  addUser,
  alignBrowserClock,
  api,
  goToMenu,
  openAs,
  prepareApp,
} from './support/app.ts';
import {
  SATISFACTION_LABELS,
  allSatisfactionStars,
  expectRelatedStatus,
  fieldError,
  fillEntryForm,
  mainArea,
  satisfactionApiItems,
  saveEntry,
  starGroup,
  type EntryFormValues,
} from './support/entry.ts';
import { expectNoHorizontalScroll } from './support/pages.ts';
import { environmentData, hoursAgo, seed, shot } from './support/viewpoint-scenarios.ts';

async function openEntry(page: Page): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/');
  await goToMenu(page, 'データ入力');
  await expect(page.getByRole('heading', { name: 'データ入力', level: 1 })).toBeVisible();
}

/** 1時間前（日本時間 11:00）。 */
const AT = '2026-10-09T11:00';

test.describe('基本フロー: センサーから取得できない環境の値を、手動で補完する', () => {
  test('環境センサーの温度・湿度・照度・CO2濃度を入力して保存すると、手動入力として保持され、環境適応性の評価に反映される', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openEntry(page);

    // 1. 対象のセンサーと、補完する項目（環境情報）を選ぶ
    await fillEntryForm(page, { equipment: SENSOR_ID, category: 'ENVIRONMENT' });
    await expect(mainArea(page).getByTestId('entry-items').getByRole('textbox')).toHaveCount(4);
    // 2. 値と、対象の時刻を入力する
    await fillEntryForm(page, {
      observedAt: AT,
      items: { 温度: '27', 湿度: '60', 照度: '30000', CO2濃度: '900' },
      note: 'センサーが取得できなかった時間帯を、現場の温湿度計から補った',
    });
    await shot(page, testInfo, 'uc07-form');

    // 3. 検証して保存する → 5. 評価の更新（温度 27℃ は範囲型の「注意」）
    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toContainText('保存しました');
    await expectRelatedStatus(page, 'environmentalAdaptability', '注意');
    await shot(page, testInfo, 'uc07-saved');

    // 4. 手動入力であることを区別できる形で保持する（取り込み済みデータの一覧の取得元）
    await goToMenu(page, '取り込み済みデータ');
    const rows = page.getByTestId('observation-row');
    await expect(rows).toHaveCount(4);
    for (const row of await rows.all()) {
      await expect(row).toContainText('手動入力');
      await expect(row).toContainText('環境センサー1');
    }
    await expect(rows.filter({ hasText: '温度' })).toContainText('27℃');
    await shot(page, testInfo, 'uc07-observations');
  });

  test('対象の設備は、ハウス・ロボット・センサーのいずれも選べる（階層で表示）。入力画面は、メニュー「データ入力」から開く', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);

    const equipment = mainArea(page).getByLabel('対象の設備');
    await expect(equipment.locator('option')).toHaveText([
      '選択してください',
      'ハウス1',
      '　収穫ロボット1',
      '　環境センサー1',
    ]);
    for (const id of [HOUSE_ID, ROBOT_ID, SENSOR_ID]) {
      await equipment.selectOption(id);
      await expect(equipment).toHaveValue(id);
    }
    // 計測日時の既定は、現在の日時（日本時間）。値と対象の時刻を入力できる
    await expect(mainArea(page).getByLabel('計測日時（日本時間）')).toHaveValue('2026-10-09T12:00');
  });

  const categories: readonly {
    name: string;
    equipment: string;
    category: string;
    items: Record<string, string>;
    /** スターで選ぶ項目（満足度）。 */
    stars?: Record<string, number>;
    count: number;
  }[] = [
    {
      name: '操作情報',
      equipment: ROBOT_ID,
      category: 'OPERABILITY',
      items: { 操作ステップ数: '4', 操作時間: '8', 操作エラー数: '0' },
      count: 3,
    },
    {
      name: '収穫情報',
      equipment: ROBOT_ID,
      category: 'HARVEST',
      items: {
        収穫試行回数: '100',
        収穫成功回数: '95',
        果実損傷数: '2',
        誤認識数: '1',
        誤収穫数: '1',
        取り残し数: '3',
      },
      count: 6,
    },
    {
      name: '安全情報',
      equipment: ROBOT_ID,
      category: 'SAFETY',
      items: { 緊急停止回数: '0', ヒヤリハット件数: '1' },
      count: 2,
    },
    {
      name: 'コスト情報',
      equipment: ROBOT_ID,
      category: 'COST',
      items: { ロボットコスト: '300', 人件費: '1200', メンテナンス費: '500', 電気代: '400' },
      count: 4,
    },
    {
      name: '故障情報',
      equipment: ROBOT_ID,
      category: 'FAILURE',
      items: { 故障回数: '1', 復旧に要した時間: '30' },
      count: 2,
    },
    {
      name: '環境情報（ハウスへの入力）',
      equipment: HOUSE_ID,
      category: 'ENVIRONMENT',
      items: { 温度: '22', 湿度: '60' },
      count: 2,
    },
    {
      name: '満足度情報（ハウスへの入力）',
      equipment: HOUSE_ID,
      category: 'SATISFACTION',
      items: {},
      stars: allSatisfactionStars(3, {
        '満足度（収穫精度）': 5,
        '満足度（収穫速度）': 3,
        '満足度（安全性）': 1,
      }),
      count: 9,
    },
  ];

  for (const item of categories) {
    test(`カテゴリの同値分割: ${item.name} を保存でき、入力した ${String(item.count)} 項目が、手動入力として保持される`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await openEntry(page);

      await fillEntryForm(page, {
        equipment: item.equipment,
        category: item.category,
        observedAt: AT,
        items: item.items,
        ...(item.stars === undefined ? {} : { stars: item.stars }),
      });
      await saveEntry(page);

      await expect(page.getByTestId('entry-result')).toContainText('保存しました');
      await page.goto('/observations?source=MANUAL');
      await expect(page.getByTestId('observation-row')).toHaveCount(item.count);
    });
  }

  test('カテゴリを選ぶと、そのカテゴリの項目だけを表示する（カテゴリを変えると、入力済みの値はクリアされる）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);
    await fillEntryForm(page, { category: 'FAILURE', items: { 故障回数: '3' } });
    const items = mainArea(page).getByTestId('entry-items');
    await expect(items.getByLabel('故障回数')).toHaveValue('3');

    await fillEntryForm(page, { category: 'SAFETY' });

    await expect(items.getByLabel('故障回数')).toHaveCount(0);
    await expect(items.getByLabel('緊急停止回数')).toHaveValue('');
    await expect(items.getByRole('textbox')).toHaveCount(2);

    // カテゴリを戻しても、以前に入力した値は残っていない
    await fillEntryForm(page, { category: 'FAILURE' });
    await expect(items.getByLabel('故障回数')).toHaveValue('');
  });

  test('項目の一部だけを入力して保存できる（入力した項目だけを保持する）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);

    await fillEntryForm(page, {
      equipment: SENSOR_ID,
      category: 'ENVIRONMENT',
      observedAt: AT,
      items: { CO2濃度: '1500' },
    });
    await saveEntry(page);

    await expect(page.getByTestId('entry-result')).toBeVisible();
    await page.goto('/observations');
    await expect(page.getByTestId('observation-row')).toHaveCount(1);
    await expect(page.getByTestId('observation-row')).toContainText('CO2濃度');
  });
});

test.describe('評価の更新と通知（UC-10への連携）: 環境の値の同値分割', () => {
  const partitions: readonly { name: string; temperature: string; status: string }[] = [
    { name: '温度 20℃（正常）', temperature: '20', status: '正常' },
    { name: '温度 10℃（正常の下限。範囲型は下限を含む）', temperature: '10', status: '正常' },
    { name: '温度 9.9℃（注意）', temperature: '9.9', status: '注意' },
    { name: '温度 25℃（正常の上限を超える。注意）', temperature: '25', status: '注意' },
    { name: '温度 35℃（異常の下限）', temperature: '35', status: '異常' },
    { name: '温度 -5℃（異常。負の値も入力できる）', temperature: '-5', status: '異常' },
    { name: '温度 40℃（異常）', temperature: '40', status: '異常' },
  ];

  for (const item of partitions) {
    test(`${item.name}: 環境適応性が${item.status}`, async ({ page, request }) => {
      await prepareApp(request);
      await openEntry(page);

      await fillEntryForm(page, {
        equipment: SENSOR_ID,
        category: 'ENVIRONMENT',
        observedAt: AT,
        items: { 温度: item.temperature, 湿度: '60', 照度: '30000', CO2濃度: '900' },
      });
      await saveEntry(page);

      await expectRelatedStatus(page, 'environmentalAdaptability', item.status);
    });
  }

  test('異常になる値を保存すると、未読の通知が作られる（ハウスとセンサーの単位）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);

    await fillEntryForm(page, {
      equipment: SENSOR_ID,
      category: 'ENVIRONMENT',
      observedAt: AT,
      items: { 温度: '40', 湿度: '60', 照度: '30000', CO2濃度: '900' },
    });
    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toBeVisible();

    await goToMenu(page, '通知');
    const rows = page.getByTestId('notification-row').filter({ hasText: '環境適応性' });
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'ハウス1' })).toContainText('異常');
    await expect(rows.filter({ hasText: '環境センサー1' })).toContainText('異常');
    for (const row of await rows.all()) {
      await expect(row).toHaveAttribute('data-read-state', 'UNREAD');
    }
  });

  test('注意になる値（温度 27℃）を保存すると、未読の通知が作られる。正常になる値（温度 20℃）では作られない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);
    const environment = { equipment: SENSOR_ID, category: 'ENVIRONMENT', observedAt: AT };
    const allItems = { 湿度: '60', 照度: '30000', CO2濃度: '900' };

    // 正常: 通知は作られない
    await fillEntryForm(page, { ...environment, items: { 温度: '20', ...allItems } });
    await saveEntry(page);
    await expectRelatedStatus(page, 'environmentalAdaptability', '正常');
    await goToMenu(page, '通知');
    const rows = page.getByTestId('notification-row').filter({ hasText: '環境適応性' });
    await expect(rows).toHaveCount(0);

    // 注意: ハウスとセンサーの単位で、「注意」の通知が作られる（修正せず、別の計測日時で入力する）
    await goToMenu(page, 'データ入力');
    await fillEntryForm(page, {
      ...environment,
      observedAt: '2026-10-09T11:30',
      items: { 温度: '27', ...allItems },
    });
    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toBeVisible();
    await goToMenu(page, '通知');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'ハウス1' })).toContainText('注意');
    await expect(rows.filter({ hasText: '環境センサー1' })).toContainText('注意');
    for (const row of await rows.all()) {
      await expect(row).toHaveAttribute('data-read-state', 'UNREAD');
    }
  });
});

test.describe('代替フロー: 自動取り込みと手動入力で同じ項目・時刻の値が重なる場合', () => {
  test('同じ設備・項目・計測日時では、手動入力を評価に使い、自動取り込みの値と手動入力の値の両方を保持する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    // 自動取り込みの値（温度 20℃。正常）。1時間前（11:00）
    await seed(request, environmentData({ temperature: 20 }, 1));
    await openEntry(page);

    // 同じ時刻（11:00）に、手動で温度 40℃ を入力する
    await fillEntryForm(page, {
      equipment: SENSOR_ID,
      category: 'ENVIRONMENT',
      observedAt: AT,
      items: { 温度: '40' },
    });
    await saveEntry(page);

    // 手動入力が評価に使われる（異常）
    await expectRelatedStatus(page, 'environmentalAdaptability', '異常');
    // 両方を保持する（取得元で区別できる）
    await page.goto('/observations?q=%E6%B8%A9%E5%BA%A6&from=2026-10-08&to=2026-10-09');
    const rows = page.getByTestId('observation-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: '自動取り込み' })).toContainText('20℃');
    await expect(rows.filter({ hasText: '手動入力' })).toContainText('40℃');
  });

  test('計測日時が異なれば、自動取り込みと手動入力の両方を評価に使う（長期は平均）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    // 自動取り込み: 温度 20℃（3時間前）。手動入力: 温度 30℃（1時間前）→ 長期の平均 25℃ は、範囲型の「注意」
    await seed(request, environmentData({ temperature: 20 }, 3));
    await openEntry(page);

    await fillEntryForm(page, {
      equipment: SENSOR_ID,
      category: 'ENVIRONMENT',
      observedAt: AT,
      items: { 温度: '30' },
    });
    await saveEntry(page);

    await expectRelatedStatus(page, 'environmentalAdaptability', '注意');
    await page.goto(`/viewpoints/environmentalAdaptability?equipmentId=${SENSOR_ID}`);
    await expect(page.getByTestId('metric-temperatureCelsius').locator('td').first()).toHaveText(
      '25.0℃',
    );
  });
});

test.describe('代替フロー: 入力内容が不正な場合は、エラーを表示する（環境・満足度の値の境界値）', () => {
  async function submit(page: Page, values: EntryFormValues): Promise<void> {
    await fillEntryForm(page, { observedAt: AT, ...values });
    await saveEntry(page);
  }

  const humidity: readonly { name: string; value: string; ok: boolean }[] = [
    { name: '湿度 -0.1%（下限の外）', value: '-0.1', ok: false },
    { name: '湿度 0%（下限）', value: '0', ok: true },
    { name: '湿度 100%（上限）', value: '100', ok: true },
    { name: '湿度 100.1%（上限の外）', value: '100.1', ok: false },
  ];

  for (const item of humidity) {
    test(`${item.name}は${item.ok ? '保存できる' : 'エラーになる（0以上100以下の数値）'}`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await openEntry(page);

      await submit(page, {
        equipment: SENSOR_ID,
        category: 'ENVIRONMENT',
        items: { 湿度: item.value },
      });

      if (item.ok) {
        await expect(page.getByTestId('entry-result')).toBeVisible();
      } else {
        await expect(fieldError(page, 'items.humidityPercent')).toHaveText(
          '湿度は0以上100以下の数値で指定してください',
        );
        await expect(page.getByTestId('entry-result')).toHaveCount(0);
      }
    });
  }

  // 温度・照度・CO2 濃度の範囲（D-10。データとして許容する範囲。範囲外は保存できない）
  const environmentRanges: readonly {
    name: string;
    label: string;
    key: string;
    value: string;
    ok: boolean;
    message: string;
  }[] = [
    {
      name: '温度 -50.1℃（下限の外）',
      label: '温度',
      key: 'temperatureCelsius',
      value: '-50.1',
      ok: false,
      message: '温度は-50以上100以下の数値で指定してください',
    },
    {
      name: '温度 -50℃（下限）',
      label: '温度',
      key: 'temperatureCelsius',
      value: '-50',
      ok: true,
      message: '',
    },
    {
      name: '温度 100℃（上限）',
      label: '温度',
      key: 'temperatureCelsius',
      value: '100',
      ok: true,
      message: '',
    },
    {
      name: '温度 100.1℃（上限の外）',
      label: '温度',
      key: 'temperatureCelsius',
      value: '100.1',
      ok: false,
      message: '温度は-50以上100以下の数値で指定してください',
    },
    {
      name: '照度 200000 lx（上限）',
      label: '照度',
      key: 'illuminanceLux',
      value: '200000',
      ok: true,
      message: '',
    },
    {
      name: '照度 200001 lx（上限の外）',
      label: '照度',
      key: 'illuminanceLux',
      value: '200001',
      ok: false,
      message: '照度は0以上200000以下の数値で指定してください',
    },
    {
      name: 'CO2濃度 10000 ppm（上限）',
      label: 'CO2濃度',
      key: 'co2Ppm',
      value: '10000',
      ok: true,
      message: '',
    },
    {
      name: 'CO2濃度 10001 ppm（上限の外）',
      label: 'CO2濃度',
      key: 'co2Ppm',
      value: '10001',
      ok: false,
      message: 'CO2濃度は0以上10000以下の数値で指定してください',
    },
  ];

  for (const item of environmentRanges) {
    test(`${item.name}は${item.ok ? '保存できる' : 'エラーになる（範囲を示す）'}`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await openEntry(page);

      await submit(page, {
        equipment: SENSOR_ID,
        category: 'ENVIRONMENT',
        items: { [item.label]: item.value },
      });

      if (item.ok) {
        await expect(page.getByTestId('entry-result')).toBeVisible();
      } else {
        await expect(fieldError(page, `items.${item.key}`)).toHaveText(item.message);
        await expect(page.getByTestId('entry-result')).toHaveCount(0);
      }
    });
  }

  // 自動取り込みの項目は、すべて、手動でも入力できる（予備の入口。#192。ADR-0016 の D-10）
  const itemInput = (page: Page, key: string) =>
    mainArea(page).locator(`[data-field="items.${key}"] input`);

  test('稼働情報（稼働時間・待機時間・収穫稼働時間・走行停止時間）を、ロボットに、手動で入力して保存できる。手動入力として保持する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);

    await fillEntryForm(page, { equipment: ROBOT_ID, category: 'OPERATION', observedAt: AT });
    await expect(mainArea(page).getByTestId('entry-items').getByRole('textbox')).toHaveCount(4);
    await itemInput(page, 'operatingHours').fill('5.5');
    await itemInput(page, 'standbyHours').fill('1');
    await itemInput(page, 'harvestOperatingHours').fill('4');
    await itemInput(page, 'travelStoppedHours').fill('0.5');
    await saveEntry(page);

    await expect(page.getByTestId('entry-result')).toContainText('保存しました');
    await goToMenu(page, '取り込み済みデータ');
    const rows = page.getByTestId('observation-row');
    await expect(rows).toHaveCount(4);
    for (const row of await rows.all()) {
      await expect(row).toContainText('手動入力');
      await expect(row).toContainText('収穫ロボット1');
    }
    await expect(rows.filter({ hasText: '待機時間' })).toContainText('1');
  });

  test('ステータスコードを、登録済みのコードから選んで、ロボットに、手動で入力できる。保存すると、手動入力として保持し、入力済みデータの一覧に、コードを示す', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);

    await fillEntryForm(page, { equipment: ROBOT_ID, category: 'STATUS', observedAt: AT });
    const select = mainArea(page).locator('[data-field="items.statusCode"] select');
    // 登録済み（削除していない）のコードを、名称（コード）で選ぶ
    await expect(select.locator('option')).toContainText([
      '選択してください',
      '走行異常（RUNNING_ERROR）',
    ]);
    await select.selectOption('RUNNING_ERROR');
    await saveEntry(page);

    await expect(page.getByTestId('entry-result')).toContainText('保存しました');
    await goToMenu(page, '取り込み済みデータ');
    const rows = page.getByTestId('observation-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('手動入力');
    await expect(rows.first()).toContainText('ステータスコード');
    await expect(rows.first()).toContainText('走行異常');
  });

  test('ステータスコードを選ばずに保存すると、エラーになる（保存しない）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);

    await fillEntryForm(page, { equipment: ROBOT_ID, category: 'STATUS', observedAt: AT });
    await saveEntry(page);

    await expect(page.getByTestId('entry-result')).toHaveCount(0);
    await expect(mainArea(page).getByText('1つ以上の項目を入力してください')).toBeVisible();
  });

  const harvestValues: readonly {
    name: string;
    key: string;
    value: string;
    ok: boolean;
    message: string;
  }[] = [
    { name: '収穫数 120 個', key: 'harvestCount', value: '120', ok: true, message: '' },
    {
      name: '収穫数 1.5 個（整数でない）',
      key: 'harvestCount',
      value: '1.5',
      ok: false,
      message: '収穫数は0以上の整数で指定してください',
    },
    {
      name: '1 果実あたりの収穫時間 300 秒（手動入力の上限）',
      key: 'harvestSecondsPerFruit',
      value: '300',
      ok: true,
      message: '',
    },
    {
      name: '1 果実あたりの収穫時間 300.1 秒（手動入力の上限の外）',
      key: 'harvestSecondsPerFruit',
      value: '300.1',
      ok: false,
      message: '1果実あたりの収穫時間は0以上300以下の数値で指定してください',
    },
  ];

  for (const item of harvestValues) {
    test(`収穫情報の ${item.name}は${item.ok ? '保存できる' : 'エラーになる（範囲を示す）'}`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await openEntry(page);

      await fillEntryForm(page, { equipment: ROBOT_ID, category: 'HARVEST', observedAt: AT });
      await itemInput(page, item.key).fill(item.value);
      await saveEntry(page);

      if (item.ok) {
        await expect(page.getByTestId('entry-result')).toBeVisible();
      } else {
        await expect(fieldError(page, `items.${item.key}`)).toHaveText(item.message);
        await expect(page.getByTestId('entry-result')).toHaveCount(0);
      }
    });
  }

  // 満足度は、スターで選ぶ（1〜5 以外は、画面では選べない）。範囲外・整数でない値は、API が拒否する（D-18）
  for (const value of [1, 2, 3, 4, 5]) {
    test(`満足度 ${String(value)}（スター）は保存できる（1〜5の整数。他の8観点は 3）`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await openEntry(page);

      await fillEntryForm(page, {
        equipment: HOUSE_ID,
        category: 'SATISFACTION',
        observedAt: AT,
        stars: allSatisfactionStars(3, { '満足度（収穫精度）': value }),
      });
      await saveEntry(page);

      await expect(page.getByTestId('entry-result')).toBeVisible();
      await page.goto('/data-entry/list');
      await expect(page.getByTestId('entry-row')).toContainText(
        `満足度（収穫精度）: ${String(value)}スター`,
      );
    });
  }

  test('満足度のスターは、各観点に 5 つ（1〜5）だけ。数値の文字入力はなく、範囲外の値は選べない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);

    await fillEntryForm(page, { equipment: HOUSE_ID, category: 'SATISFACTION' });

    const items = mainArea(page).getByTestId('entry-items');
    await expect(items.getByRole('radiogroup')).toHaveCount(9);
    await expect(items.getByRole('textbox')).toHaveCount(0);
    for (const label of SATISFACTION_LABELS) {
      await expect(starGroup(mainArea(page), label).getByRole('radio')).toHaveCount(5);
    }
  });

  const invalidStars: readonly { name: string; value: unknown }[] = [
    { name: '0（下限未満）', value: 0 },
    { name: '6（上限超過）', value: 6 },
    { name: '3.5（整数でない）', value: 3.5 },
    { name: '文字（数値でない）', value: '四' },
  ];

  for (const item of invalidStars) {
    test(`満足度 ${item.name} は、API が拒否する（400）。何も保存しない`, async ({ request }) => {
      await prepareApp(request);

      const response = await api(request, 'POST', '/manual-entries', {
        equipmentId: HOUSE_ID,
        category: 'SATISFACTION',
        observedAt: '2026-10-09T02:00:00.000Z',
        items: { ...satisfactionApiItems(3), 'satisfaction.harvestAccuracy': item.value },
      });

      expect(response.status()).toBe(400);
      const list = (await (await api(request, 'GET', '/manual-entries')).json()) as {
        items: unknown[];
      };
      expect(list.items).toHaveLength(0);
    });
  }

  test('満足度は、9観点が揃わないと保存できない（API も 400）。選んでいない観点ごとにエラーを示し、最初のエラーへフォーカスする', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openEntry(page);
    await fillEntryForm(page, {
      equipment: HOUSE_ID,
      category: 'SATISFACTION',
      observedAt: AT,
      stars: { '満足度（収穫精度）': 5, '満足度（収穫速度）': 4 },
    });

    await saveEntry(page);

    await expect(page.getByTestId('entry-result')).toHaveCount(0);
    // 選んでいない 7 観点のエラー。選んだ 2 観点のエラーは出ない
    await expect(mainArea(page).locator('[data-field^="items."] .field-error')).toHaveCount(7);
    await expect(fieldError(page, 'items.satisfaction.environmentalAdaptability')).toHaveText(
      '満足度（環境適応性）を選択してください',
    );
    await expect(fieldError(page, 'items.satisfaction.harvestAccuracy')).toHaveCount(0);
    await expect(starGroup(mainArea(page), '満足度（環境適応性）')).toBeFocused();
    await shot(page, testInfo, 'uc07-satisfaction-missing');
    // API も、一部の観点だけの入力を拒否する
    const partial = await api(request, 'POST', '/manual-entries', {
      equipmentId: HOUSE_ID,
      category: 'SATISFACTION',
      observedAt: '2026-10-09T02:00:00.000Z',
      items: { 'satisfaction.harvestAccuracy': 5 },
    });
    expect(partial.status()).toBe(400);
    await page.goto('/data-entry/list');
    await expect(page.getByTestId('entry-row')).toHaveCount(0);
  });

  test('満足度のスターは、キーボードだけで選べる（Tab でグループへ、矢印キーでスターを選ぶ）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);
    await fillEntryForm(page, { equipment: HOUSE_ID, category: 'SATISFACTION' });
    const group = starGroup(mainArea(page), '満足度（収穫精度）');

    await group.getByRole('radio').first().focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    await expect(group.getByRole('radio', { name: '3スター' })).toBeChecked();
    await page.keyboard.press('ArrowLeft');
    await expect(group.getByRole('radio', { name: '2スター' })).toBeChecked();
  });

  test('満足度の入力は、スマートフォンの幅（375px）でも、横にはみ出さず、スターを押せる大きさ（44px 以上）で並ぶ', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await page.setViewportSize({ width: 375, height: 667 });
    await openEntry(page);
    await fillEntryForm(page, { equipment: HOUSE_ID, category: 'SATISFACTION' });

    await expectNoHorizontalScroll(page);
    const star = starGroup(mainArea(page), '満足度（収穫精度）').locator('label.star').first();
    const box = await star.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await shot(page, testInfo, 'uc07-satisfaction-375');
  });

  test('照度・CO2濃度は0以上（負の値はエラー）。温度は負の値も入力できる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);

    await submit(page, {
      equipment: SENSOR_ID,
      category: 'ENVIRONMENT',
      items: { 照度: '-1', CO2濃度: '-1', 温度: '-3' },
    });

    await expect(fieldError(page, 'items.illuminanceLux')).toHaveText(
      '照度は0以上200000以下の数値で指定してください',
    );
    await expect(fieldError(page, 'items.co2Ppm')).toBeVisible();
    await expect(fieldError(page, 'items.temperatureCelsius')).toHaveCount(0);
  });

  test('必須項目の欠け: 設備・カテゴリ・計測日時が未入力、項目が空のときは、保存しない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openEntry(page);
    await mainArea(page).getByLabel('対象の設備').selectOption('');
    await mainArea(page).getByLabel('計測日時（日本時間）').fill('');

    await saveEntry(page);

    await expect(fieldError(page, 'equipmentId')).toBeVisible();
    await expect(fieldError(page, 'category')).toBeVisible();
    await expect(fieldError(page, 'observedAt')).toBeVisible();
    await expect(page.getByTestId('entry-result')).toHaveCount(0);
    await shot(page, testInfo, 'uc07-errors');

    // 設備・カテゴリ・計測日時を入力しても、項目が空なら、保存しない
    await fillEntryForm(page, { equipment: SENSOR_ID, category: 'ENVIRONMENT', observedAt: AT });
    await saveEntry(page);
    await expect(fieldError(page, 'items')).toBeVisible();
    await expect(page.getByTestId('entry-result')).toHaveCount(0);
  });

  test('エラーの後、入力を直して、もう一度保存できる', async ({ page, request }) => {
    await prepareApp(request);
    await openEntry(page);
    await submit(page, {
      equipment: SENSOR_ID,
      category: 'ENVIRONMENT',
      items: { 湿度: '120' },
    });
    await expect(fieldError(page, 'items.humidityPercent')).toBeVisible();

    await fillEntryForm(page, { items: { 湿度: '55' } });
    await saveEntry(page);

    await expect(page.getByTestId('entry-result')).toBeVisible();
  });
});

test.describe('権限: 入力する権限のない利用者（閲覧者）は、入力できない', () => {
  test('閲覧者には、入力欄の代わりに、権限がない旨を表示する（サーバー側でも拒否する）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await addUser(request, VIEWER);
    await alignBrowserClock(page);

    await openAs(page, '/data-entry', VIEWER);

    await expect(page.getByTestId('permission-notice')).toHaveText(
      'この操作を行う権限がありません',
    );
    await expect(mainArea(page).getByRole('button', { name: '保存する' })).toHaveCount(0);
    // サーバー側でも拒否する（閲覧者のトークンで、直接 API を呼ぶ）
    const login = await request.post('/api/v1/auth/login', {
      data: { userId: VIEWER.userId, password: VIEWER.password },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const denied = await request.post('/api/v1/manual-entries', {
      headers: { authorization: `Bearer ${accessToken}` },
      data: {
        equipmentId: ROBOT_ID,
        category: 'FAILURE',
        observedAt: hoursAgo(1),
        items: { failureCount: 1 },
      },
    });
    expect(denied.status()).toBe(403);
    expect((await api(request, 'GET', '/manual-entries')).ok()).toBe(true);
  });
});
