/**
 * UC-06 復旧対応の結果を記録する（SC-06。FR-4.1.2、FR-4.1.3、FR-4.1.5）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、入力画面を開き、対象のハウス・ロボット等を選ぶ
 *               2. 農作業者が、復旧対応を行った回数、復旧作業に要した時間、作業者による評価や所感、運用上の補足情報を入力する
 *               3. システムが、入力内容を検証して保存する
 *               4. システムが、評価を更新し、「注意」「異常」があれば通知につなげる（UC-10）
 *   代替フロー  入力内容が不正な場合（形式、範囲、必須項目の欠け）は、エラーを表示して再入力を促す
 *
 * 値の同値分割: 復旧に要した時間（MTTR = 時間 ÷ 故障回数。4時間・8時間の境界）、故障回数（0・1・複数）、
 * 不正な入力（必須項目の欠け・形式・範囲・備考の長さ・未来の日時・同じ計測日時の重複）。
 * 関連するユースケース: UC-10（保存後の通知）・UC-01/UC-02（評価の反映）・UC-18（入力済みデータ）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  HOUSE_ID,
  ROBOT_ID,
  SENSOR_ID,
  addEntry,
  alignBrowserClock,
  goToMenu,
  openAs,
  prepareApp,
  unreadBadge,
} from './support/app.ts';
import {
  expectRelatedStatus,
  fieldError,
  fillEntryForm,
  mainArea,
  saveEntry,
} from './support/entry.ts';
import { hoursAgo, seed, shot } from './support/viewpoint-scenarios.ts';
import { userIdText } from './support/pages.ts';

/** 復旧の記録が使うステータスコード（ロボットデータから取り込み済みの想定）。 */
async function seedStatusCode(request: Parameters<typeof prepareApp>[0]): Promise<void> {
  await seed(request, {
    observations: [
      { equipmentId: ROBOT_ID, itemKey: 'statusCode', value: 'STANDBY', observedAt: hoursAgo(1) },
    ],
  });
}

async function openEntry(page: Page): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/');
  await goToMenu(page, 'データ入力');
  await expect(page.getByRole('heading', { name: 'データ入力', level: 1 })).toBeVisible();
}

const RECOVERY_AT = '2026-10-09T11:00';

async function recordRecovery(
  page: Page,
  values: { failures: string; minutes: string; note?: string },
): Promise<void> {
  await fillEntryForm(page, {
    equipment: ROBOT_ID,
    category: 'FAILURE',
    observedAt: RECOVERY_AT,
    items: { 故障回数: values.failures, 復旧に要した時間: values.minutes },
    ...(values.note === undefined ? {} : { note: values.note }),
  });
  await saveEntry(page);
}

test.describe('基本フロー: 復旧対応の結果を入力し、保存して、評価に反映する', () => {
  test('故障回数・復旧に要した時間・備考を入力して保存すると、保存の結果と関連観点（メンテナンス性）のステータスを表示し、ダッシュボードの評価に反映される', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seedStatusCode(request);
    await openEntry(page);

    // 1. 入力画面を開き、対象を選ぶ。カテゴリを選ぶと、そのカテゴリの項目だけを表示する
    await fillEntryForm(page, { equipment: ROBOT_ID, category: 'FAILURE' });
    await expect(mainArea(page).getByTestId('entry-items').getByRole('textbox')).toHaveCount(2);
    await expect(mainArea(page).getByTestId('entry-items')).toContainText('故障情報');
    await shot(page, testInfo, 'uc06-form');

    // 2. 復旧対応の回数・時間・所感を入力する → 3. 検証して保存する
    await recordRecovery(page, {
      failures: '1',
      minutes: '90',
      note: '走行モーターの異常を復旧した。ケーブルの接触不良が原因',
    });

    // 4. 保存の結果と、更新後の関連観点のステータス
    const result = page.getByTestId('entry-result');
    await expect(result).toContainText('保存しました');
    await expectRelatedStatus(page, 'maintainability', '正常');
    await shot(page, testInfo, 'uc06-saved');

    // 評価が更新され、ダッシュボードに反映される（MTTR = 90分 ÷ 1回 = 1.50時間）
    await result.getByRole('link', { name: 'ダッシュボードで確認' }).click();
    const maintainability = page.getByTestId('card-maintainability');
    await expect(maintainability.locator('.status-badge')).toContainText('正常');
    await expect(maintainability).toContainText('1.50時間');
  });

  test('保存した記録（対象・回数・復旧に要した時間・所感・入力者）は、入力済みデータの一覧に残る', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seedStatusCode(request);
    await openEntry(page);
    await recordRecovery(page, {
      failures: '2',
      minutes: '150',
      note: '搬送ベルトの張りを調整した。再発したら交換する',
    });
    await expect(page.getByTestId('entry-result')).toContainText('保存しました');

    await page
      .getByTestId('entry-result')
      .getByRole('link', { name: '入力済みデータの一覧へ' })
      .click();

    const rows = page.getByTestId('entry-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('収穫ロボット1');
    await expect(rows.first()).toContainText('故障情報');
    await expect(rows.first()).toContainText('故障回数: 2回');
    await expect(rows.first()).toContainText('復旧に要した時間: 150分');
    await expect(rows.first()).toContainText('搬送ベルトの張りを調整した。再発したら交換する');
    await expect(rows.first()).toContainText(userIdText('e2e-user'));
    await expect(rows.first().locator('time')).toContainText('2026/10/09 11:00');
    await shot(page, testInfo, 'uc06-saved-list');
  });

  test('作業者の評価（満足度の1〜5スター）と所感（備考）も、復旧対応の記録に続けて入力でき、一覧に残る', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seedStatusCode(request);
    await openEntry(page);
    await recordRecovery(page, { failures: '1', minutes: '45', note: '復旧した' });
    await expect(page.getByTestId('entry-result')).toBeVisible();

    await fillEntryForm(page, {
      equipment: HOUSE_ID,
      category: 'SATISFACTION',
      observedAt: RECOVERY_AT,
      items: { '満足度（メンテナンス性）': '4' },
      note: '復旧の手順が分かりやすく、短時間で対応できた',
    });
    await shot(page, testInfo, 'uc06-evaluation-form');
    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toContainText('保存しました');

    await page
      .getByTestId('entry-result')
      .getByRole('link', { name: '入力済みデータの一覧へ' })
      .click();
    const rows = page.getByTestId('entry-row');
    await expect(rows).toHaveCount(2);
    const evaluation = rows.filter({ hasText: '満足度情報' });
    await expect(evaluation).toContainText('満足度（メンテナンス性）: 4スター');
    await expect(evaluation).toContainText('復旧の手順が分かりやすく、短時間で対応できた');
  });

  test('入力後は、入力欄（項目・備考）がクリアされ、続けて入力できる。直前の設備・カテゴリは、そのまま選ばれている', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seedStatusCode(request);
    await openEntry(page);
    await recordRecovery(page, { failures: '1', minutes: '30', note: '1回目' });
    await expect(page.getByTestId('entry-result')).toBeVisible();

    const form = mainArea(page);
    await expect(form.getByTestId('entry-items').getByLabel('故障回数')).toHaveValue('');
    await expect(form.getByLabel('備考（所感・補足情報）')).toHaveValue('');
    await expect(form.getByLabel('対象の設備')).toHaveValue(ROBOT_ID);
    await expect(form.getByLabel('カテゴリ')).toHaveValue('FAILURE');
  });

  test('入力のクリアで、項目・備考を消せる（設備・カテゴリ・計測日時は残る）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);
    await fillEntryForm(page, {
      equipment: ROBOT_ID,
      category: 'FAILURE',
      observedAt: RECOVERY_AT,
      items: { 故障回数: '2' },
      note: 'メモ',
    });

    await mainArea(page).getByRole('button', { name: '入力のクリア' }).click();

    await expect(mainArea(page).getByTestId('entry-items').getByLabel('故障回数')).toHaveValue('');
    await expect(mainArea(page).getByLabel('備考（所感・補足情報）')).toHaveValue('');
    await expect(mainArea(page).getByLabel('計測日時（日本時間）')).toHaveValue(RECOVERY_AT);
    await expect(mainArea(page).getByLabel('対象の設備')).toHaveValue(ROBOT_ID);
    await expect(mainArea(page).getByLabel('カテゴリ')).toHaveValue('FAILURE');
  });

  test('直前に入力した設備・カテゴリを記憶し、画面を開き直したときに選んでおく', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seedStatusCode(request);
    await openEntry(page);
    await recordRecovery(page, { failures: '1', minutes: '30' });
    await expect(page.getByTestId('entry-result')).toBeVisible();

    await page.reload();

    await expect(mainArea(page).getByLabel('対象の設備')).toHaveValue(ROBOT_ID);
    await expect(mainArea(page).getByLabel('カテゴリ')).toHaveValue('FAILURE');
    await expect(mainArea(page).getByTestId('entry-items')).toBeVisible();
  });

  test('計測日時の既定値は、現在の日時（日本時間）', async ({ page, request }) => {
    await prepareApp(request);
    await openEntry(page);

    await expect(mainArea(page).getByLabel('計測日時（日本時間）')).toHaveValue('2026-10-09T12:00');
  });

  test('ハウス・ロボット・センサーのいずれも、対象の設備に選べる（階層で表示）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);

    const options = mainArea(page).getByLabel('対象の設備').locator('option');
    await expect(options).toHaveText([
      '選択してください',
      'ハウス1',
      '　収穫ロボット1',
      '　環境センサー1',
    ]);
    await mainArea(page).getByLabel('対象の設備').selectOption(SENSOR_ID);
    await expect(mainArea(page).getByLabel('対象の設備')).toHaveValue(SENSOR_ID);
  });
});

test.describe('復旧に要した時間（MTTR = 復旧に要した時間 ÷ 故障回数。4時間未満 正常／8時間未満 注意／8時間以上 異常）の同値分割と境界値', () => {
  const partitions: readonly {
    name: string;
    failures: string;
    minutes: string;
    status: string;
    mttr: string;
  }[] = [
    { name: '90分 × 1回（正常）', failures: '1', minutes: '90', status: '正常', mttr: '1.50時間' },
    {
      name: '239分 × 1回（正常の上限）',
      failures: '1',
      minutes: '239',
      status: '正常',
      mttr: '3.98時間',
    },
    {
      name: '240分 × 1回（4時間ちょうど。注意の下限）',
      failures: '1',
      minutes: '240',
      status: '注意',
      mttr: '4.00時間',
    },
    {
      name: '479分 × 1回（注意の上限）',
      failures: '1',
      minutes: '479',
      status: '注意',
      mttr: '7.98時間',
    },
    {
      name: '480分 × 1回（8時間ちょうど。異常の下限）',
      failures: '1',
      minutes: '480',
      status: '異常',
      mttr: '8.00時間',
    },
    {
      name: '600分 × 1回（異常）',
      failures: '1',
      minutes: '600',
      status: '異常',
      mttr: '10.00時間',
    },
    {
      name: '480分 × 2回（1回あたり4時間 → 注意）',
      failures: '2',
      minutes: '480',
      status: '注意',
      mttr: '4.00時間',
    },
    {
      name: '60分 × 0回（故障なし。MTTR は 0 → 正常）',
      failures: '0',
      minutes: '60',
      status: '正常',
      mttr: '0.00時間',
    },
  ];

  for (const item of partitions) {
    test(`${item.name}: メンテナンス性が${item.status}（MTTR ${item.mttr}）`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await seedStatusCode(request);
      await openEntry(page);

      await recordRecovery(page, { failures: item.failures, minutes: item.minutes });

      await expectRelatedStatus(page, 'maintainability', item.status);
      await page.goto('/');
      await expect(page.getByTestId('card-maintainability')).toContainText(item.mttr);
    });
  }
});

test.describe('保存後の通知（UC-10への連携）: 注意・異常があれば通知につなげる', () => {
  test('異常になる記録（MTTR 10時間）を保存すると、未読の通知が作られ、ヘッダーの件数に反映される', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seedStatusCode(request);
    await openEntry(page);
    // 前提のデータで、すでに作られている通知（メンテナンス性以外）の件数
    const unreadBefore = Number(await unreadBadge(page).textContent());

    await recordRecovery(page, { failures: '1', minutes: '600' });
    await expect(page.getByTestId('entry-result')).toBeVisible();

    // 約10秒の更新を待たずに、通知の一覧で確認する（ヘッダーの件数は、通知の画面で更新される）
    await goToMenu(page, '通知');
    // 観点の評価は、ハウス・ロボットの単位で行うため、それぞれの通知が作られる
    const rows = page.getByTestId('notification-row').filter({ hasText: 'メンテナンス性' });
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'ハウス1' })).toContainText('異常');
    await expect(rows.filter({ hasText: '収穫ロボット1' })).toContainText('異常');
    await expect(unreadBadge(page)).toHaveText(String(unreadBefore + 2));
  });

  test('正常になる記録では、メンテナンス性の通知は作られない', async ({ page, request }) => {
    await prepareApp(request);
    await seedStatusCode(request);
    await openEntry(page);

    await recordRecovery(page, { failures: '1', minutes: '30' });
    await expect(page.getByTestId('entry-result')).toBeVisible();

    await goToMenu(page, '通知');
    await expect(
      page.getByTestId('notification-row').filter({ hasText: 'メンテナンス性' }),
    ).toHaveCount(0);
  });
});

test.describe('代替フロー: 入力内容が不正な場合は、エラーを表示して再入力を促す', () => {
  test('必須項目（設備・カテゴリ・計測日時）が未入力なら、項目ごとにエラーを表示し、保存しない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openEntry(page);
    // 設備は、ヘッダーで選んでいる設備が初期値のため、選択を外す
    await mainArea(page).getByLabel('対象の設備').selectOption('');
    await mainArea(page).getByLabel('計測日時（日本時間）').fill('');

    await saveEntry(page);

    await expect(fieldError(page, 'equipmentId')).toHaveText('対象の設備を選択してください');
    await expect(fieldError(page, 'category')).toHaveText('カテゴリを選択してください');
    await expect(fieldError(page, 'observedAt')).toHaveText('計測日時を入力してください');
    await expect(page.getByTestId('entry-result')).toHaveCount(0);
    await shot(page, testInfo, 'uc06-required-errors');
  });

  test('項目の値がひとつもなければ「1つ以上の項目を入力してください」と表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEntry(page);
    await fillEntryForm(page, {
      equipment: ROBOT_ID,
      category: 'FAILURE',
      observedAt: RECOVERY_AT,
    });

    await saveEntry(page);

    await expect(fieldError(page, 'items')).toHaveText('1つ以上の項目を入力してください');
  });

  const invalidValues: readonly {
    name: string;
    failures: string;
    minutes: string;
    field: string;
    message: string;
  }[] = [
    {
      name: '故障回数が小数（1.5）',
      failures: '1.5',
      minutes: '30',
      field: 'items.failureCount',
      message: '故障回数は0以上の整数で指定してください',
    },
    {
      name: '故障回数が負（-1。境界の下）',
      failures: '-1',
      minutes: '30',
      field: 'items.failureCount',
      message: '故障回数は0以上の整数で指定してください',
    },
    {
      name: '故障回数が数値でない（abc）',
      failures: 'abc',
      minutes: '30',
      field: 'items.failureCount',
      message: '故障回数は0以上の整数で指定してください',
    },
    {
      name: '復旧に要した時間が負（-0.1）',
      failures: '1',
      minutes: '-0.1',
      field: 'items.recoveryMinutes',
      message: '復旧に要した時間は0以上の数値で指定してください',
    },
    {
      name: '復旧に要した時間が数値でない（1時間）',
      failures: '1',
      minutes: '1時間',
      field: 'items.recoveryMinutes',
      message: '復旧に要した時間は0以上の数値で指定してください',
    },
  ];

  for (const item of invalidValues) {
    test(`${item.name}: 項目のエラーを表示し、保存しない`, async ({ page, request }) => {
      await prepareApp(request);
      await openEntry(page);

      await recordRecovery(page, { failures: item.failures, minutes: item.minutes });

      await expect(fieldError(page, item.field)).toHaveText(item.message);
      await expect(page.getByTestId('entry-result')).toHaveCount(0);
    });
  }

  test('境界値: 故障回数 0・復旧に要した時間 0 は、保存できる（0 以上）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seedStatusCode(request);
    await openEntry(page);

    await recordRecovery(page, { failures: '0', minutes: '0' });

    await expect(page.getByTestId('entry-result')).toBeVisible();
  });

  test('備考が2000文字なら保存でき、2001文字ならエラーを表示する（境界値）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seedStatusCode(request);
    await openEntry(page);

    await recordRecovery(page, { failures: '1', minutes: '30', note: 'あ'.repeat(2001) });
    await expect(fieldError(page, 'note')).toHaveText('備考は2000文字以内で入力してください');
    await expect(page.getByTestId('entry-result')).toHaveCount(0);

    await mainArea(page).getByLabel('備考（所感・補足情報）').fill('あ'.repeat(2000));
    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toBeVisible();
  });

  test('未来の計測日時（現在から5分を超える）はエラー、現在から5分後は保存できる（境界値）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seedStatusCode(request);
    await openEntry(page);
    const record = async (observedAt: string) => {
      await fillEntryForm(page, {
        equipment: ROBOT_ID,
        category: 'FAILURE',
        observedAt,
        items: { 故障回数: '1', 復旧に要した時間: '30' },
      });
      await saveEntry(page);
    };

    await record('2026-10-09T12:06');
    await expect(fieldError(page, 'observedAt')).toHaveText('計測日時に未来の日時は指定できません');
    await record('2026-10-09T12:05');
    await expect(page.getByTestId('entry-result')).toBeVisible();
  });

  test('エラーを修正して、もう一度保存できる（再入力）', async ({ page, request }) => {
    await prepareApp(request);
    await seedStatusCode(request);
    await openEntry(page);
    await recordRecovery(page, { failures: '1.5', minutes: '30' });
    await expect(fieldError(page, 'items.failureCount')).toBeVisible();

    await mainArea(page).getByTestId('entry-items').getByLabel('故障回数').fill('1');
    await saveEntry(page);

    await expect(fieldError(page, 'items.failureCount')).toHaveCount(0);
    await expect(page.getByTestId('entry-result')).toBeVisible();
  });

  test('同じ設備・項目・計測日時の入力がすでにあれば、サーバーが拒否し、その旨を表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seedStatusCode(request);
    await addEntry(request, {
      category: 'FAILURE',
      observedAt: '2026-10-09T02:00:00.000Z',
      items: { failureCount: 1, recoveryMinutes: 30 },
    });
    await openEntry(page);

    await recordRecovery(page, { failures: '2', minutes: '60' });

    await expect(page.getByRole('alert').first()).toContainText(
      '同じ計測日時の入力がすでにあります',
    );
    await expect(fieldError(page, 'items.failureCount')).toContainText(
      '同じ設備・項目・計測日時の入力がすでにあります',
    );
    await expect(page.getByTestId('entry-result')).toHaveCount(0);
  });

  test('設備が登録されていなければ、入力欄の代わりに、設備の登録への導線を表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request, { equipment: false });
    await alignBrowserClock(page);
    await openAs(page, '/data-entry');

    await expect(page.getByTestId('no-equipment')).toContainText('設備が登録されていません');
    await expect(
      page.getByTestId('no-equipment').getByRole('link', { name: '設備の管理へ' }),
    ).toHaveAttribute('href', '/settings/equipment');
  });
});
