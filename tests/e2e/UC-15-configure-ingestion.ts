/**
 * UC-15 取り込みを設定し、接続テスト・即時取得を行う（SC-11。FR-1.3〜FR-1.5、FR-1.7、NFR-5.4）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、取り込みの設定（接続先、認証情報、取得間隔）を入力する
 *               2. システムが、設定を保存する
 *               3. 農作業者が、接続テストを実行し、結果を確認する
 *               4. 農作業者が、必要に応じて、手動で即時に取得する
 *   代替フロー  接続テストに失敗した場合は、失敗した旨を表示する（内部情報は表示しない。NFR-5.6）。設定の値が不正な場合は、保存しない
 *   事後条件    取り込みの設定が保存されている。以降の自動取り込み（UC-08、UC-09）に使われる
 *
 * 値の同値分割: 取得間隔（5分・15分・30分・1時間・6時間・日次）、接続先の参照名（正常・空・長すぎる・使えない文字・境界の長さ）、
 * 有効／無効、接続テスト（成功・ファイルサーバー停止・取り込み元の場所がない）、即時取得（成功・一部成功・失敗・二重実行）、
 * 権限（設定・実行できる・参照のみ）。
 * 関連するユースケース: UC-08・UC-09（設定が自動取り込みに使われる）、UC-16（実行の記録を確認）、UC-24（失敗の通知）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  VIEWER,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  api,
  apiOk,
  goToMenu,
  openAs,
  placeFixture,
  prepareApp,
  runJob,
  setMock,
  removeSourceDirectory,
} from './support/app.ts';
import {
  SOURCE_NAMES,
  logRows,
  runNow,
  sourceCard,
  testConnection,
  type SourceId,
} from './support/ingestion.ts';
import { shot } from './support/viewpoint-scenarios.ts';

async function openIngestion(page: Page, user?: Parameters<typeof openAs>[2]): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/', user);
  await goToMenu(page, '取り込み');
  await expect(page.getByRole('heading', { name: '取り込み設定・状況', level: 1 })).toBeVisible();
}

const refInput = (page: Page, sourceId: SourceId) =>
  sourceCard(page, sourceId).getByLabel('接続先（接続設定の参照名）');
const intervalSelect = (page: Page, sourceId: SourceId) =>
  sourceCard(page, sourceId).getByLabel('取得間隔');
const enabledBox = (page: Page, sourceId: SourceId) =>
  sourceCard(page, sourceId).getByLabel('自動取り込みを有効にする');
const save = (page: Page, sourceId: SourceId) =>
  sourceCard(page, sourceId).getByRole('button', { name: '設定を保存' });
const result = (page: Page, sourceId: SourceId) => page.getByTestId(`result-${sourceId}`);
const fieldError = (page: Page, sourceId: SourceId, name: string) =>
  sourceCard(page, sourceId).locator(`[data-field="${name}"] .field-error`);

test.describe('基本フロー: 取り込み元ごとの設定を入力・保存し、接続テストと即時取得を行う', () => {
  test('取り込み元（ロボットデータ・環境センサーデータ）ごとに、接続先・取得間隔・有効／無効と、解釈に使っている仕様の版・状態を表示する。認証情報は表示しない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openIngestion(page);

    for (const sourceId of ['robot', 'environment-sensor'] as const) {
      const card = sourceCard(page, sourceId);
      await expect(card.getByRole('heading', { name: SOURCE_NAMES[sourceId] })).toBeVisible();
      await expect(refInput(page, sourceId)).toHaveValue('FILE_SERVER_MOCK');
      await expect(intervalSelect(page, sourceId)).toHaveValue('15');
      await expect(enabledBox(page, sourceId)).toBeChecked();
      await expect(card.getByTestId(`last-started-${sourceId}`)).toHaveText('まだ実行していません');
      // 認証情報（パスワード・秘密鍵）を入力・表示する欄はない
      await expect(card.locator('input[type="password"]')).toHaveCount(0);
    }
    await expect(sourceCard(page, 'robot')).toContainText(
      '解釈に使っている仕様: robot-json@0.1.0(PROVISIONAL)（仮決め）',
    );
    await expect(sourceCard(page, 'environment-sensor')).toContainText(
      'environment-sensor-csv@0.1.0(PROVISIONAL)（仮決め）',
    );
    await expect(page.getByText('認証情報は、画面に表示しません')).toBeVisible();
    await shot(page, testInfo, 'uc15-settings');
  });

  test('接続先の参照名・取得間隔・有効／無効を変更して保存すると、設定が保存され、再読み込みしても保持される。もう一方の取り込み元は変わらない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openIngestion(page);

    // 1. 設定を入力する → 2. 保存する
    await refInput(page, 'robot').fill('FILE_SERVER_2');
    await intervalSelect(page, 'robot').selectOption('360');
    await enabledBox(page, 'robot').uncheck();
    await save(page, 'robot').click();

    await expect(result(page, 'robot')).toHaveText('設定を保存しました');
    await page.reload();
    await expect(refInput(page, 'robot')).toHaveValue('FILE_SERVER_2');
    await expect(intervalSelect(page, 'robot')).toHaveValue('360');
    await expect(enabledBox(page, 'robot')).not.toBeChecked();
    await expect(refInput(page, 'environment-sensor')).toHaveValue('FILE_SERVER_MOCK');
    await expect(intervalSelect(page, 'environment-sensor')).toHaveValue('15');
    await expect(enabledBox(page, 'environment-sensor')).toBeChecked();
  });

  test('接続テストに成功すると、「接続できました」を表示する。続けて、即時取得で、取り込む', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    placeFixture('robot', 'robot/robot-sample-001.json');
    await openIngestion(page);

    // 3. 接続テストを実行し、結果を確認する
    const tested = await testConnection(page, 'robot');
    await expect(tested).toHaveText('接続できました');
    await expect(tested).toHaveClass(/form-success/);

    // 4. 手動で即時に取得する
    const ran = await runNow(page, 'robot');
    await expect(ran).toContainText('取得しました（成功）');
    await expect(ran).toContainText('ファイル 1 件、取り込み 14 件、読み取れなかった記録 0 件');
    await expect(sourceCard(page, 'robot').getByTestId('last-success-robot')).not.toHaveText(
      'まだ実行していません',
    );
    await shot(page, testInfo, 'uc15-run');
  });
});

test.describe('取得間隔の同値分割（5分・15分・30分・1時間・6時間・日次）', () => {
  const options: readonly { value: string; label: string }[] = [
    { value: '5', label: '5分' },
    { value: '15', label: '15分' },
    { value: '30', label: '30分' },
    { value: '60', label: '1時間' },
    { value: '360', label: '6時間' },
    { value: '1440', label: '日次' },
  ];

  for (const option of options) {
    test(`取得間隔「${option.label}」を選んで保存でき、再読み込みしても保持される`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await openIngestion(page);
      await expect(intervalSelect(page, 'environment-sensor').locator('option')).toHaveText([
        '5分',
        '15分',
        '30分',
        '1時間',
        '6時間',
        '日次',
      ]);

      await intervalSelect(page, 'environment-sensor').selectOption(option.value);
      await save(page, 'environment-sensor').click();

      await expect(result(page, 'environment-sensor')).toHaveText('設定を保存しました');
      await page.reload();
      await expect(intervalSelect(page, 'environment-sensor')).toHaveValue(option.value);
    });
  }
});

test.describe('代替フロー: 設定の値が不正な場合は、保存しない', () => {
  const invalid: readonly { name: string; value: string; message: string }[] = [
    { name: '空', value: '', message: '接続先の参照名を入力してください' },
    { name: '半角の空白のみ', value: '   ', message: '接続先の参照名を入力してください' },
    {
      name: '101文字（境界の外）',
      value: 'A'.repeat(101),
      message: '接続先の参照名は100文字以内で指定してください',
    },
    {
      name: '使えない文字（空白を含む）',
      value: 'FILE SERVER',
      message: '接続先の参照名は英数字・記号（_ . -）のみ使えます',
    },
    {
      name: '使えない文字（!）',
      value: 'FILE!',
      message: '接続先の参照名は英数字・記号（_ . -）のみ使えます',
    },
    {
      name: '先頭が記号',
      value: '_FILE',
      message: '接続先の参照名は英数字・記号（_ . -）のみ使えます',
    },
    {
      name: '日本語',
      value: 'ファイル',
      message: '接続先の参照名は英数字・記号（_ . -）のみ使えます',
    },
  ];

  for (const item of invalid) {
    test(`接続先の参照名が${item.name}: 項目のエラーを表示し、保存しない`, async ({
      page,
      request,
    }) => {
      await prepareApp(request);
      await openIngestion(page);

      await refInput(page, 'robot').fill(item.value);
      await save(page, 'robot').click();

      await expect(fieldError(page, 'robot', 'connectionRef')).toHaveText(item.message);
      await expect(result(page, 'robot')).toHaveCount(0);
      await page.reload();
      await expect(refInput(page, 'robot')).toHaveValue('FILE_SERVER_MOCK');
    });
  }

  const valid: readonly { name: string; value: string }[] = [
    { name: '1文字（A）', value: 'A' },
    { name: '100文字（境界）', value: `A${'b'.repeat(99)}` },
    { name: '記号を含む（file_server-1.prod）', value: 'file_server-1.prod' },
  ];

  for (const item of valid) {
    test(`接続先の参照名が${item.name}: 保存できる`, async ({ page, request }) => {
      await prepareApp(request);
      await openIngestion(page);

      await refInput(page, 'robot').fill(item.value);
      await save(page, 'robot').click();

      await expect(result(page, 'robot')).toHaveText('設定を保存しました');
      await page.reload();
      await expect(refInput(page, 'robot')).toHaveValue(item.value);
    });
  }

  test('エラーを直して、もう一度保存できる', async ({ page, request }, testInfo) => {
    await prepareApp(request);
    await openIngestion(page);
    await refInput(page, 'robot').fill('bad ref');
    await save(page, 'robot').click();
    await expect(fieldError(page, 'robot', 'connectionRef')).toBeVisible();
    await shot(page, testInfo, 'uc15-invalid');

    await refInput(page, 'robot').fill('good-ref');
    await save(page, 'robot').click();

    await expect(fieldError(page, 'robot', 'connectionRef')).toHaveCount(0);
    await expect(result(page, 'robot')).toHaveText('設定を保存しました');
  });
});

test.describe('代替フロー: 接続テストに失敗した場合は、失敗した旨を表示する（内部情報は表示しない）', () => {
  test('ファイルサーバーが停止していると、失敗した旨と、確認の案内を表示し、パスなどの内部情報を含めない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    placeFixture('robot', 'robot/robot-sample-001.json');
    await setMock(request, 'file-server', 'DOWN');
    await openIngestion(page);

    const tested = await testConnection(page, 'robot');

    await expect(tested).toHaveText(
      '接続できませんでした。接続先と認証情報の設定を確認してください',
    );
    await expect(tested).toHaveClass(/form-error/);
    await expect(tested).not.toContainText('test-result');
    await expect(tested).not.toContainText('e2e-file-server');
    await shot(page, testInfo, 'uc15-test-failed');
  });

  test('取り込み元の場所（ディレクトリ）がなくても、内部情報を含めずに、接続できない旨を表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    removeSourceDirectory('environment-sensor');
    await openIngestion(page);

    const tested = await testConnection(page, 'environment-sensor');

    await expect(tested).toHaveText(
      '接続できませんでした。接続先と認証情報の設定を確認してください',
    );
    await expect(tested).not.toContainText('test-result');
    await expect(tested).not.toContainText('e2e-file-server');
  });

  test('停止が復旧すると、接続テストに成功する', async ({ page, request }) => {
    await prepareApp(request);
    placeFixture('robot', 'robot/robot-sample-001.json');
    await setMock(request, 'file-server', 'DOWN');
    await openIngestion(page);
    await expect(await testConnection(page, 'robot')).toHaveClass(/form-error/);

    await setMock(request, 'file-server', 'UP');
    const tested = await testConnection(page, 'robot');

    await expect(tested).toHaveText('接続できました');
  });
});

test.describe('即時取得（手動で即時に取得する）の同値分割', () => {
  test('正常なファイル: 成功。同じファイルは、もう一度取得しても、取り込まない（ファイル 0 件）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    placeFixture('robot', 'robot/robot-sample-001.json');
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
    placeFixture('robot', 'robot/robot-sample-002-partial.json');
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
    placeFixture('robot', 'robot/robot-sample-003-broken.json');
    await openIngestion(page);

    const ran = await runNow(page, 'robot');

    await expect(ran).toContainText('取得しました（失敗）');
    await expect(ran).toHaveClass(/form-error/);
    await expect(logRows(page).first()).toContainText('失敗');
    await expect(logRows(page).first()).toContainText('1件のファイルを取り込めませんでした');
  });

  test('環境センサー（CSV）も、即時取得できる', async ({ page, request }) => {
    await prepareApp(request);
    placeFixture('environment-sensor', 'environment-sensor/sensor-sample-001.csv');
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
    await setMock(request, 'file-server', 'DOWN');
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
    placeFixture('robot', 'robot/robot-sample-001.json');
    // 遅延を再現するため、時計を実時間で進め、ファイルサーバーの応答を遅らせる
    await apiOk(request, 'PUT', '/dev/clock', { mode: 'RUNNING' });
    await apiOk(request, 'PUT', '/dev/mocks/file-server', { mode: 'SLOW', delayMs: 1500 });
    await openIngestion(page);
    await sourceCard(page, 'robot').getByRole('button', { name: '即時取得' }).click();
    // 実行中は、画面のボタンが使えない。「取得中」の表示は、即時取得のボタンだけに出す
    const running = sourceCard(page, 'robot').getByRole('button', { name: '取得中…' });
    await expect(running).toBeDisabled();
    await expect(
      sourceCard(page, 'robot').getByRole('button', { name: '接続テスト' }),
    ).toBeDisabled();
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
  test('取得間隔を1時間にすると、定期の取り込み（JB-01）は、1時間が過ぎるまで、再び実行しない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openIngestion(page);
    await intervalSelect(page, 'robot').selectOption('60');
    await save(page, 'robot').click();
    await expect(result(page, 'robot')).toHaveText('設定を保存しました');

    await runJob(request, 'JB-01');
    await advanceMinutes(request, 30);
    await runJob(request, 'JB-01');
    await page.getByRole('button', { name: '最新の状況を読み込む' }).click();
    await expect(logRows(page).filter({ hasText: 'ロボットデータ' })).toHaveCount(1);
    await advanceMinutes(request, 31);
    await runJob(request, 'JB-01');

    await page.getByRole('button', { name: '最新の状況を読み込む' }).click();
    await expect(logRows(page).filter({ hasText: 'ロボットデータ' })).toHaveCount(2);
    // 既定の15分のままの環境センサーは、そのたびに取り込む
    await expect(logRows(page).filter({ hasText: '環境センサーデータ' })).toHaveCount(3);
  });

  test('自動取り込みを無効にした取り込み元は、定期の取り込みで実行しない（即時取得は、できる）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openIngestion(page);
    await enabledBox(page, 'robot').uncheck();
    await save(page, 'robot').click();
    await expect(result(page, 'robot')).toHaveText('設定を保存しました');

    await runJob(request, 'JB-01');

    await page.getByRole('button', { name: '最新の状況を読み込む' }).click();
    await expect(logRows(page).filter({ hasText: 'ロボットデータ' })).toHaveCount(0);
    await expect(logRows(page).filter({ hasText: '環境センサーデータ' })).toHaveCount(1);
    placeFixture('robot', 'robot/robot-sample-001.json');
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
    await expect(sourceCard(page, 'robot').getByRole('button', { name: '接続テスト' })).toHaveCount(
      0,
    );
    await expect(sourceCard(page, 'robot').getByRole('button', { name: '即時取得' })).toHaveCount(
      0,
    );
    await expect(refInput(page, 'robot')).toHaveAttribute('readonly', '');
    await expect(intervalSelect(page, 'robot')).toBeDisabled();
    await shot(page, testInfo, 'uc15-readonly');
    const login = await request.post('/api/v1/auth/login', {
      data: { userId: VIEWER.userId, password: VIEWER.password },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const denied = await request.fetch('/api/v1/ingestion/settings', {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}` },
      data: {
        sources: [{ sourceId: 'robot', connectionRef: 'X', intervalMinutes: 5, isEnabled: false }],
      },
    });
    expect(denied.status()).toBe(403);
    // 接続テスト・即時取得も、サーバー側で拒否する
    for (const path of ['/ingestion/robot/test', '/ingestion/robot/run']) {
      const refused = await request.fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(refused.status()).toBe(403);
    }
  });
});
