/**
 * E2E の補助（UC-04 以降の共通部分）: API の呼び出し、ファイルサーバーのモックへのファイルの配置、
 * ユーザーの追加と切り替え（別のブラウザのコンテキスト）、ブラウザの時計の固定、画面の操作の補助。
 * 値は、docs の判断基準・仕様から手計算で選ぶ。評価のコードを呼び出して、期待値を作らない。
 */

import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { LoginResponseSchema } from '../../../src/shared/schemas/auth.ts';
import { E2E_USER } from './e2e-user.ts';
import { loginViaUi } from './helpers.ts';
import { NOW, prepare, type PrepareOptions } from './viewpoint-scenarios.ts';

/** バックエンドのファイルサーバーのモックのルート（playwright.config.ts の FILE_SERVER_DIR と同じ）。 */
export const FILE_SERVER_ROOT = resolve('test-result/e2e-file-server');
const FIXTURES_ROOT = resolve('tests/fixtures/file-server');

/** 設備のデモ（ハウス1・収穫ロボット1・環境センサー1）の識別子。 */
export const HOUSE_ID = 'HOUSE-01';
export const ROBOT_ID = 'ROBOT-01';
export const SENSOR_ID = 'SENSOR-01';
/** ファイルの中の設備の識別子（合成データのファイルと対応する）。 */
export const ROBOT_EXTERNAL_ID = 'ROBOT-SAMPLE-01';
export const SENSOR_EXTERNAL_ID = 'SENSOR-SAMPLE-01';

export interface E2eUser {
  readonly userId: string;
  readonly userName: string;
  readonly password: string;
  readonly role: 'worker' | 'viewer';
}

/** 2人目以降の利用者（明らかにダミーとわかる値）。 */
export const USER_B: E2eUser = {
  userId: 'e2e-user-b',
  userName: 'E2E利用者B',
  password: 'Dummy-Passw0rd-b1',
  role: 'worker',
};
export const VIEWER: E2eUser = {
  userId: 'e2e-viewer',
  userName: 'E2E閲覧者',
  password: 'Dummy-Passw0rd-v1',
  role: 'viewer',
};

/** ログインの結果（アクセストークン）を、リクエストの文脈・ユーザーごとに使い回す（ログインの処理時間を省く）。 */
const TOKENS = new WeakMap<APIRequestContext, Map<string, string>>();

export async function accessToken(
  request: APIRequestContext,
  user: Pick<E2eUser, 'userId' | 'password'> = E2E_USER,
): Promise<string> {
  const cached = TOKENS.get(request)?.get(user.userId);
  if (cached !== undefined) {
    return cached;
  }
  const login = await request.post('/api/v1/auth/login', {
    data: { userId: user.userId, password: user.password },
  });
  expect(login.ok(), 'ログイン').toBe(true);
  const { accessToken: token } = LoginResponseSchema.parse(await login.json());
  const tokens = TOKENS.get(request) ?? new Map<string, string>();
  tokens.set(user.userId, token);
  TOKENS.set(request, tokens);
  return token;
}

/** API を呼ぶ（E2E のユーザー）。応答はそのまま返す。 */
export async function api(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<APIResponse> {
  const send = async () =>
    request.fetch(`/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${await accessToken(request)}` },
      ...(body === undefined ? {} : { data: body }),
    });
  const response = await send();
  if (response.status() !== 401) {
    return response;
  }
  // サーバーの時計を進めた場合は、アクセストークンの期限が切れるため、ログインし直して、もう一度呼ぶ
  TOKENS.delete(request);
  return send();
}

/** API を呼び、成功（2xx）を確認して、本文（JSON。204 なら undefined）を返す。 */
export async function apiOk<Body = unknown>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Body> {
  const response = await api(request, method, path, body);
  expect(response.ok(), `${method} ${path}: ${String(response.status())}`).toBe(true);
  return (response.status() === 204 ? undefined : await response.json()) as Body;
}

/** ジョブ（JB-01〜JB-04）を起動する（開発用 API）。 */
export async function runJob(
  request: APIRequestContext,
  jobId: 'JB-01' | 'JB-02' | 'JB-03' | 'JB-04',
): Promise<void> {
  await apiOk(request, 'POST', `/dev/jobs/${jobId}/run`, {});
}

/** モック（ファイルサーバー・農業情報基盤・Web Push）の状態を切り替える（開発用 API）。 */
export async function setMock(
  request: APIRequestContext,
  target: 'file-server' | 'federation' | 'web-push',
  mode: 'UP' | 'DOWN' | 'SLOW' | 'REJECT',
): Promise<void> {
  await apiOk(request, 'PUT', `/dev/mocks/${target}`, { mode });
}

/** 時計を進める（開発用 API）。 */
export async function advanceMinutes(request: APIRequestContext, minutes: number): Promise<void> {
  await apiOk(request, 'POST', '/dev/clock/advance', { minutes });
}

/** ユーザーを追加する（ユーザー管理の API）。 */
export async function addUser(request: APIRequestContext, user: E2eUser): Promise<void> {
  await apiOk(request, 'POST', '/users', {
    userId: user.userId,
    userName: user.userName,
    password: user.password,
    role: user.role,
  });
}

/** 手動入力を API で登録する（前提のデータの用意）。 */
export async function addEntry(
  request: APIRequestContext,
  input: {
    equipmentId?: string;
    category: string;
    observedAt: string;
    items: Record<string, number>;
    note?: string;
  },
): Promise<{ entry: { entryId: string } }> {
  return apiOk(request, 'POST', '/manual-entries', { equipmentId: ROBOT_ID, ...input });
}

// ファイルサーバーのモック

/**
 * ファイルサーバーのモックの内容（ファイル）を空にする。
 * ディレクトリ（ルート・取り込み元）は、サーバーが参照しているため、Windows で削除が拒否される（EPERM）ことがある。
 * そのため、ディレクトリは残して、中のファイルだけを消す。ディレクトリがない状態は、`removeSourceDirectory` で作る
 */
export function clearFileServer(): void {
  mkdirSync(FILE_SERVER_ROOT, { recursive: true });
  removeFilesIn(FILE_SERVER_ROOT);
}

function removeFilesIn(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      removeFilesIn(path);
    } else {
      rmSync(path, { force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

/** 取り込み元のディレクトリそのものを消す（取り込み元の場所がない状態を作る）。 */
export function removeSourceDirectory(sourceId: string): void {
  rmSync(join(FILE_SERVER_ROOT, sourceId), {
    recursive: true,
    force: true,
    maxRetries: 15,
    retryDelay: 200,
  });
}

/** ファイルサーバーのモックに、任意の内容のファイルを置く。 */
export function placeFile(sourceId: string, name: string, content: string): void {
  const directory = join(FILE_SERVER_ROOT, sourceId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), content, 'utf8');
}

/** ファイルサーバーのモックに、合成データのフィクスチャを置く（tests/fixtures/file-server/ からの相対パス）。 */
export function placeFixture(sourceId: string, fixture: string, asName?: string): void {
  const directory = join(FILE_SERVER_ROOT, sourceId);
  mkdirSync(directory, { recursive: true });
  cpSync(
    join(FIXTURES_ROOT, fixture),
    join(directory, asName ?? fixture.split('/').at(-1) ?? fixture),
  );
}

/** 観測値の日時を、現在（固定した時計）から相対で指定した、ロボットの JSON（合成データ）。 */
export function robotJson(
  records: readonly { hoursAgo: number; fields: Record<string, number | string | null> }[],
  robotId: string = ROBOT_EXTERNAL_ID,
): string {
  return JSON.stringify({
    robotId,
    records: records.map((record) => ({
      timestamp: new Date(NOW.getTime() - record.hoursAgo * 3_600_000).toISOString(),
      ...record.fields,
    })),
  });
}

/** 環境センサーの CSV（合成データ）。 */
export function sensorCsv(
  rows: readonly {
    hoursAgo: number;
    temperature: number | string;
    humidity: number | string;
    illuminance: number | string;
    co2: number | string;
  }[],
  sensorId: string = SENSOR_EXTERNAL_ID,
): string {
  const lines = rows.map(
    (row) =>
      `${sensorId},${new Date(NOW.getTime() - row.hoursAgo * 3_600_000).toISOString()},${String(row.temperature)},${String(row.humidity)},${String(row.illuminance)},${String(row.co2)}`,
  );
  return ['sensor_id,timestamp,temperature_c,humidity_pct,illuminance_lx,co2_ppm', ...lines].join(
    '\n',
  );
}

// 準備・ブラウザ

/** データを初期化（デモの設備のみ）し、時計を固定し、ファイルサーバーのモックを空にする。 */
export async function prepareApp(
  request: APIRequestContext,
  options: PrepareOptions = {},
): Promise<void> {
  clearFileServer();
  await prepare(request, options);
}

/** ブラウザの時計を、サーバーの固定した時計に合わせる（画面の「現在」の既定値・未来の検証のため）。 */
export async function alignBrowserClock(page: Page, at: Date = NOW): Promise<void> {
  await page.clock.setFixedTime(at);
}

/** 指定した利用者として、新しいブラウザのコンテキスト（動画つき）を開く（複数ユーザーのシナリオ用）。 */
export async function newUserSession(
  browser: Browser,
  testInfo: TestInfo,
  label: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    recordVideo: { dir: testInfo.outputPath(`video-${label}`), size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  await alignBrowserClock(page);
  return { context, page };
}

/** パスを開き、ログイン画面なら、指定の利用者でログインする（すでにログイン済みなら、そのまま）。 */
export async function openAs(
  page: Page,
  path: string,
  user: Pick<E2eUser, 'userId' | 'password'> = E2E_USER,
): Promise<void> {
  await page.goto(path);
  const userIdField = page.getByLabel('ユーザーID');
  await Promise.race([userIdField.waitFor(), page.getByRole('banner').waitFor()]);
  if (await userIdField.isVisible()) {
    await loginViaUi(page, user.password, user.userId);
  }
  await expect(page.getByRole('banner')).toBeVisible();
}

/**
 * 画面内のリンクのメニューを選ぶ（ナビゲーション）。
 * 狭い幅（900px 以下）では、メニューは「☰ で開く引き出し」のため、☰ が見えているときだけ、先に開く。
 */
export async function goToMenu(page: Page, name: string): Promise<void> {
  const toggle = page.getByRole('button', { name: 'メニューを開く' });
  if (await toggle.isVisible()) {
    await toggle.click();
  }
  await page
    .getByRole('navigation', { name: 'メニュー' })
    .getByRole('link', { name, exact: true })
    .click();
}

/** ヘッダーの未読の件数。 */
export function unreadBadge(page: Page): Locator {
  return page.getByTestId('unread-count');
}

/** 確認のダイアログで、実行（削除など）を選ぶ。 */
export async function confirmDialog(page: Page, confirmLabel: string): Promise<void> {
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** 日本時間の日時の入力（datetime-local）の値に変換する。 */
export function jstInput(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(iso))
    .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}T${parts.hour ?? ''}:${parts.minute ?? ''}`;
}
