/**
 * UC-15 取り込みを設定し、接続テスト・即時取得を行う（SC-11。FR-1.3〜FR-1.5、FR-1.7、NFR-5.4）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、取り込みの設定（接続先、認証情報）を入力する（接続・取得間隔は、設備ごとの設定。UC-12・UC-15 のファイルサーバー接続の E2E）
 *               2. システムが、設定を保存する
 *               3. 農作業者が、接続テストを実行し、結果を確認する（SC-11 の設備ごとの表。Issue #367）
 *               4. 農作業者が、必要に応じて、手動で即時に取得する
 *   代替フロー  接続テストに失敗した場合は、失敗した旨を表示する（内部情報は表示しない。NFR-5.6）。設定の値が不正な場合は、保存しない
 *   事後条件    取り込みの設定が保存されている。以降の自動取り込み（UC-08、UC-09）に使われる
 *
 * 値の同値分割: 取り込み元の設定の変更（API。有効／無効だけ。接続は設備ごと〔Issue #367〕のため、接続・接続先の参照名は持たない。
 * 正常・取り込み元が存在しない・重複・有効／無効が真偽値でない・空の一覧・旧項目の接続先の参照名〔無視〕）、
 * 有効／無効、接続テスト（設備ごと。成功・ファイルサーバー停止・接続先が未設定・ファイルのパスなし）、即時取得（成功・一部成功・失敗・二重実行）、
 * 権限（設定・実行できる・参照のみ）。
 * 関連するユースケース: UC-08・UC-09（設定が自動取り込みに使われる）、UC-16（実行の記録を確認）、UC-24（失敗の通知）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  ROBOT_ID,
  SENSOR_ID,
  VIEWER,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  api,
  apiOk,
  goToMenu,
  openAs,
  prepareApp,
  runJob,
  setEquipmentInterval,
} from './support/app.ts';
import { assignFilePath, placeFixture, setFileServerMode } from './support/http-files.ts';
import {
  SOURCE_NAMES,
  equipmentRow,
  logRows,
  runNow,
  sourceCard,
  testEquipmentConnection,
  type SourceId,
} from './support/ingestion.ts';
import { shot } from './support/viewpoint-scenarios.ts';

async function openIngestion(page: Page, user?: Parameters<typeof openAs>[2]): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/', user);
  await goToMenu(page, '取り込み');
  await expect(page.getByRole('heading', { name: '取り込み', level: 1 })).toBeVisible();
}

const enabledBox = (page: Page, sourceId: SourceId) =>
  sourceCard(page, sourceId).getByLabel('自動取り込みを有効にする');
const save = (page: Page, sourceId: SourceId) =>
  sourceCard(page, sourceId).getByRole('button', { name: '設定を保存' });
const result = (page: Page, sourceId: SourceId) => page.getByTestId(`result-${sourceId}`);

test.describe('基本フロー: 取り込み元ごとの設定を入力・保存し、接続テストと即時取得を行う', () => {
  test('取り込み元（ロボットデータ・環境センサーデータ）ごとに、有効／無効・設備ごとの接続と状況の表と、解釈に使っている仕様の版・状態を表示する。接続・認証情報の入力欄はない（設備のダイアログで入力する）', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openIngestion(page);

    await expect(page.getByTestId('ingestion-connection-lead')).toContainText(
      '接続は設備ごとに設定します',
    );
    for (const [sourceId, equipmentId] of [
      ['robot', ROBOT_ID],
      ['environment-sensor', SENSOR_ID],
    ] as const) {
      const card = sourceCard(page, sourceId);
      await expect(card.getByRole('heading', { name: SOURCE_NAMES[sourceId] })).toBeVisible();
      // 取得間隔は、設備ごとの設定（設備管理。#197）。この画面には、入力欄を出さず、案内を示す
      await expect(card.getByLabel('取得間隔')).toHaveCount(0);
      await expect(page.getByTestId(`interval-moved-${sourceId}`)).toHaveText(
        '取得間隔は、設備ごとに、設備管理で設定します',
      );
      await expect(enabledBox(page, sourceId)).toBeChecked();
      await expect(card.getByTestId(`last-started-${sourceId}`)).toHaveText('まだ実行していません');
      // 設備ごとの表: ファイルのパスも接続も、まだない設備
      await expect(equipmentRow(page, equipmentId)).toBeVisible();
      await expect(page.getByTestId(`equipment-nopath-${equipmentId}`)).toBeVisible();
      await expect(page.getByTestId(`equipment-target-${equipmentId}`)).toHaveText('未設定');
      // 接続の入力欄と、認証情報（パスワード・秘密鍵）を入力・表示する欄は、この画面にはない。接続の出どころを示す表示もない（接続は設備ごとだけ）
      await expect(page.getByTestId(`equipment-origin-${equipmentId}`)).toHaveCount(0);
      await expect(page.getByTestId(`shared-connection-notice-${sourceId}`)).toHaveCount(0);
      await expect(card.getByLabel('ホスト名')).toHaveCount(0);
      await expect(card.locator('input[type="password"]')).toHaveCount(0);
    }
    await expect(sourceCard(page, 'robot')).toContainText(
      '解釈に使っている仕様: robot-json@0.2.0(PROVISIONAL)（仮決め）',
    );
    await expect(sourceCard(page, 'environment-sensor')).toContainText(
      'environment-sensor-json@0.1.0(PROVISIONAL)（仮決め）',
    );
    await expect(page.getByText('認証情報は、画面に表示しません')).toBeVisible();
    await shot(page, testInfo, 'uc15-settings');
  });

  test('自動取り込みの有効／無効を変更して保存すると、設定が保存され、再読み込みしても保持される。もう一方の取り込み元は変わらない。外したときの影響を説明する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openIngestion(page);
    await expect(page.getByTestId('enabled-impact-robot')).toContainText(
      '外すと、手動の運用になります',
    );
    await expect(page.getByTestId('enabled-impact-robot')).toContainText(
      'ダッシュボードの「データが古い」の警告も出なくなります',
    );

    // 1. 設定を入力する → 2. 保存する
    await enabledBox(page, 'robot').uncheck();
    await save(page, 'robot').click();

    await expect(result(page, 'robot')).toHaveText('設定を保存しました');
    await page.reload();
    await expect(enabledBox(page, 'robot')).not.toBeChecked();
    await expect(enabledBox(page, 'environment-sensor')).toBeChecked();
  });

  test('接続テストに成功すると、「接続できました」を表示する（設備ごとの表）。続けて、即時取得で、取り込む', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await placeFixture(request, 'robot', 'robot/robot-sample-001.json');
    await openIngestion(page);

    // 3. 接続テストを実行し、結果を確認する
    const tested = await testEquipmentConnection(page, ROBOT_ID);
    await expect(tested).toHaveText('接続できました');
    await expect(tested).toHaveClass(/form-success/);

    // 4. 手動で即時に取得する
    const ran = await runNow(page, 'robot');
    await expect(ran).toContainText('取得しました（成功）');
    await expect(ran).toContainText('ファイル 1 件、取り込み 14 件、読み取れなかった記録 0 件');
    // 設備ごとの表: 最終の実行の結果・最後にデータが取れた日時
    await expect(page.getByTestId(`equipment-result-${ROBOT_ID}`)).toHaveText('成功');
    await expect(page.getByTestId(`equipment-data-${ROBOT_ID}`)).toHaveText('2026/10/09 12:00:00');
    await shot(page, testInfo, 'uc15-run');
  });
});

test.describe('代替フロー: 設定の値が不正な場合は、保存しない（取り込み元の設定は、有効／無効だけ。API で確かめる）', () => {
  /** 取り込み元の設定（有効／無効）。 */
  async function currentSources(
    request: Parameters<typeof prepareApp>[0],
  ): Promise<{ sourceId: string; isEnabled: boolean }[]> {
    const settings = await apiOk<{ sources: { sourceId: string; isEnabled: boolean }[] }>(
      request,
      'GET',
      '/ingestion/settings',
    );
    return settings.sources.map(({ sourceId, isEnabled }) => ({ sourceId, isEnabled }));
  }

  const invalid: readonly {
    name: string;
    sources: unknown;
    field: string;
  }[] = [
    {
      name: '存在しない取り込み元',
      sources: [{ sourceId: 'unknown-source', isEnabled: false }],
      field: 'sources.0.sourceId',
    },
    {
      name: '同じ取り込み元の重複',
      sources: [
        { sourceId: 'robot', isEnabled: false },
        { sourceId: 'robot', isEnabled: true },
      ],
      field: 'sources.1.sourceId',
    },
    {
      name: '有効／無効が真偽値でない',
      sources: [{ sourceId: 'robot', isEnabled: 'false' }],
      field: 'sources.0.isEnabled',
    },
    {
      name: '有効／無効がない',
      sources: [{ sourceId: 'robot' }],
      field: 'sources.0.isEnabled',
    },
    { name: '取り込み元の指定がない（空の一覧）', sources: [], field: 'sources' },
  ];

  for (const item of invalid) {
    test(`${item.name}: 項目のエラーを返し、保存しない`, async ({ request }) => {
      await prepareApp(request);
      const before = await currentSources(request);

      const response = await api(request, 'PUT', '/ingestion/settings', { sources: item.sources });

      expect(response.status()).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; fields: { name: string; message: string }[] };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.fields.map((field) => field.name)).toContain(item.field);
      expect(await currentSources(request)).toEqual(before);
    });
  }

  test('取り込み元の応答には、接続・接続先の参照名の項目がない（接続は、設備ごとの状況に出る）', async ({
    request,
  }) => {
    await prepareApp(request);

    const settings = await apiOk<{ sources: Record<string, unknown>[] }>(
      request,
      'GET',
      '/ingestion/settings',
    );

    expect(settings.sources.length).toBeGreaterThan(0);
    for (const source of settings.sources) {
      expect(source).not.toHaveProperty('connectionRef');
      expect(source).not.toHaveProperty('connection');
      expect(source).not.toHaveProperty('credentials');
    }
  });

  test('旧項目の接続先の参照名を送っても、無視する（有効／無効だけを保存する。応答にも出ない）', async ({
    request,
  }) => {
    await prepareApp(request);

    const saved = await apiOk<{ sources: ({ sourceId: string } & Record<string, unknown>)[] }>(
      request,
      'PUT',
      '/ingestion/settings',
      { sources: [{ sourceId: 'robot', connectionRef: 'dummy-ref', isEnabled: false }] },
    );

    const robot = saved.sources.find((source) => source.sourceId === 'robot');
    expect(robot).toMatchObject({ isEnabled: false });
    expect(robot).not.toHaveProperty('connectionRef');
    expect(await currentSources(request)).toEqual([
      { sourceId: 'robot', isEnabled: false },
      { sourceId: 'environment-sensor', isEnabled: true },
    ]);
  });

  test('画面の「設定を保存」は、有効／無効だけを保存する。もう一方の取り込み元は変わらない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openIngestion(page);

    await enabledBox(page, 'robot').uncheck();
    await save(page, 'robot').click();

    await expect(result(page, 'robot')).toHaveText('設定を保存しました');
    expect(await currentSources(request)).toEqual([
      { sourceId: 'robot', isEnabled: false },
      { sourceId: 'environment-sensor', isEnabled: true },
    ]);
  });
});

test.describe('代替フロー: 接続テストに失敗した場合は、失敗した旨を表示する（内部情報は表示しない）', () => {
  test('ファイルサーバーが停止していると、失敗した旨と、確認の案内を表示し、パスなどの内部情報を含めない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await placeFixture(request, 'robot', 'robot/robot-sample-001.json');
    await setFileServerMode(request, 'DOWN');
    await openIngestion(page);

    const tested = await testEquipmentConnection(page, ROBOT_ID);

    // HTTP の停止は、理由がわかる失敗として、理由が括弧書きで付く
    await expect(tested).toHaveText(
      '接続できませんでした（ファイルサーバーに接続できません）。接続先と認証情報の設定を確認してください',
    );
    await expect(tested).toHaveClass(/form-error/);
    await expect(tested).not.toContainText('127.0.0.1');
    await expect(tested).not.toContainText('/robot/');
    await shot(page, testInfo, 'uc15-test-failed');
  });

  test('接続先が未設定の設備は、接続テストで、設定を促す旨を表示する（内部情報は含めない）。ファイルのパスがない設備は、その旨を表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    // 環境センサーは、ファイルのパスだけを設定する（接続は、設定しない）。ロボットは、何も設定しない
    await assignFilePath(request, SENSOR_ID, '/environment-sensor/unconnected.json');
    await openIngestion(page);

    const unconnected = await testEquipmentConnection(page, SENSOR_ID);

    await expect(unconnected).toHaveText(
      '接続できませんでした（接続先が設定されていません）。接続先と認証情報の設定を確認してください',
    );
    await expect(unconnected).toHaveClass(/form-error/);
    await expect(unconnected).not.toContainText('/environment-sensor/');
    const noPath = await testEquipmentConnection(page, ROBOT_ID);
    await expect(noPath).toContainText('ファイルパスが設定された設備がありません');
    await expect(noPath).toHaveClass(/form-error/);
  });

  test('停止が復旧すると、接続テストに成功する', async ({ page, request }) => {
    await prepareApp(request);
    await placeFixture(request, 'robot', 'robot/robot-sample-001.json');
    await setFileServerMode(request, 'DOWN');
    await openIngestion(page);
    await expect(await testEquipmentConnection(page, ROBOT_ID)).toHaveClass(/form-error/);

    await setFileServerMode(request, 'UP');
    const tested = await testEquipmentConnection(page, ROBOT_ID);

    await expect(tested).toHaveText('接続できました');
  });
});

test.describe('即時取得（手動で即時に取得する）の同値分割', () => {
  test('正常なファイル: 成功。同じファイルは、もう一度取得しても、取り込まない（ファイル 0 件）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await placeFixture(request, 'robot', 'robot/robot-sample-001.json');
    await openIngestion(page);

    const first = await runNow(page, 'robot');
    await expect(first).toContainText('取得しました（成功）');
    await expect(first).toContainText('ファイル 1 件');
    const second = await runNow(page, 'robot');
    await expect(second).toContainText('取得しました（成功）');
    await expect(second).toContainText('ファイル 0 件、取り込み 0 件');
  });

  test('一部の記録が不正なファイル: 一部成功（読み取れなかった記録の数を表示する）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await placeFixture(request, 'robot', 'robot/robot-sample-002-partial.json');
    await openIngestion(page);

    const ran = await runNow(page, 'robot');

    await expect(ran).toContainText('取得しました（一部成功）');
    await expect(ran).not.toContainText('読み取れなかった記録 0 件');
  });

  test('形式が違うファイル（壊れた JSON）: 失敗。失敗の内容を、ログで確認できる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await placeFixture(request, 'robot', 'robot/robot-sample-003-broken.json');
    await openIngestion(page);

    const ran = await runNow(page, 'robot');

    await expect(ran).toContainText('取得しました（失敗）');
    await expect(ran).toHaveClass(/form-error/);
    await expect(logRows(page).first()).toContainText('失敗');
    await expect(logRows(page).first()).toContainText('1件のファイルを取り込めませんでした');
  });

  test('環境センサー（JSON）も、即時取得できる', async ({ page, request }) => {
    await prepareApp(request);
    await placeFixture(request, 'environment-sensor', 'environment-sensor/sensor-sample-001.json');
    await openIngestion(page);

    const ran = await runNow(page, 'environment-sensor');

    // 3行目の温度が空（欠損）のため、一部成功
    await expect(ran).toContainText('取得しました（一部成功）');
    await expect(ran).toContainText('ファイル 1 件、取り込み 11 件、読み取れなかった記録 1 件');
  });

  test('ファイルがない取り込み元でも、即時取得は成功する（ファイル 0 件・取り込み 0 件）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openIngestion(page);

    const ran = await runNow(page, 'robot');

    await expect(ran).toContainText('取得しました（成功）');
    await expect(ran).toContainText('ファイル 0 件、取り込み 0 件');
  });

  test('ファイルサーバーが停止していると、取得できず、失敗を表示し、取り込みのログに記録する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setFileServerMode(request, 'DOWN');
    await openIngestion(page);

    const ran = await runNow(page, 'robot');

    await expect(ran).toContainText('取得しました（失敗）');
    await expect(logRows(page).first()).toContainText('ファイルサーバーに接続できませんでした');
  });

  test('実行中は、二重実行を防ぐ（実行中に、もう一度即時取得を要求すると、競合として拒否する）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await placeFixture(request, 'robot', 'robot/robot-sample-001.json');
    // 遅延を再現するため、時計を実時間で進め、ファイルサーバーの応答を遅らせる
    await apiOk(request, 'PUT', '/dev/clock', { mode: 'RUNNING' });
    await setFileServerMode(request, 'SLOW', 1500);
    await openIngestion(page);
    await sourceCard(page, 'robot').getByRole('button', { name: '即時取得' }).click();
    // 実行中は、画面のボタンが使えない。「取得中」の表示は、即時取得のボタンだけに出す
    const running = sourceCard(page, 'robot').getByRole('button', { name: '取得中…' });
    await expect(running).toBeDisabled();
    await expect(page.getByTestId(`equipment-test-${ROBOT_ID}`)).toBeDisabled();
    await expect(
      sourceCard(page, 'robot').getByRole('button', { name: '設定を保存' }),
    ).toBeDisabled();
    // もう一方の取り込み元は、使える
    await expect(
      sourceCard(page, 'environment-sensor').getByRole('button', { name: '即時取得' }),
    ).toBeEnabled();

    const duplicated = await api(request, 'POST', '/ingestion/robot/run');

    expect(duplicated.status()).toBe(409);
    expect(await duplicated.json()).toMatchObject({
      error: { code: 'CONFLICT', message: '取り込みを実行中です' },
    });
    await expect(result(page, 'robot')).toContainText('取得しました', { timeout: 15_000 });
  });
});

test.describe('設定は、自動取り込み（UC-08・UC-09）に使われる（取得間隔・有効／無効）', () => {
  test('設備の取得間隔を1時間にすると、定期の取り込み（JB-01）は、1時間が過ぎるまで、その設備を再び取り込まない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    // 取得間隔は、設備ごとの設定（#197）。ロボットを 1 時間にする（環境センサーは、既定の 5 分）
    await setEquipmentInterval(request, ROBOT_ID, 60);
    // 定期の取り込みの対象は、ファイルのパスを持つ設備（ADR-0023）。ロボット・環境センサーに、ファイルを置く
    await placeFixture(request, 'robot', 'robot/robot-sample-001.json');
    await placeFixture(request, 'environment-sensor', 'environment-sensor/sensor-sample-001.json');
    await openIngestion(page);

    // 新しいデータがない実行は、取り込みのログに残さない（Issue #201）ため、取り込み元ごとの「最終の実行」で、実行したかを確かめる
    await runJob(request, 'JB-01');
    await advanceMinutes(request, 30);
    await runJob(request, 'JB-01');
    await openIngestion(page);
    // 30 分後: ロボット（1 時間）は、実行しない（最初の実行のまま）。既定（5 分）のままの環境センサーは、実行する
    await expect(page.getByTestId('last-started-robot')).toHaveText('2026/10/09 12:00:00');
    await expect(page.getByTestId('last-started-environment-sensor')).toHaveText(
      '2026/10/09 12:30:00',
    );
    await advanceMinutes(request, 31);
    await runJob(request, 'JB-01');

    await openIngestion(page);
    // 61 分後: ロボットも、実行する
    await expect(page.getByTestId('last-started-robot')).toHaveText('2026/10/09 13:01:00');
    await expect(page.getByTestId('last-started-environment-sensor')).toHaveText(
      '2026/10/09 13:01:00',
    );
  });

  test('自動取り込みを無効にした取り込み元は、定期の取り込みで実行しない（即時取得は、できる）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    // 定期の取り込みの対象は、ファイルのパスを持つ設備（ADR-0023）。環境センサーに、ファイルを置く
    await placeFixture(request, 'environment-sensor', 'environment-sensor/sensor-sample-001.json');
    await openIngestion(page);
    await enabledBox(page, 'robot').uncheck();
    await save(page, 'robot').click();
    await expect(result(page, 'robot')).toHaveText('設定を保存しました');

    await runJob(request, 'JB-01');

    // 無効にした取り込み元は、実行しない。有効な取り込み元は、実行する（環境センサーのファイルを取り込む）
    await openIngestion(page);
    await expect(page.getByTestId('last-started-robot')).toHaveText('まだ実行していません');
    await expect(page.getByTestId('last-started-environment-sensor')).toHaveText(
      '2026/10/09 12:00:00',
    );
    await expect(logRows(page).filter({ hasText: 'ロボットデータ' })).toHaveCount(0);
    await expect(logRows(page).filter({ hasText: '環境センサーデータ' })).toHaveCount(1);
    await placeFixture(request, 'robot', 'robot/robot-sample-001.json');
    await runNow(page, 'robot');
    await expect(logRows(page).filter({ hasText: 'ロボットデータ' })).toHaveCount(1);
  });
});

test.describe('権限: 設定・実行する権限のない利用者（閲覧者）は、参照のみ', () => {
  test('閲覧者には、設定の保存・接続テスト・即時取得の操作を表示せず、入力欄を変更できない。サーバー側でも拒否する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, VIEWER);

    await openIngestion(page, VIEWER);

    await expect(page.getByTestId('permission-notice')).toHaveText(
      '取り込みを設定・実行する権限がありません。参照のみできます',
    );
    await expect(save(page, 'robot')).toHaveCount(0);
    await expect(page.getByTestId(`equipment-test-${ROBOT_ID}`)).toHaveCount(0);
    await expect(sourceCard(page, 'robot').getByRole('button', { name: '即時取得' })).toHaveCount(
      0,
    );
    // 設備のダイアログへのリンクは、設備を変更する権限がある利用者だけ（設備ごとの表は、参照できる）
    await expect(equipmentRow(page, ROBOT_ID)).toBeVisible();
    await expect(page.getByTestId(`equipment-configure-${ROBOT_ID}`)).toHaveCount(0);
    await expect(enabledBox(page, 'robot')).toBeDisabled();
    await shot(page, testInfo, 'uc15-readonly');
    const login = await request.post('/api/v1/auth/login', {
      data: { userId: VIEWER.userId, password: VIEWER.password },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const denied = await request.fetch('/api/v1/ingestion/settings', {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}` },
      data: {
        sources: [{ sourceId: 'robot', isEnabled: false }],
      },
    });
    expect(denied.status()).toBe(403);
    // 即時取得・設備ごとの接続テスト・接続・認証情報の登録も、サーバー側で拒否する
    for (const path of ['/ingestion/robot/run', `/ingestion/equipment/${ROBOT_ID}/test`]) {
      const refused = await request.fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(refused.status()).toBe(403);
    }
    const connection = {
      type: 'HTTP',
      protocol: 'HTTP',
      host: '127.0.0.1',
      port: 8080,
      authMethod: 'NONE',
    };
    for (const attempt of [
      { method: 'PUT', path: `/ingestion/equipment/${ROBOT_ID}/connection`, data: { connection } },
      { method: 'DELETE', path: `/ingestion/equipment/${ROBOT_ID}/connection`, data: undefined },
      {
        method: 'PUT',
        path: `/ingestion/equipment/${ROBOT_ID}/credentials`,
        data: { authMethod: 'BEARER', token: 'dummy-token' },
      },
    ]) {
      const refused = await request.fetch(`/api/v1${attempt.path}`, {
        method: attempt.method,
        headers: { authorization: `Bearer ${accessToken}` },
        ...(attempt.data === undefined ? {} : { data: attempt.data }),
      });
      expect(refused.status()).toBe(403);
    }
  });
});
