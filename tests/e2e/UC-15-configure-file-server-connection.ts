/**
 * UC-15 取り込み元の接続設定（ファイルサーバーの HTTP）を、設備ごとに設定し、接続テスト・取り込みを行う（SC-10 設備のダイアログの「取り込み元の接続」・SC-11。
 * Issue #172・#119・#367。ADR-0022・ADR-0023・ADR-0026。FR-1.3、NFR-5.4）。
 *
 * ユースケースシナリオ（use-cases.md の UC-15 の基本フロー 1〜3）に対応する。
 *   1. 農作業者が、設備（ロボット・環境センサー）のダイアログで、接続先（プロトコル・ホスト・ポート・認証方式）を入力する（取得するファイルのパスも、設備ごと）
 *   2. システムが、設備を保存してから、接続を保存する
 *   3. 農作業者が、その設備だけの接続テストを実行し、結果（成功、または、失敗の理由）を確認する
 *
 * 値の同値分割: 接続（未設定・設備ごと。接続方式の選択はない。HTTP のみ。ADR-0025。取り込み元の共通の接続は、廃止した）、プロトコル（HTTPS・HTTP。HTTP は警告）、ポート（省略・指定・不正）、
 * ホスト（正常・スキームつき）、設備のファイルパス（あり・なし・サーバーにない）、認証方式（なし・認証情報が未設定）、接続テスト（成功・ファイルなし）、
 * 取り込み（設備のファイルを、即時取得で取り込む。Issue #119）、コピー（同じ種別の設備から接続を写す。認証情報は写さない）、「接続を未設定に戻す」（解除。未設定に戻したあとは、取り込みが「接続先が設定されていません」で失敗する）、
 * 登録と同時の保存（設備は登録でき、接続の保存だけが失敗した場合）。
 * 認証情報の登録（Issue #207。D-47）: 認証方式（Basic）を選んで保存したあと、ユーザー名・パスワードを書き込み専用で登録し、
 * 「設定済み」と更新日時を示す。保存後は、値を再表示しない。登録した認証情報で、接続テストが成功する。
 * 内部のアドレスの拒否（SSRF の対策）は、E2E では、手元のサーバーに接続するため許可している（HTTP_FILE_SOURCE_ALLOW_PRIVATE）。
 * 拒否そのものは、単体テスト（address-guard・http-probe）と結合テストで確かめる。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  HOUSE_ID,
  ROBOT_EXTERNAL_ID,
  ROBOT_ID,
  SENSOR_ID,
  alignBrowserClock,
  apiOk,
  goToMenu,
  openAs,
  prepareApp,
  robotJson,
} from './support/app.ts';
import { assignFilePath } from './support/http-files.ts';
import { logRows, runNow, testEquipmentConnection } from './support/ingestion.ts';
import { NOW, shot } from './support/viewpoint-scenarios.ts';

const FILE_PATH = '/data/robot/latest.json';
/** センサーのファイルのパス（1 設備 = 1 ファイル。ロボットと同じパスは使えない）。 */
const SENSOR_FILE_PATH = '/data/sensor/latest.json';
/** 認証を要求するファイル（Basic 認証。ダミーの認証情報）。 */
const SECURE_PATH = '/secure/data.json';
const DUMMY_USER = 'dummy-user';
const DUMMY_PASSWORD = 'dummy-password-0123';
const DUMMY_BASIC = `Basic ${Buffer.from(`${DUMMY_USER}:${DUMMY_PASSWORD}`).toString('base64')}`;
/** コピーの元になる、2 つ目のロボット（接続を持つ）。 */
const ROBOT_2_ID = 'ROBOT-02';
const ROBOT_2_NAME = '収穫ロボット2';

/** 取り込むファイルの内容（ロボット 1 台の、1 時間前の記録 1 件。合成データ）と、更新日時（書き換えの直後ではない）。 */
const ROBOT_FILE = robotJson({
  hoursAgo: 1,
  fields: { harvestCount: 12, statusCode: 'HARVESTING' },
});
const LAST_MODIFIED = new Date(NOW.getTime() - 3_600_000).toUTCString();

let server: Server;
let port: number;
const requests: string[] = [];

test.beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
    const exists =
      request.url === FILE_PATH ||
      request.url === SENSOR_FILE_PATH ||
      (request.url === SECURE_PATH && request.headers.authorization === DUMMY_BASIC);
    if (request.url === SECURE_PATH && !exists) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (!exists) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = Buffer.from(ROBOT_FILE, 'utf8');
    response.writeHead(200, {
      'Content-Length': String(body.length),
      'Last-Modified': LAST_MODIFIED,
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
});

test.beforeEach(() => {
  requests.length = 0;
});

/** 設備の修正のダイアログを開く（取り込みの「接続を設定・修正」のリンクと同じ URL）。接続の読み込みを待つ。 */
async function openEquipmentDialog(
  page: Page,
  equipmentId: string = ROBOT_ID,
  user?: Parameters<typeof openAs>[2],
): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, `/settings/equipment?edit=${equipmentId}`, user);
  await expect(page.getByTestId('equipment-edit')).toBeVisible();
  await expect(page.getByTestId('equipment-connection')).toBeVisible();
  await expect(page.getByTestId('equipment-connection-loading')).toHaveCount(0);
}

const connection = (page: Page) => page.getByTestId('equipment-connection');
const protocol = (page: Page) => connection(page).getByLabel('プロトコル');
const host = (page: Page) => connection(page).getByLabel('ホスト名');
const portInput = (page: Page) => connection(page).getByLabel('ポート番号');
const authMethod = (page: Page) => connection(page).getByLabel('認証方式');
const saveEquipment = (page: Page) =>
  page.getByTestId('equipment-edit').getByRole('button', { name: '保存', exact: true });
const testButton = (page: Page) => page.getByTestId('equipment-connection-test');
const connectionResult = (page: Page) => page.getByTestId('equipment-connection-result');
const unsetNote = (page: Page) => page.getByTestId('equipment-connection-unset');
const credentialsBox = (page: Page) => page.getByTestId('equipment-credentials');
const credentialsStatus = (page: Page) => page.getByTestId('equipment-credentials-status');
const notice = (page: Page) => page.getByTestId('equipment-notice');

/** 設備（ロボット）に、取得するファイルのパスを設定する（取得するファイルは、設備ごと。ADR-0023）。 */
async function setRobotFilePath(request: APIRequestContext, sourceFilePath: string): Promise<void> {
  await assignFilePath(request, ROBOT_ID, sourceFilePath);
}

/** ロボットを、ハウス 1 に 1 つ追加する（コピーの元・別の設備の前提）。 */
async function addSecondRobot(request: APIRequestContext): Promise<void> {
  await apiOk(request, 'POST', '/equipment', {
    equipmentId: ROBOT_2_ID,
    equipmentType: 'ROBOT',
    name: ROBOT_2_NAME,
    facilityId: HOUSE_ID,
    externalId: 'ROBOT-SAMPLE-02',
  });
}

/** 設備の接続を、API で保存する（テスト用サーバー。プロトコルは HTTP）。 */
async function saveConnectionByApi(
  request: APIRequestContext,
  equipmentId: string,
  authMethodName: 'NONE' | 'BASIC' = 'NONE',
): Promise<void> {
  await apiOk(request, 'PUT', `/ingestion/equipment/${equipmentId}/connection`, {
    connection: {
      type: 'HTTP',
      protocol: 'HTTP',
      host: '127.0.0.1',
      port,
      authMethod: authMethodName,
    },
  });
}

/** HTTP の接続設定を入力する（手元のテスト用サーバー。プロトコルは HTTP）。 */
async function fillConnection(page: Page, overrides: { auth?: string } = {}) {
  await protocol(page).selectOption('HTTP');
  await host(page).fill('127.0.0.1');
  await portInput(page).fill(String(port));
  await authMethod(page).selectOption(overrides.auth ?? 'NONE');
}

/** 接続を入力して、設備のダイアログの「保存」を押す。保存すると、ダイアログは閉じる（「修正しました」）。 */
async function fillAndSave(page: Page, overrides: { auth?: string } = {}): Promise<void> {
  await fillConnection(page, overrides);
  await saveEquipment(page).click();
  await expect(notice(page)).toHaveText('修正しました');
  await expect(page.getByTestId('equipment-edit')).toHaveCount(0);
}

test.describe('基本フロー: 設備のダイアログで接続設定を入力・保存し、その設備だけの接続テストで結果を確認する', () => {
  test('既定は、接続が未設定（案内と、空の入力）。接続方式の選択はない。ファイルのパスと接続の案内を示す', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openEquipmentDialog(page);

    await expect(unsetNote(page)).toContainText('接続先が設定されていません');
    await expect(connection(page).getByLabel('接続方式')).toHaveCount(0);
    await expect(protocol(page)).toHaveValue('HTTPS');
    await expect(host(page)).toBeVisible();
    await expect(host(page)).toHaveValue('');
    await expect(portInput(page)).toHaveAttribute('placeholder', '443');
    await expect(authMethod(page)).toHaveValue('NONE');
    // 接続がないため、「接続を未設定に戻す」・認証情報の欄は、接続を保存するまで出ない
    await expect(page.getByTestId('equipment-connection-remove')).toHaveCount(0);
    await expect(credentialsBox(page)).toHaveCount(0);
    // ファイルのパス（設備の項目）の案内。設備ごとの接続が必要なことを伝える
    await expect(page.getByTestId('equipment-file-path-guide')).toContainText(
      'ファイルのパスを設定すると、取り込みの対象になります',
    );
    await expect(page.getByTestId('equipment-edit').getByLabel('ファイルパス')).toBeVisible();
    await shot(page, testInfo, 'uc15-connection-unset');
  });

  test('接続を保存すると、再読み込みしても保持される。接続テストに成功し、テスト用サーバーには、設備のファイルの有無の確認（HEAD）だけが届く', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await setRobotFilePath(request, FILE_PATH);
    await openEquipmentDialog(page);

    await fillAndSave(page);
    await openEquipmentDialog(page);
    await expect(unsetNote(page)).toHaveCount(0);
    await expect(host(page)).toHaveValue('127.0.0.1');
    await expect(portInput(page)).toHaveValue(String(port));
    await expect(authMethod(page)).toHaveValue('NONE');
    await page.reload();
    await expect(host(page)).toHaveValue('127.0.0.1');

    await testButton(page).click();

    await expect(connectionResult(page)).toHaveText('接続できました');
    await expect(connectionResult(page)).toHaveClass(/form-success/);
    expect(requests).toEqual([`HEAD ${FILE_PATH}`]);
    await shot(page, testInfo, 'uc15-connection');
  });

  test('一方の設備に設定しても、もう一方の設備は、未設定のまま（接続は、設備ごとだけ）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipmentDialog(page);
    await fillAndSave(page);

    await openEquipmentDialog(page, SENSOR_ID);

    await expect(unsetNote(page)).toBeVisible();
    await expect(host(page)).toHaveValue('');
    // 取り込みの、設備ごとの表の接続先
    await page.goto('/settings/ingestion');
    await expect(page.getByTestId(`equipment-target-${ROBOT_ID}`)).toHaveText(
      `http://127.0.0.1:${String(port)}`,
    );
    await expect(page.getByTestId(`equipment-target-${SENSOR_ID}`)).toHaveText('未設定');
  });

  test('接続の入力を変えて、まだ保存していないときは、接続テストを使えず、保存してからテストする旨を示す', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setRobotFilePath(request, FILE_PATH);
    await openEquipmentDialog(page);
    await expect(page.getByTestId('equipment-connection-test-unsaved')).toHaveCount(0);

    await host(page).fill('127.0.0.1');

    await expect(testButton(page)).toBeDisabled();
    await expect(page.getByTestId('equipment-connection-test-unsaved')).toContainText(
      '保存してから、接続テストをしてください',
    );
  });
});

test.describe('取り込み: 設備のファイルを、即時取得で取り込む（Issue #119）', () => {
  test('設備に設定したファイルパスのファイルを、設備ごとの接続で取得して取り込める。同じ内容は、取り込み直さない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await setRobotFilePath(request, FILE_PATH);
    await openEquipmentDialog(page);
    await fillAndSave(page);
    await goToMenu(page, '取り込み');

    const first = await runNow(page, 'robot');
    await expect(first).toContainText('取得しました（成功）');
    await expect(first).toContainText('ファイル 1 件、取り込み 2 件、読み取れなかった記録 0 件');
    const second = await runNow(page, 'robot');
    await expect(second).toContainText('ファイル 0 件、取り込み 0 件');

    // 取り込みの成否は、ログに記録される。設備ごとの表にも、最終の実行の結果が出る
    await expect(logRows(page).first()).toHaveAttribute('data-result', 'SUCCESS');
    await expect(page.getByTestId(`equipment-result-${ROBOT_ID}`)).toHaveText('成功');
    // サーバーには、設備のファイルへの、HEAD（一覧）と GET（取得）だけが届く
    expect(new Set(requests)).toEqual(new Set([`HEAD ${FILE_PATH}`, `GET ${FILE_PATH}`]));
    await shot(page, testInfo, 'uc15-http-ingestion');
  });
});

test.describe('プロトコルの警告', () => {
  test('HTTP のときだけ、通信が暗号化されない旨を警告する（保存はできる）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipmentDialog(page);
    const warning = page.getByTestId('equipment-connection-plaintext-warning');
    await expect(warning).toHaveCount(0);

    await protocol(page).selectOption('HTTP');

    await expect(warning).toBeVisible();
    await expect(warning).toContainText('暗号化されません');
    await protocol(page).selectOption('HTTPS');
    await expect(warning).toHaveCount(0);
  });
});

test.describe('代替フロー: 入力が不正なとき、保存しない。接続テストの失敗は、理由を示す', () => {
  test('ホストにスキームを含める・ポートが範囲外のときは、項目にエラーを表示して保存しない（設備も保存しない）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipmentDialog(page);
    await fillConnection(page);

    await host(page).fill('https://127.0.0.1');
    await portInput(page).fill('70000');
    await saveEquipment(page).click();

    await expect(connection(page).locator('[data-field="host"] .field-error')).toContainText(
      'FQDN・IPv4・[IPv6]',
    );
    await expect(connection(page).locator('[data-field="port"] .field-error')).toContainText(
      '1〜65535',
    );
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByTestId('equipment-edit')).toBeVisible();
    // 入力を直すと、保存できる
    await host(page).fill('127.0.0.1');
    await portInput(page).fill(String(port));
    await saveEquipment(page).click();
    await expect(notice(page)).toHaveText('修正しました');
  });

  test('設備のファイルがサーバーにないとき（404）は、「ファイルが見つかりません」を示す。接続先・ファイルパスは、表示しない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setRobotFilePath(request, '/missing/file.json');
    await openEquipmentDialog(page);
    await fillAndSave(page);
    await openEquipmentDialog(page);

    await testButton(page).click();

    const tested = connectionResult(page);
    await expect(tested).toContainText('ファイルが見つかりません');
    await expect(tested).toHaveClass(/form-error/);
    await expect(tested).not.toContainText('127.0.0.1');
    await expect(tested).not.toContainText('/missing/file.json');
  });

  test('認証方式を選び、認証情報が未設定のときは、状態は「未設定」。接続テストは、「認証情報が設定されていません」を示し、接続しない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setRobotFilePath(request, FILE_PATH);
    await openEquipmentDialog(page);
    await fillConnection(page, { auth: 'BASIC' });
    // 認証情報は、接続を保存したあとに登録する（保存前は、案内だけを示す）
    await expect(page.getByTestId('equipment-connection-credentials-note')).toContainText(
      '接続を保存したあとに、登録できます',
    );
    await expect(credentialsBox(page)).toHaveCount(0);
    await saveEquipment(page).click();
    await expect(notice(page)).toHaveText('修正しました');
    await openEquipmentDialog(page);
    await expect(credentialsStatus(page)).toContainText('未設定');

    await testButton(page).click();

    await expect(connectionResult(page)).toContainText('認証情報が設定されていません');
    expect(requests).toEqual([]);
  });

  test('ファイルパスが設定されていない設備は、接続テストで、その旨を示し、接続しない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipmentDialog(page);
    await fillAndSave(page);
    await openEquipmentDialog(page);

    await testButton(page).click();

    await expect(connectionResult(page)).toContainText('ファイルパスが設定された設備がありません');
    await expect(connectionResult(page)).toHaveClass(/form-error/);
    expect(requests).toEqual([]);
  });

  test('認証情報を、書き込み専用で登録する: 「設定済み」と更新日時を示し、入力を空に戻し、値を再表示しない。登録した認証情報で、接続テストが成功する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await setRobotFilePath(request, SECURE_PATH);
    await openEquipmentDialog(page);
    await fillAndSave(page, { auth: 'BASIC' });
    await openEquipmentDialog(page);
    const credentials = credentialsBox(page);
    await expect(credentials.getByLabel('パスワード')).toHaveAttribute('type', 'password');
    await testButton(page).click();
    await expect(connectionResult(page)).toContainText('認証情報が設定されていません');

    await credentials.getByLabel('ユーザー名').fill(DUMMY_USER);
    await credentials.getByLabel('パスワード').fill(DUMMY_PASSWORD);
    await page.getByTestId('equipment-credentials-save').click();

    await expect(connectionResult(page)).toHaveText('認証情報を保存しました');
    await expect(credentialsStatus(page)).toContainText('設定済み（更新:');
    await expect(credentials.getByLabel('ユーザー名')).toHaveValue('');
    await expect(credentials.getByLabel('パスワード')).toHaveValue('');
    await page.reload();
    await expect(credentialsStatus(page)).toContainText('設定済み（更新:');
    await expect(credentials.getByLabel('パスワード')).toHaveValue('');
    expect(await page.content()).not.toContain(DUMMY_PASSWORD);

    await testButton(page).click();
    await expect(connectionResult(page)).toHaveText('接続できました');
    expect(requests).toEqual([`HEAD ${SECURE_PATH}`]);
    // 取り込みの、設備ごとの表にも、認証情報の状態を示す（値は示さない）
    await page.goto('/settings/ingestion');
    await expect(page.getByTestId(`equipment-credentials-${ROBOT_ID}`)).toContainText(
      '設定済み（更新:',
    );
    expect(await page.content()).not.toContain(DUMMY_PASSWORD);
    await shot(page, testInfo, 'uc15-credentials');
  });

  test('認証方式を変えて、まだ保存していないときは、先に設備を保存するよう案内し、認証情報を登録できない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipmentDialog(page);
    await fillAndSave(page, { auth: 'BASIC' });
    await openEquipmentDialog(page);

    await authMethod(page).selectOption('BEARER');

    await expect(page.getByTestId('equipment-credentials-unsaved')).toContainText('先に設備を保存');
    await expect(page.getByTestId('equipment-credentials-save')).toBeDisabled();
  });

  test('API キーを選ぶと、ヘッダー名の入力を表示する（既定は X-API-Key）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openEquipmentDialog(page);

    await authMethod(page).selectOption('API_KEY');

    await expect(connection(page).getByLabel('API キーのヘッダー名')).toHaveValue('X-API-Key');
    await authMethod(page).selectOption('BEARER');
    await expect(connection(page).getByLabel('API キーのヘッダー名')).toHaveCount(0);
  });
});

test.describe('コピー: 同じ種別の既存設備から、接続を写す（認証情報は写さない）', () => {
  test('コピーできる設備がないときは、選べない旨を示す', async ({ page, request }) => {
    await prepareApp(request);
    await openEquipmentDialog(page);

    await expect(page.getByTestId('equipment-connection-copy')).toBeDisabled();
    await expect(page.getByTestId('equipment-connection-copy')).toContainText(
      'コピーできる設備（同じ種別で、設備ごとの接続を持つ設備）がありません',
    );
  });

  test('同じ種別（ロボット）で、設備ごとの接続を持つ設備だけを選べる。写すのは接続の項目だけで、認証情報は写さず、保存して、入力し直す', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await addSecondRobot(request);
    // ROBOT-02 は、Basic 認証の接続と、認証情報（設定済み）を持つ。SENSOR-01 も、接続を持つ（種別が違うため、選べない）
    await saveConnectionByApi(request, ROBOT_2_ID, 'BASIC');
    await apiOk(request, 'PUT', `/ingestion/equipment/${ROBOT_2_ID}/credentials`, {
      authMethod: 'BASIC',
      username: DUMMY_USER,
      password: DUMMY_PASSWORD,
    });
    await saveConnectionByApi(request, SENSOR_ID);
    await openEquipmentDialog(page);
    const copy = page.getByTestId('equipment-connection-copy');
    await expect(copy).toBeEnabled();
    await expect(copy.locator('option')).toHaveText([
      '選択してください',
      `${ROBOT_2_NAME}（${ROBOT_2_ID}）`,
    ]);

    await copy.selectOption(ROBOT_2_ID);

    await expect(page.getByTestId('equipment-connection-copied')).toContainText(
      `「${ROBOT_2_NAME}」の接続の内容を、入力欄に写しました（まだ保存していません）`,
    );
    await expect(page.getByTestId('equipment-connection-copied')).toContainText(
      '認証情報は、写していません',
    );
    await expect(protocol(page)).toHaveValue('HTTP');
    await expect(host(page)).toHaveValue('127.0.0.1');
    await expect(portInput(page)).toHaveValue(String(port));
    await expect(authMethod(page)).toHaveValue('BASIC');
    // 保存するまで、接続テストは使えず、認証情報の入力もない（保存したあとに入力する）
    await expect(testButton(page)).toBeDisabled();
    await expect(credentialsBox(page)).toHaveCount(0);
    await expect(page.getByTestId('equipment-connection-credentials-note')).toBeVisible();
    await shot(page, testInfo, 'uc15-connection-copied');

    await saveEquipment(page).click();
    await expect(notice(page)).toHaveText('修正しました');

    // 保存した接続は、写した内容。認証情報は、写していない（コピー元は、設定済みのまま）
    await openEquipmentDialog(page);
    await expect(host(page)).toHaveValue('127.0.0.1');
    await expect(authMethod(page)).toHaveValue('BASIC');
    await expect(credentialsStatus(page)).toContainText('未設定');
    await page.goto('/settings/ingestion');
    await expect(page.getByTestId(`equipment-target-${ROBOT_ID}`)).toHaveText(
      `http://127.0.0.1:${String(port)}`,
    );
    await expect(page.getByTestId(`equipment-credentials-${ROBOT_ID}`)).toHaveText('未設定');
    await expect(page.getByTestId(`equipment-credentials-${ROBOT_2_ID}`)).toContainText('設定済み');
  });
});

test.describe('接続を未設定に戻す: 設備の接続を解除し、未設定に戻す', () => {
  test('確認のうえ、「接続を未設定に戻す」と、未設定に戻る。取り消すと、戻さない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await saveConnectionByApi(request, ROBOT_ID);
    await openEquipmentDialog(page);
    await expect(host(page)).toHaveValue('127.0.0.1');
    await expect(page.getByTestId('equipment-connection-remove')).toHaveText('接続を未設定に戻す');

    await page.getByTestId('equipment-connection-remove').click();
    const confirm = page.getByTestId('equipment-connection-remove-confirm');
    await expect(confirm).toContainText('未設定に戻します');
    await expect(confirm).toContainText('「接続先が設定されていません」で失敗します');
    await expect(page.getByTestId('equipment-connection-remove-yes')).toHaveText('未設定に戻す');
    await shot(page, testInfo, 'uc15-connection-remove-confirm');
    await confirm.getByRole('button', { name: 'キャンセル' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(host(page)).toHaveValue('127.0.0.1');

    await page.getByTestId('equipment-connection-remove').click();
    await page.getByTestId('equipment-connection-remove-yes').click();

    await expect(connectionResult(page)).toHaveText('接続を未設定に戻しました');
    await expect(unsetNote(page)).toBeVisible();
    await expect(host(page)).toHaveValue('');
    await expect(page.getByTestId('equipment-connection-remove')).toHaveCount(0);
    await page.goto('/settings/ingestion');
    await expect(page.getByTestId(`equipment-target-${ROBOT_ID}`)).toHaveText('未設定');
  });

  test('未設定に戻すと、接続テストは「接続先が設定されていません」で、取り込みは接続できないとして、失敗する。接続は、設備ごとのため、ほかの設備には影響しない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setRobotFilePath(request, FILE_PATH);
    await saveConnectionByApi(request, ROBOT_ID);
    await assignFilePath(request, SENSOR_ID, SENSOR_FILE_PATH);
    await saveConnectionByApi(request, SENSOR_ID);
    await openEquipmentDialog(page);
    await testButton(page).click();
    await expect(connectionResult(page)).toHaveText('接続できました');

    await page.getByTestId('equipment-connection-remove').click();
    await page.getByTestId('equipment-connection-remove-yes').click();
    await expect(connectionResult(page)).toHaveText('接続を未設定に戻しました');
    requests.length = 0;

    await page.goto('/settings/ingestion');
    await expect(page.getByTestId(`equipment-target-${ROBOT_ID}`)).toHaveText('未設定');
    await expect(page.getByTestId(`equipment-target-${SENSOR_ID}`)).toHaveText(
      `http://127.0.0.1:${String(port)}`,
    );
    const tested = await testEquipmentConnection(page, ROBOT_ID);
    await expect(tested).toContainText('接続先が設定されていません');
    await expect(tested).toHaveClass(/form-error/);
    const ran = await runNow(page, 'robot');
    await expect(ran).toContainText('取得しました（失敗）');
    await expect(logRows(page).first()).toHaveAttribute('data-result', 'FAILURE');
    // 取り込みのログは、理由を細かく示さない（接続できなかった旨）。理由の「接続先が設定されていません」は、接続テストで示す
    await expect(logRows(page).first()).toContainText('ファイルサーバーに接続できませんでした');
    await expect(page.getByTestId(`equipment-result-${ROBOT_ID}`)).toHaveText('失敗');
    // 未設定の設備には、接続しない
    expect(requests).toEqual([]);
    // もう一方の設備（接続あり）は、取り込める
    const sensor = await testEquipmentConnection(page, SENSOR_ID);
    await expect(sensor).toHaveText('接続できました');
  });
});

test.describe('登録と同時の保存: ロボットを登録するときに、接続も保存する', () => {
  async function openRegisterDialog(page: Page): Promise<void> {
    await alignBrowserClock(page);
    await openAs(page, '/settings/equipment');
    await page.getByRole('button', { name: 'ロボット・環境センサーの登録' }).click();
    await expect(page.getByRole('form', { name: 'ロボット・環境センサーを登録' })).toBeVisible();
  }

  async function fillRobot(page: Page): Promise<void> {
    const form = page.getByRole('form', { name: 'ロボット・環境センサーを登録' });
    await form.getByLabel('種別').selectOption('ROBOT');
    await form.getByLabel('親のハウス').selectOption(HOUSE_ID);
    await form.getByLabel('設備ID').fill(ROBOT_2_ID);
    await form.getByLabel('名称').fill(ROBOT_2_NAME);
    await form.getByLabel('データ上の識別子').fill(ROBOT_EXTERNAL_ID.replace('01', '02'));
    await form.getByLabel('ファイルパス').fill(FILE_PATH);
  }

  test('接続を入力して登録すると、設備と、設備ごとの接続の両方を保存する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openRegisterDialog(page);
    await fillRobot(page);
    await expect(connection(page)).toBeVisible();
    await expect(unsetNote(page)).toBeVisible();
    await fillConnection(page);

    await page.getByRole('button', { name: '登録する' }).click();

    await expect(notice(page)).toHaveText('登録しました');
    await page.goto('/settings/ingestion');
    await expect(page.getByTestId(`equipment-path-${ROBOT_2_ID}`)).toHaveText(FILE_PATH);
    await expect(page.getByTestId(`equipment-target-${ROBOT_2_ID}`)).toHaveText(
      `http://127.0.0.1:${String(port)}`,
    );
  });

  test('設備は登録できて、接続の保存だけが失敗したときは、その旨を示す。やり直すと、設備を重ねて登録せず、接続を保存する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openRegisterDialog(page);
    await fillRobot(page);
    await fillConnection(page);
    // 接続の保存だけを、一度、失敗させる（保管先の障害の再現）
    let failNext = true;
    await page.route('**/api/v1/ingestion/equipment/*/connection', async (route) => {
      if (failNext && route.request().method() === 'PUT') {
        failNext = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'SERVICE_UNAVAILABLE', message: '接続を保存できませんでした' },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: '登録する' }).click();

    await expect(page.getByTestId('equipment-partial')).toContainText(
      '設備は登録しました。取り込み元の接続は、保存できませんでした',
    );
    // 設備は、登録されている
    const tree = await apiOk<{ facilities: { children: { equipmentId: string }[] }[] }>(
      request,
      'GET',
      '/equipment',
    );
    expect(
      tree.facilities.flatMap((facility) => facility.children).map((item) => item.equipmentId),
    ).toContain(ROBOT_2_ID);

    await page.getByRole('button', { name: '登録する' }).click();

    await expect(notice(page)).toHaveText('登録しました');
    const after = await apiOk<{ facilities: { children: { equipmentId: string }[] }[] }>(
      request,
      'GET',
      '/equipment',
    );
    expect(
      after.facilities
        .flatMap((facility) => facility.children)
        .filter((item) => item.equipmentId === ROBOT_2_ID),
    ).toHaveLength(1);
    await page.goto('/settings/ingestion');
    await expect(page.getByTestId(`equipment-target-${ROBOT_2_ID}`)).toHaveText(
      `http://127.0.0.1:${String(port)}`,
    );
  });
});

test.describe('SC-11 から、設備のダイアログへ（接続を設定・修正）', () => {
  test('設備ごとの表の「接続を設定・修正」から、その設備のダイアログを開く。接続テストは、その設備だけ', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await setRobotFilePath(request, FILE_PATH);
    await saveConnectionByApi(request, ROBOT_ID);
    await alignBrowserClock(page);
    await openAs(page, '/settings/ingestion');

    await expect(await testEquipmentConnection(page, ROBOT_ID)).toHaveText('接続できました');
    expect(requests).toEqual([`HEAD ${FILE_PATH}`]);
    await page.getByTestId(`equipment-configure-${ROBOT_ID}`).click();

    await expect(page).toHaveURL(new RegExp(`/settings/equipment\\?edit=${ROBOT_ID}$`));
    await expect(page.getByRole('dialog')).toHaveAccessibleName(/ロボット（ROBOT-01）を修正/);
    await expect(host(page)).toHaveValue('127.0.0.1');
  });
});
