/**
 * UC-12 ハウス・ロボット・センサーの構成を管理する（SC-10。FR-2.1〜FR-2.6、NFR-2.4）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、ハウスを登録する
 *               2. 農作業者が、ハウスにロボット・環境センサーを紐づけて登録する
 *               3. システムが、ハウス→ロボット／環境センサーの階層で、構成を保持する
 *               4. 以降のデータ取り込み・表示・連携は、この構成にもとづく
 *   代替フロー  ・構成の変更（追加・変更・削除）も可能とする（削除時の過去データの扱い: 論理削除。データは残り、評価の対象から外れる）
 *               ・同一の識別子を重複して登録しようとした場合は、エラーとする
 *
 * 値の同値分割: 設備の種別（ハウス・ロボット・環境センサー）、設備ID・名称の長さ（空・境界・超過）と文字種、データ上の識別子（なし・あり・重複）、
 * 削除（ロボット・センサー・ハウス（配下ごと）・確認の取り消し）、権限（変更できる・参照のみ）。
 * 関連するユースケース: UC-08・UC-09（構成にもとづく取り込み）、UC-01（表示の対象）、UC-11（連携）、UC-07（入力の対象）、UC-15。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  ROBOT_EXTERNAL_ID,
  SENSOR_EXTERNAL_ID,
  USER_B,
  VIEWER,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  api,
  apiOk,
  confirmDialog,
  goToMenu,
  newUserSession,
  openAs,
  placeFile,
  prepareApp,
  robotJson,
  runJob,
  sensorCsv,
  unreadBadge,
} from './support/app.ts';
import { E2E_USER } from './support/e2e-user.ts';
import { expectRelatedStatus, fillEntryForm, saveEntry } from './support/entry.ts';
import { federationRows, logRows, runNow, testConnection } from './support/ingestion.ts';
import { hoursAgo, seed, shot } from './support/viewpoint-scenarios.ts';
import { locatorOf, rowBy } from './support/pages.ts';

const rows = locatorOf('equipment-row');
const rowOf = rowBy('equipment-row', 'data-equipment-id');
const facilityForm = (page: Page) => page.getByRole('form', { name: 'ハウスを登録' });
const childForm = (page: Page) => page.getByRole('form', { name: 'ロボット・環境センサーを登録' });
const notice = locatorOf('equipment-notice');

async function openEquipment(page: Page, user?: Parameters<typeof openAs>[2]): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/', user);
  await goToMenu(page, '設備');
  await expect(page.getByRole('heading', { name: '設備', level: 1 })).toBeVisible();
}

async function addFacility(page: Page, equipmentId: string, name: string): Promise<void> {
  await facilityForm(page).getByLabel('設備ID').fill(equipmentId);
  await facilityForm(page).getByLabel('名称').fill(name);
  await facilityForm(page).getByRole('button', { name: '登録する' }).click();
}

async function addChild(
  page: Page,
  values: {
    type: 'ROBOT' | 'SENSOR';
    facility: string;
    id: string;
    name: string;
    externalId?: string;
  },
): Promise<void> {
  const form = childForm(page);
  await form.getByLabel('種別').selectOption(values.type);
  await form.getByLabel('親のハウス').selectOption(values.facility);
  await form.getByLabel('設備ID').fill(values.id);
  await form.getByLabel('名称').fill(values.name);
  await form.getByLabel('データ上の識別子').fill(values.externalId ?? '');
  await form.getByRole('button', { name: '登録する' }).click();
}

test.describe('基本フロー: ハウスを登録し、ロボット・環境センサーを紐づけて登録し、階層で保持する', () => {
  test('ハウスを登録 → ロボット・環境センサーを紐づけて登録すると、ハウス → ロボット／センサーの階層で表示する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request, { equipment: false });
    await openEquipment(page);
    await expect(page.getByTestId('equipment-empty')).toHaveText(
      '設備が登録されていません。ハウスを登録してください',
    );

    // 1. ハウスを登録する
    await addFacility(page, 'HOUSE-A', 'Aハウス');
    await expect(notice(page)).toHaveText('登録しました');
    await expect(rows(page)).toHaveCount(1);
    // 2. ロボット・環境センサーを紐づけて登録する
    await addChild(page, {
      type: 'ROBOT',
      facility: 'HOUSE-A',
      id: 'ROBOT-A',
      name: 'A収穫ロボット',
      externalId: 'ROBOT-A-FILE',
    });
    await expect(rowOf(page, 'ROBOT-A')).toBeVisible();
    await addChild(page, {
      type: 'SENSOR',
      facility: 'HOUSE-A',
      id: 'SENSOR-A',
      name: 'A環境センサー',
      externalId: 'SENSOR-A-FILE',
    });

    // 3. 階層で保持する（ハウス → 配下のロボット・センサーの順）
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).nth(0)).toContainText('ハウス');
    await expect(rows(page).nth(0)).toContainText('Aハウス');
    await expect(rows(page).nth(1)).toContainText('ロボット');
    await expect(rows(page).nth(1)).toContainText('ROBOT-A-FILE');
    await expect(rows(page).nth(2)).toContainText('環境センサー');
    await expect(rows(page).nth(1).locator('td').first()).toHaveClass(/tree-child/);
    await shot(page, testInfo, 'uc12-tree');
    // 画面を読み込み直しても、保持されている
    await page.reload();
    await expect(rows(page)).toHaveCount(3);
  });

  test('登録した構成は、ヘッダーの設備の選択に反映され、ダッシュボード・データ入力の対象になる', async ({
    page,
    request,
  }) => {
    await prepareApp(request, { equipment: false });
    await openEquipment(page);
    await addFacility(page, 'HOUSE-A', 'Aハウス');
    await addChild(page, {
      type: 'ROBOT',
      facility: 'HOUSE-A',
      id: 'ROBOT-A',
      name: 'A収穫ロボット',
    });

    const header = page.getByRole('banner').getByLabel('対象の設備');
    await expect(header.locator('option')).toHaveText(['Aハウス', '　A収穫ロボット']);
    await goToMenu(page, 'ダッシュボード');
    await expect(page.locator('.page-meta')).toContainText('対象: Aハウス');
    await expect(page.locator('.viewpoint-card')).toHaveCount(10);
    await header.selectOption('ROBOT-A');
    await expect(page.locator('.viewpoint-card')).toHaveCount(7);
    await goToMenu(page, 'データ入力');
    await expect(page.getByRole('main').getByLabel('対象の設備').locator('option')).toHaveText([
      '選択してください',
      'Aハウス',
      '　A収穫ロボット',
    ]);
  });

  test('以降のデータ取り込み・評価は、登録した構成（データ上の識別子）にもとづく（UC-08・UC-09 への連携）', async ({
    page,
    request,
  }) => {
    await prepareApp(request, { equipment: false });
    await openEquipment(page);
    await addFacility(page, 'HOUSE-A', 'Aハウス');
    await addChild(page, {
      type: 'ROBOT',
      facility: 'HOUSE-A',
      id: 'ROBOT-A',
      name: 'A収穫ロボット',
      externalId: 'ROBOT-A-FILE',
    });
    await expect(rowOf(page, 'ROBOT-A')).toBeVisible();
    await addChild(page, {
      type: 'SENSOR',
      facility: 'HOUSE-A',
      id: 'SENSOR-A',
      name: 'A環境センサー',
      externalId: 'SENSOR-A-FILE',
    });
    // 構成に登録したデータ上の識別子のファイルが、その設備として取り込まれる
    placeFile(
      'robot',
      'a.json',
      robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 7 } }], 'ROBOT-A-FILE'),
    );
    placeFile(
      'environment-sensor',
      'a.csv',
      sensorCsv(
        [{ hoursAgo: 0.5, temperature: 40, humidity: 60, illuminance: 30000, co2: 900 }],
        'SENSOR-A-FILE',
      ),
    );

    await runJob(request, 'JB-01');

    await page.goto('/observations');
    await expect(
      page.getByTestId('observation-row').filter({ hasText: 'A収穫ロボット' }),
    ).toHaveCount(1);
    await expect(
      page.getByTestId('observation-row').filter({ hasText: 'A環境センサー' }),
    ).toHaveCount(4);
    await page.goto('/');
    await expect(
      page.getByTestId('card-environmentalAdaptability').locator('.status-badge'),
    ).toContainText('異常');
  });

  test('複数のハウス・ロボット・センサーを追加できる（構成は、設定だけで拡張できる）', async ({
    page,
    request,
  }) => {
    await prepareApp(request, { equipment: false });
    await openEquipment(page);
    await addFacility(page, 'HOUSE-A', 'Aハウス');
    // 登録の完了（入力欄が空に戻り、一覧に行が出る）を待ってから、次の登録を入力する（遅い環境で、入力が消えるため）
    await expect(rowOf(page, 'HOUSE-A')).toBeVisible();
    await addFacility(page, 'HOUSE-B', 'Bハウス');
    await expect(rowOf(page, 'HOUSE-B')).toBeVisible();
    await addChild(page, {
      type: 'ROBOT',
      facility: 'HOUSE-A',
      id: 'ROBOT-A1',
      name: 'A1ロボット',
    });
    await expect(rowOf(page, 'ROBOT-A1')).toBeVisible();
    await addChild(page, {
      type: 'ROBOT',
      facility: 'HOUSE-A',
      id: 'ROBOT-A2',
      name: 'A2ロボット',
    });
    await expect(rowOf(page, 'ROBOT-A2')).toBeVisible();
    await addChild(page, {
      type: 'SENSOR',
      facility: 'HOUSE-B',
      id: 'SENSOR-B1',
      name: 'B1センサー',
    });

    await expect(rows(page)).toHaveCount(5);
    // 階層の順序: Aハウス → A1・A2 → Bハウス → B1
    await expect(rows(page).nth(0)).toContainText('Aハウス');
    await expect(rows(page).nth(1)).toContainText('A1ロボット');
    await expect(rows(page).nth(2)).toContainText('A2ロボット');
    await expect(rows(page).nth(3)).toContainText('Bハウス');
    await expect(rows(page).nth(4)).toContainText('B1センサー');
  });
});

test.describe('代替フロー: 同一の識別子を重複して登録しようとした場合は、エラーとする', () => {
  test('登録済みの設備IDは、重複としてエラーにする（ハウス・ロボット・センサーのいずれも。種別をまたいでも）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipment(page);

    await addFacility(page, 'HOUSE-01', '重複ハウス');
    await expect(facilityForm(page).locator('[data-field="equipmentId"] .field-error')).toHaveText(
      '同じ設備IDがすでに登録されています',
    );
    await addChild(page, {
      type: 'ROBOT',
      facility: 'HOUSE-01',
      id: 'SENSOR-01',
      name: '重複ロボット',
    });

    await expect(childForm(page).locator('[data-field="equipmentId"] .field-error')).toHaveText(
      '同じ設備IDがすでに登録されています',
    );
    // ロボットの設備ID（ROBOT-01）と、同じ種別（センサー）の中の設備ID（SENSOR-01）も、重複としてエラーにする
    await addChild(page, {
      type: 'ROBOT',
      facility: 'HOUSE-01',
      id: 'ROBOT-01',
      name: '重複ロボット2',
    });
    await expect(childForm(page).locator('[data-field="equipmentId"] .field-error')).toHaveText(
      '同じ設備IDがすでに登録されています',
    );
    await addChild(page, {
      type: 'SENSOR',
      facility: 'HOUSE-01',
      id: 'SENSOR-01',
      name: '重複センサー',
    });
    await expect(childForm(page).locator('[data-field="equipmentId"] .field-error')).toHaveText(
      '同じ設備IDがすでに登録されています',
    );
    await expect(rows(page)).toHaveCount(3);
  });

  test('削除済みの設備と同じ設備IDも、重複としてエラーにする（過去のデータの取り違えを防ぐ）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipment(page);
    await rowOf(page, 'SENSOR-01').getByRole('button', { name: '削除' }).click();
    await confirmDialog(page, '削除');
    await expect(rowOf(page, 'SENSOR-01')).toHaveCount(0);

    await addChild(page, { type: 'SENSOR', facility: 'HOUSE-01', id: 'SENSOR-01', name: '再登録' });

    await expect(childForm(page).locator('[data-field="equipmentId"] .field-error')).toHaveText(
      '同じ設備IDがすでに登録されています',
    );
  });

  test('データ上の識別子は、同じ種別の設備の中で、重複を登録できない（ロボットとセンサーは、別の種別）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipment(page);

    await addChild(page, {
      type: 'ROBOT',
      facility: 'HOUSE-01',
      id: 'ROBOT-02',
      name: '2台目',
      externalId: 'ROBOT-SAMPLE-01',
    });
    await expect(childForm(page).locator('[data-field="externalId"] .field-error')).toHaveText(
      '同じデータ上の識別子がすでに登録されています',
    );
    await addChild(page, {
      type: 'SENSOR',
      facility: 'HOUSE-01',
      id: 'SENSOR-02',
      name: '2個目',
      externalId: 'ROBOT-SAMPLE-01',
    });

    await expect(notice(page)).toHaveText('登録しました');
  });
});

test.describe('入力の検証（設備ID・名称・親のハウス）', () => {
  const invalidIds: readonly { name: string; id: string; message: string }[] = [
    { name: '空', id: '', message: '設備IDは必須です' },
    {
      name: '空白を含む',
      id: 'HOUSE A',
      message: '英数字・ハイフン・アンダースコアのみ使えます（先頭は英数字）',
    },
    {
      name: '先頭が記号',
      id: '-HOUSE',
      message: '英数字・ハイフン・アンダースコアのみ使えます（先頭は英数字）',
    },
    {
      name: '日本語',
      id: 'ハウス',
      message: '英数字・ハイフン・アンダースコアのみ使えます（先頭は英数字）',
    },
    {
      name: '101文字（境界の外）',
      id: `H${'a'.repeat(100)}`,
      message: '設備IDは100文字以内で指定してください',
    },
  ];

  for (const item of invalidIds) {
    test(`設備IDが${item.name}: エラーを表示し、登録しない`, async ({ page, request }) => {
      await prepareApp(request, { equipment: false });
      await openEquipment(page);

      await addFacility(page, item.id, 'ハウス');

      await expect(
        facilityForm(page).locator('[data-field="equipmentId"] .field-error'),
      ).toHaveText(item.message);
      await expect(rows(page)).toHaveCount(0);
    });
  }

  test('設備IDが100文字（境界）なら、登録できる', async ({ page, request }) => {
    await prepareApp(request, { equipment: false });
    await openEquipment(page);

    await addFacility(page, `H${'a'.repeat(99)}`, 'ハウス');

    await expect(notice(page)).toHaveText('登録しました');
  });

  const invalidNames: readonly { name: string; value: string }[] = [
    { name: '空', value: '' },
    { name: '空白のみ', value: '   ' },
    { name: '201文字（境界の外）', value: 'あ'.repeat(201) },
  ];

  for (const item of invalidNames) {
    test(`名称が${item.name}: エラーを表示し、登録しない`, async ({ page, request }) => {
      await prepareApp(request, { equipment: false });
      await openEquipment(page);

      await addFacility(page, 'HOUSE-A', item.value);

      await expect(facilityForm(page).locator('[data-field="name"] .field-error')).toBeVisible();
      await expect(rows(page)).toHaveCount(0);
    });
  }

  test('名称が200文字（境界）なら、登録できる', async ({ page, request }) => {
    await prepareApp(request, { equipment: false });
    await openEquipment(page);

    await addFacility(page, 'HOUSE-A', 'あ'.repeat(200));

    await expect(notice(page)).toHaveText('登録しました');
  });

  test('ロボット・センサーは、親のハウスが必須（ハウスを選ばないと、登録できない）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipment(page);
    const form = childForm(page);
    await form.getByLabel('設備ID').fill('ROBOT-02');
    await form.getByLabel('名称').fill('2台目');

    await form.getByRole('button', { name: '登録する' }).click();

    await expect(form.locator('[data-field="facilityId"] .field-error')).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
  });

  test('エラーを直して、もう一度登録できる', async ({ page, request }, testInfo) => {
    await prepareApp(request, { equipment: false });
    await openEquipment(page);
    await addFacility(page, 'HOUSE A', 'Aハウス');
    await expect(
      facilityForm(page).locator('[data-field="equipmentId"] .field-error'),
    ).toBeVisible();
    await shot(page, testInfo, 'uc12-validation');

    await addFacility(page, 'HOUSE-A', 'Aハウス');

    await expect(notice(page)).toHaveText('登録しました');
    await expect(facilityForm(page).locator('.field-error')).toHaveCount(0);
  });
});

test.describe('代替フロー: 構成の変更（修正・削除）', () => {
  test('名称・データ上の識別子を修正できる。設備IDと種別は、変更できない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openEquipment(page);

    await rowOf(page, 'ROBOT-01').getByRole('button', { name: '修正' }).click();
    const edit = page.getByTestId('equipment-edit');
    await expect(edit).toContainText('ロボット（ROBOT-01）を修正');
    await expect(edit.getByLabel('設備ID')).toHaveCount(0);
    await expect(edit.getByLabel('種別')).toHaveCount(0);
    await shot(page, testInfo, 'uc12-edit');
    await edit.getByLabel('名称').fill('改名したロボット');
    await edit.getByLabel('データ上の識別子').fill('ROBOT-FILE-9');
    await edit.getByRole('button', { name: '保存' }).click();

    await expect(notice(page)).toHaveText('修正しました');
    await expect(rowOf(page, 'ROBOT-01')).toContainText('改名したロボット');
    await expect(rowOf(page, 'ROBOT-01')).toContainText('ROBOT-FILE-9');
    await expect(page.getByTestId('equipment-edit')).toHaveCount(0);
    // ヘッダーの設備の選択にも反映される
    await expect(page.getByRole('banner').getByLabel('対象の設備')).toContainText(
      '改名したロボット',
    );
  });

  test('ロボットを別のハウスへ移せる（親のハウスの変更）', async ({ page, request }) => {
    await prepareApp(request);
    await openEquipment(page);
    await addFacility(page, 'HOUSE-B', 'Bハウス');
    await expect(notice(page)).toHaveText('登録しました');

    await rowOf(page, 'ROBOT-01').getByRole('button', { name: '修正' }).click();
    const edit = page.getByTestId('equipment-edit');
    await edit.getByLabel('親のハウス').selectOption('HOUSE-B');
    await edit.getByRole('button', { name: '保存' }).click();

    await expect(notice(page)).toHaveText('修正しました');
    // 階層: ハウス1 の直下にセンサー、Bハウス の直下にロボット（ハウスの並びは、登録の順）
    const order = await rows(page).evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-equipment-id')),
    );
    expect(order).toHaveLength(4);
    expect(order.indexOf('SENSOR-01')).toBe(order.indexOf('HOUSE-01') + 1);
    expect(order.indexOf('ROBOT-01')).toBe(order.indexOf('HOUSE-B') + 1);
  });

  test('修正の入力が不正なら（名称が空）、エラーを表示する。キャンセルで、修正をやめられる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipment(page);
    await rowOf(page, 'HOUSE-01').getByRole('button', { name: '修正' }).click();
    const edit = page.getByTestId('equipment-edit');
    await edit.getByLabel('名称').fill('');

    await edit.getByRole('button', { name: '保存' }).click();
    await expect(edit.locator('[data-field="name"] .field-error')).toBeVisible();
    await edit.getByRole('button', { name: 'キャンセル' }).click();

    await expect(page.getByTestId('equipment-edit')).toHaveCount(0);
    await expect(rowOf(page, 'HOUSE-01')).toContainText('ハウス1');
  });

  test('ロボットを削除すると（確認を求める。論理削除）、一覧・ヘッダーから外れ、評価の対象から外れる。過去のデータは残る', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await seed(request, {
      observations: [
        { equipmentId: 'ROBOT-01', itemKey: 'harvestCount', value: 5, observedAt: hoursAgo(1) },
      ],
    });
    await openEquipment(page);

    await rowOf(page, 'ROBOT-01').getByRole('button', { name: '削除' }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('設備を削除しますか');
    await expect(page.getByTestId('confirm-dialog')).toContainText('過去のデータは残ります');
    await shot(page, testInfo, 'uc12-confirm');
    await confirmDialog(page, '削除');

    await expect(notice(page)).toHaveText('削除しました');
    await expect(rowOf(page, 'ROBOT-01')).toHaveCount(0);
    await expect(page.getByRole('banner').getByLabel('対象の設備')).not.toContainText(
      '収穫ロボット1',
    );
    // 過去のデータは、残る（取り込み済みデータの一覧に、設備IDで表示される）
    await page.goto('/observations');
    await expect(page.getByTestId('observation-row').filter({ hasText: 'ROBOT-01' })).toHaveCount(
      1,
    );
    // 削除した設備のダッシュボードは、開けない
    const response = await apiOk<{ facilities: { children: unknown[] }[] }>(
      request,
      'GET',
      '/equipment',
    );
    expect(response.facilities[0]?.children).toHaveLength(1);
    const dashboard = await api(request, 'GET', '/dashboard?equipmentId=ROBOT-01');
    expect(dashboard.status()).toBe(404);
  });

  test('確認でキャンセルすると、削除しない', async ({ page, request }) => {
    await prepareApp(request);
    await openEquipment(page);
    await rowOf(page, 'SENSOR-01').getByRole('button', { name: '削除' }).click();

    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'キャンセル' }).click();

    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    await expect(rowOf(page, 'SENSOR-01')).toHaveCount(1);
  });

  test('キーボードで削除を開くと、確認のキャンセルに、フォーカスの枠（3px の実線）が見える。Esc で閉じ、フォーカスは削除のボタンへ戻る', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openEquipment(page);
    const opener = rowOf(page, 'SENSOR-01').getByRole('button', { name: '削除' });
    await opener.focus();

    await page.keyboard.press('Enter');

    const dialog = page.getByTestId('confirm-dialog');
    const cancel = dialog.getByRole('button', { name: 'キャンセル' });
    await expect(cancel).toBeFocused();
    await expect(cancel).toHaveCSS('outline-style', 'solid');
    await expect(cancel).toHaveCSS('outline-width', '3px');
    await shot(page, testInfo, 'uc12-confirm-keyboard-focus');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(rowOf(page, 'SENSOR-01')).toHaveCount(1);
  });

  test('ハウスを削除すると、配下のロボット・センサーも削除する（確認の文言で、その旨を示す）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipment(page);

    await rowOf(page, 'HOUSE-01').getByRole('button', { name: '削除' }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText(
      '配下のロボット・環境センサーも含めて',
    );
    await confirmDialog(page, '削除');

    await expect(notice(page)).toHaveText('削除しました');
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId('equipment-empty')).toBeVisible();
    // ダッシュボード・データ入力は、設備がない旨を示す
    await goToMenu(page, 'データ入力');
    await expect(page.getByTestId('no-equipment')).toBeVisible();
  });

  test('削除したロボットのデータ上の識別子のファイルは、取り込みの対象から外れる（除外として数え、観測値は増えない）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipment(page);
    await rowOf(page, 'ROBOT-01').getByRole('button', { name: '削除' }).click();
    await confirmDialog(page, '削除');
    await expect(rowOf(page, 'ROBOT-01')).toHaveCount(0);

    placeFile(
      'robot',
      'after-delete.json',
      robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 7 } }]),
    );
    await runJob(request, 'JB-01');

    await goToMenu(page, '取り込み');
    const robotLog = logRows(page).filter({ hasText: 'ロボット' }).first();
    await expect(robotLog.locator('td').nth(3)).toHaveText('1'); // 処理したファイル
    await expect(robotLog.locator('td').nth(4)).toHaveText('0'); // 取り込んだ件数
    await expect(robotLog.locator('td').nth(5)).toHaveText('1'); // 除外した件数
    await page.goto('/observations');
    await expect(page.getByTestId('observation-row').filter({ hasText: 'ROBOT-01' })).toHaveCount(
      0,
    );
  });

  test('データ上の識別子を修正すると、新しい識別子のファイルが、その設備として取り込まれ、古い識別子のファイルは対象から外れる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipment(page);
    await rowOf(page, 'ROBOT-01').getByRole('button', { name: '修正' }).click();
    await page.getByTestId('equipment-edit').getByLabel('データ上の識別子').fill('ROBOT-FILE-9');
    await page.getByTestId('equipment-edit').getByRole('button', { name: '保存' }).click();
    await expect(notice(page)).toHaveText('修正しました');

    placeFile(
      'robot',
      'new-id.json',
      robotJson([{ hoursAgo: 0.5, fields: { harvestCount: 7 } }], 'ROBOT-FILE-9'),
    );
    placeFile(
      'robot',
      'old-id.json',
      robotJson([{ hoursAgo: 0.4, fields: { harvestCount: 3 } }], ROBOT_EXTERNAL_ID),
    );
    await runJob(request, 'JB-01');

    await goToMenu(page, '取り込み');
    const robotLog = logRows(page).filter({ hasText: 'ロボット' }).first();
    await expect(robotLog.locator('td').nth(3)).toHaveText('2');
    await expect(robotLog.locator('td').nth(4)).toHaveText('1');
    await expect(robotLog.locator('td').nth(5)).toHaveText('1');
    await page.goto('/observations');
    await expect(
      page.getByTestId('observation-row').filter({ hasText: '収穫ロボット1' }),
    ).toHaveCount(1);
    // 取り込まれたのは、新しい識別子のファイル（収穫数 7）
    await expect(
      page.getByTestId('observation-row').filter({ hasText: '収穫ロボット1' }),
    ).toContainText('7個');
  });
});

test.describe('権限: 設備を変更する権限のない利用者（閲覧者）は、参照のみ', () => {
  test('閲覧者には、登録・修正・削除の操作を表示せず、構成を参照できる。サーバー側でも拒否する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, VIEWER);

    await openEquipment(page, VIEWER);

    await expect(page.getByTestId('permission-notice')).toHaveText(
      '設備を変更する権限がありません。参照のみできます',
    );
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByRole('button', { name: '修正' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '削除' })).toHaveCount(0);
    await expect(facilityForm(page)).toHaveCount(0);
    await shot(page, testInfo, 'uc12-readonly');
    const login = await request.post('/api/v1/auth/login', {
      data: { userId: VIEWER.userId, password: VIEWER.password },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const denied = await request.fetch('/api/v1/equipment/ROBOT-01', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(denied.status()).toBe(403);
  });
});

test.describe('シナリオ: 構成の登録から、取り込み・確認・復旧の記録・連携までの運用の一連（UC-13 → UC-14 → UC-12 → UC-15 → UC-08・09 → UC-01 → UC-10 → UC-05 → UC-02・04 → UC-06 → UC-18 → UC-11・16 → UC-22 → UC-13）', () => {
  test('ログイン → 利用者・構成の登録 → 取り込みの設定 → 取り込み → 状態の確認 → 異常の通知 → 復旧の記録 → 連携 → 別の利用者の既読 → ログアウトまで、続けて行える', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    // 前提: 設備のない状態（ファイルサーバーのモックは空）
    await prepareApp(request, { equipment: false });
    await alignBrowserClock(page);

    // UC-13: ログインする
    await openAs(page, '/');
    await expect(page.getByText(E2E_USER.userName)).toBeVisible();

    // UC-14: 別の利用者（農作業者B）を登録する
    await goToMenu(page, 'ユーザー');
    const userForm = page.getByTestId('user-add');
    await userForm.getByLabel('ユーザーID').fill(USER_B.userId);
    await userForm.getByLabel('ユーザー名').fill(USER_B.userName);
    await userForm.getByLabel('パスワード').fill(USER_B.password);
    await userForm.getByLabel('ロール').selectOption(USER_B.role);
    await userForm.getByRole('button', { name: '登録する' }).click();
    await expect(page.getByTestId('users-notice')).toHaveText('登録しました');
    await expect(page.getByTestId('user-row').filter({ hasText: USER_B.userId })).toBeVisible();

    // UC-12: ハウス・ロボット・環境センサーを登録する（データ上の識別子で、ファイルの内容と対応づける）
    await goToMenu(page, '設備');
    await addFacility(page, 'HOUSE-01', 'ハウス1');
    await expect(notice(page)).toHaveText('登録しました');
    await addChild(page, {
      type: 'ROBOT',
      facility: 'HOUSE-01',
      id: 'ROBOT-01',
      name: '収穫ロボット1',
      externalId: ROBOT_EXTERNAL_ID,
    });
    await expect(rowOf(page, 'ROBOT-01')).toBeVisible();
    await addChild(page, {
      type: 'SENSOR',
      facility: 'HOUSE-01',
      id: 'SENSOR-01',
      name: '環境センサー1',
      externalId: SENSOR_EXTERNAL_ID,
    });
    await expect(rows(page)).toHaveCount(3);
    await shot(page, testInfo, 'uc12-scenario-equipment');

    // UC-15: 取り込みの設定を確認し、接続テストを行う
    await goToMenu(page, '取り込み');
    await expect(page.getByTestId('source-robot')).toBeVisible();
    await expect(await testConnection(page, 'robot')).toContainText('接続');

    // UC-08・UC-09: ファイルサーバーのファイルを、即時取得で取り込む（環境センサーは、異常な温度）
    placeFile(
      'robot',
      'robot.json',
      robotJson([
        {
          hoursAgo: 1,
          fields: { harvestCount: 10, operatingHours: 0.25, statusCode: 'HARVESTING' },
        },
      ]),
    );
    placeFile(
      'environment-sensor',
      'sensor.csv',
      sensorCsv([{ hoursAgo: 0.5, temperature: 40, humidity: 60, illuminance: 30000, co2: 900 }]),
    );
    await expect(await runNow(page, 'robot')).toContainText('取得しました（成功）');
    await expect(await runNow(page, 'environment-sensor')).toContainText('取得しました（成功）');
    await expect(logRows(page)).toHaveCount(2);

    // UC-01: ダッシュボードで、観点の状態を確認する（環境適応性は異常）
    await goToMenu(page, 'ダッシュボード');
    await expect(page.getByTestId('card-environmentalAdaptability')).toContainText('異常');
    await shot(page, testInfo, 'uc12-scenario-dashboard');

    // UC-10・UC-05: 異常の通知（ヘッダーの未読の件数）から、通知の一覧を開く
    await expect(unreadBadge(page)).not.toHaveText('0');
    const unread = Number(await unreadBadge(page).textContent());
    await page.getByRole('link', { name: /未読の通知/ }).click();
    const alert = page
      .getByTestId('notification-row')
      .filter({ hasText: '環境適応性' })
      .filter({ hasText: '環境センサー1' });
    await expect(alert).toContainText('異常');

    // UC-02・UC-04: 通知から観点の詳細を開き、診断と推奨アクションを確認する（開くと、その通知は既読になる）
    await alert.getByRole('link', { name: '詳細を確認' }).click();
    await expect(page.getByRole('heading', { name: '環境適応性', level: 1 })).toBeVisible();
    await expect(page.getByTestId('recommended-action')).toBeVisible();
    await expect(unreadBadge(page)).toHaveText(String(unread - 1));

    // UC-06: 復旧の対応を記録する（ロボットの故障情報）。保存すると、関連する観点のステータスを示す
    await goToMenu(page, 'データ入力');
    await fillEntryForm(page, {
      equipment: 'ROBOT-01',
      category: 'FAILURE',
      observedAt: '2026-10-09T11:30',
      items: { 故障回数: '1', 復旧に要した時間: '30' },
      note: '通信ケーブルを交換した',
    });
    await saveEntry(page);
    await expect(page.getByTestId('entry-result')).toBeVisible();
    // 耐久性: MTBF ＝ 稼働時間 0.25 時間 ÷ 故障 1 回 ＝ 0.25 時間（100 時間未満）→ 異常（robot-health.md）
    await expectRelatedStatus(page, 'durability', '異常');

    // UC-18: 入力済みデータの一覧で、記録を確認し、修正する。変更履歴に、登録・編集が残る
    await page.getByRole('link', { name: '入力済みデータの一覧へ' }).first().click();
    await expect(page.getByTestId('entry-row')).toHaveCount(1);
    await expect(page.getByTestId('entry-row')).toContainText('通信ケーブルを交換した');
    await page.getByRole('button', { name: '修正' }).click();
    await page
      .getByTestId('entry-edit')
      .getByLabel('備考（所感・補足情報）')
      .fill('通信ケーブルとコネクタを交換した');
    await page.getByTestId('entry-edit').getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('entries-notice')).toHaveText('修正しました');
    await page.getByRole('link', { name: '変更履歴を見る' }).click();
    await expect(page.getByTestId('audit-row').filter({ hasText: '手動入力' })).toHaveCount(2);

    // UC-11・UC-16: 連携を実行し、連携の状況（成功・キューの件数）を確認する
    await advanceMinutes(request, 6);
    await runJob(request, 'JB-03');
    await goToMenu(page, '取り込み');
    await page.getByRole('button', { name: '最新の状況を読み込む' }).click();
    await expect(federationRows(page).first().locator('.log-result')).toHaveText('成功');
    await expect(page.getByTestId('queue-HELD')).toContainText('0');
    await shot(page, testInfo, 'uc12-scenario-federation');

    // UC-22: 別の利用者（B）は、同じ通知を、自分の未読として見る（Aが読んだ1件も、Bには未読）。既読にしても、Aの既読は変わらない
    await page.reload();
    await expect(unreadBadge(page)).not.toHaveText('0');
    const unreadForA = Number(await unreadBadge(page).textContent());
    const b = await newUserSession(browser, testInfo, 'user-b');
    await openAs(b.page, '/notifications', USER_B);
    await expect(unreadBadge(b.page)).toHaveText(String(unreadForA + 1));
    await b.page.getByRole('button', { name: 'すべての通知を既読にする' }).click();
    await expect(unreadBadge(b.page)).toHaveText('0');
    await page.reload();
    await expect(unreadBadge(page)).toHaveText(String(unreadForA));
    await b.context.close();

    // UC-13: ログアウトする
    await page.getByRole('button', { name: 'ログアウト' }).click();
    await expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible();
  });
});
