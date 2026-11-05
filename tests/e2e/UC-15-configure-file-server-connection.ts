/**
 * UC-15 取り込み元の接続設定（ファイルサーバーの HTTP）を設定し、接続テストを行う（SC-11。Issue #172。ADR-0022。FR-1.3、NFR-5.4）。
 *
 * ユースケースシナリオ（use-cases.md の UC-15 の基本フロー 1〜3）に対応する。
 *   1. 農作業者が、接続先（ホスト・ポート・ファイルパス・プロトコル・認証方式）を入力する
 *   2. システムが、設定を保存する
 *   3. 農作業者が、接続テストを実行し、結果（成功、または、失敗の理由）を確認する
 *
 * 値の同値分割: 接続方式（モック・HTTP）、プロトコル（HTTPS・HTTP。HTTP は警告）、ポート（省略・指定・不正）、
 * ホスト（正常・スキームつき）、ファイルパス（正常・不正）、認証方式（なし・認証情報が未設定）、接続テスト（成功・ファイルなし）。
 * 認証情報の登録（Issue #207。D-47）: 認証方式（Basic）を選んで保存したあと、ユーザー名・パスワードを書き込み専用で登録し、
 * 「設定済み」と更新日時を示す。保存後は、値を再表示しない。登録した認証情報で、接続テストが成功する。
 * 内部のアドレスの拒否（SSRF の対策）は、E2E では、手元のサーバーに接続するため許可している（HTTP_FILE_SOURCE_ALLOW_PRIVATE）。
 * 拒否そのものは、単体テスト（address-guard・http-probe）と結合テストで確かめる。
 * 取り込み（ファイルの一覧・取得）は、Issue #119。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { alignBrowserClock, goToMenu, openAs, prepareApp } from './support/app.ts';
import { sourceCard, testConnection } from './support/ingestion.ts';
import { shot } from './support/viewpoint-scenarios.ts';

const FILE_PATH = '/data/robot/latest.json';
/** 認証を要求するファイル（Basic 認証。ダミーの認証情報）。 */
const SECURE_PATH = '/secure/data.json';
const DUMMY_USER = 'dummy-user';
const DUMMY_PASSWORD = 'dummy-password-0123';
const DUMMY_BASIC = `Basic ${Buffer.from(`${DUMMY_USER}:${DUMMY_PASSWORD}`).toString('base64')}`;

let server: Server;
let port: number;
const requests: string[] = [];

test.beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
    if (request.url === SECURE_PATH) {
      response.writeHead(request.headers.authorization === DUMMY_BASIC ? 200 : 401);
    } else {
      response.writeHead(request.url === FILE_PATH ? 200 : 404);
    }
    response.end();
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

async function openIngestion(page: Page): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/');
  await goToMenu(page, '取り込み');
  await expect(page.getByRole('heading', { name: '取り込み設定・状況', level: 1 })).toBeVisible();
}

const robot = (page: Page) => sourceCard(page, 'robot');
const connectionType = (page: Page) => robot(page).getByLabel('接続方式');
const protocol = (page: Page) => robot(page).getByLabel('プロトコル');
const host = (page: Page) => robot(page).getByLabel('ホスト名');
const portInput = (page: Page) => robot(page).getByLabel('ポート番号');
const filePath = (page: Page) => robot(page).getByLabel('ファイルパス');
const authMethod = (page: Page) => robot(page).getByLabel('認証方式');
const save = (page: Page) => robot(page).getByRole('button', { name: '設定を保存' });
const result = (page: Page) => page.getByTestId('result-robot');

/** HTTP の接続設定を入力する（手元のテスト用サーバー。プロトコルは HTTP）。 */
async function fillConnection(page: Page, overrides: { path?: string; auth?: string } = {}) {
  await connectionType(page).selectOption('HTTP');
  await protocol(page).selectOption('HTTP');
  await host(page).fill('127.0.0.1');
  await portInput(page).fill(String(port));
  await filePath(page).fill(overrides.path ?? FILE_PATH);
  await authMethod(page).selectOption(overrides.auth ?? 'NONE');
}

test.describe('基本フロー: 接続設定を入力・保存し、接続テストで結果を確認する', () => {
  test('既定は、接続方式「モック」。HTTP を選ぶと、接続先の入力を表示する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openIngestion(page);

    await expect(connectionType(page)).toHaveValue('MOCK');
    await expect(host(page)).toHaveCount(0);
    await connectionType(page).selectOption('HTTP');
    await expect(protocol(page)).toHaveValue('HTTPS');
    await expect(host(page)).toBeVisible();
    await expect(portInput(page)).toHaveAttribute('placeholder', '443');
    await expect(authMethod(page)).toHaveValue('NONE');
  });

  test('接続設定を保存すると、再読み込みしても保持される。接続テストに成功し、テスト用サーバーには、ファイルの有無の確認（HEAD）だけが届く', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openIngestion(page);

    await fillConnection(page);
    await save(page).click();
    await expect(result(page)).toHaveText('設定を保存しました');
    await page.reload();
    await expect(connectionType(page)).toHaveValue('HTTP');
    await expect(host(page)).toHaveValue('127.0.0.1');
    await expect(portInput(page)).toHaveValue(String(port));
    await expect(filePath(page)).toHaveValue(FILE_PATH);

    const tested = await testConnection(page, 'robot');
    await expect(tested).toHaveText('接続できました');
    await expect(tested).toHaveClass(/form-success/);
    expect(requests).toEqual([`HEAD ${FILE_PATH}`]);
    await shot(page, testInfo, 'uc15-connection');
  });

  test('モックに戻せる。もう一方の取り込み元は、変わらない', async ({ page, request }) => {
    await prepareApp(request);
    await openIngestion(page);
    await fillConnection(page);
    await save(page).click();
    await expect(result(page)).toHaveText('設定を保存しました');

    await connectionType(page).selectOption('MOCK');
    await save(page).click();

    await expect(result(page)).toHaveText('設定を保存しました');
    await page.reload();
    await expect(connectionType(page)).toHaveValue('MOCK');
    await expect(sourceCard(page, 'environment-sensor').getByLabel('接続方式')).toHaveValue('MOCK');
  });
});

test.describe('プロトコルの警告', () => {
  test('HTTP のときだけ、通信が暗号化されない旨を警告する（保存はできる）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openIngestion(page);
    await connectionType(page).selectOption('HTTP');
    await expect(page.getByTestId('plaintext-warning-robot')).toHaveCount(0);

    await protocol(page).selectOption('HTTP');

    const warning = page.getByTestId('plaintext-warning-robot');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('暗号化されません');
    await protocol(page).selectOption('HTTPS');
    await expect(warning).toHaveCount(0);
  });
});

test.describe('代替フロー: 入力が不正なとき、保存しない。接続テストの失敗は、理由を示す', () => {
  test('ホストにスキームを含める・ポートが範囲外・ファイルパスが不正なときは、項目にエラーを表示して保存しない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openIngestion(page);
    await fillConnection(page);

    await host(page).fill('https://127.0.0.1');
    await portInput(page).fill('70000');
    await filePath(page).fill('data/../a.json');
    await save(page).click();

    const card = robot(page);
    await expect(card.locator('[data-field="connection.host"] .field-error')).toContainText(
      'FQDN・IPv4・[IPv6]',
    );
    await expect(card.locator('[data-field="connection.port"] .field-error')).toContainText(
      '1〜65535',
    );
    await expect(card.locator('[data-field="connection.filePath"] .field-error')).toContainText(
      'ファイルパス',
    );
    await expect(result(page)).toHaveCount(0);
  });

  test('ファイルがないとき（404）は、「ファイルが見つかりません」を示す。接続先・ファイルパスは、表示しない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openIngestion(page);
    await fillConnection(page, { path: '/missing/file.json' });
    await save(page).click();
    await expect(result(page)).toHaveText('設定を保存しました');

    const tested = await testConnection(page, 'robot');

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
    await openIngestion(page);
    await fillConnection(page, { auth: 'BASIC' });
    await expect(page.getByTestId('credentials-note-robot')).toContainText(
      '設定を保存したあとに、登録できます',
    );
    await save(page).click();
    await expect(result(page)).toHaveText('設定を保存しました');
    await expect(page.getByTestId('credentials-status-robot')).toContainText('未設定');

    const tested = await testConnection(page, 'robot');

    await expect(tested).toContainText('認証情報が設定されていません');
    expect(requests).toEqual([]);
  });

  test('認証情報を、書き込み専用で登録する: 「設定済み」と更新日時を示し、入力を空に戻し、値を再表示しない。登録した認証情報で、接続テストが成功する', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openIngestion(page);
    await fillConnection(page, { auth: 'BASIC', path: SECURE_PATH });
    await save(page).click();
    await expect(result(page)).toHaveText('設定を保存しました');
    const credentials = page.getByTestId('credentials-robot');
    await expect(credentials.getByLabel('パスワード')).toHaveAttribute('type', 'password');
    const failed = await testConnection(page, 'robot');
    await expect(failed).toContainText('認証情報が設定されていません');

    await credentials.getByLabel('ユーザー名').fill(DUMMY_USER);
    await credentials.getByLabel('パスワード').fill(DUMMY_PASSWORD);
    await credentials.getByRole('button', { name: '認証情報を保存' }).click();

    await expect(result(page)).toHaveText('認証情報を保存しました');
    await expect(page.getByTestId('credentials-status-robot')).toContainText('設定済み（更新:');
    await expect(credentials.getByLabel('ユーザー名')).toHaveValue('');
    await expect(credentials.getByLabel('パスワード')).toHaveValue('');
    await page.reload();
    await expect(page.getByTestId('credentials-status-robot')).toContainText('設定済み（更新:');
    await expect(credentials.getByLabel('パスワード')).toHaveValue('');
    expect(await page.content()).not.toContain(DUMMY_PASSWORD);

    const tested = await testConnection(page, 'robot');
    await expect(tested).toHaveText('接続できました');
    expect(requests).toEqual([`HEAD ${SECURE_PATH}`]);
    await shot(page, testInfo, 'uc15-credentials');
  });

  test('認証方式を変えて、まだ保存していないときは、先に設定を保存するよう案内し、認証情報を登録できない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openIngestion(page);
    await fillConnection(page, { auth: 'BASIC' });
    await save(page).click();
    await expect(result(page)).toHaveText('設定を保存しました');

    await authMethod(page).selectOption('BEARER');

    await expect(page.getByTestId('credentials-unsaved-robot')).toContainText('先に設定を保存');
    await expect(
      page.getByTestId('credentials-robot').getByRole('button', { name: '認証情報を保存' }),
    ).toBeDisabled();
  });

  test('API キーを選ぶと、ヘッダー名の入力を表示する（既定は X-API-Key）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openIngestion(page);
    await connectionType(page).selectOption('HTTP');

    await authMethod(page).selectOption('API_KEY');

    await expect(robot(page).getByLabel('API キーのヘッダー名')).toHaveValue('X-API-Key');
    await authMethod(page).selectOption('BEARER');
    await expect(robot(page).getByLabel('API キーのヘッダー名')).toHaveCount(0);
  });
});
