/**
 * E2E の補助（UC-04 以降の共通部分）: API の呼び出し、取り込みの合成データ（JSON）の組み立て、
 * ユーザーの追加と切り替え（別のブラウザのコンテキスト）、ブラウザの時計の固定、画面の操作の補助。
 * 値は、docs の判断基準・仕様から手計算で選ぶ。評価のコードを呼び出して、期待値を作らない。
 */

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
  readonly role: 'admin' | 'general' | 'viewer';
}

/** 2人目以降の利用者（明らかにダミーとわかる値）。 */
export const USER_B: E2eUser = {
  userId: 'e2e-user-b',
  userName: 'E2E利用者B',
  password: 'Dummy-Passw0rd-b1',
  role: 'admin',
};
/** 一般ユーザー（手動入力のみ。ロールの権限の確認用）。 */
export const GENERAL: E2eUser = {
  userId: 'e2e-general',
  userName: 'E2E一般ユーザー',
  password: 'Dummy-Passw0rd-g1',
  role: 'general',
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

/**
 * 設備（ロボット・センサー）の取得間隔（分）を、API で設定する（Issue #197。取得間隔は、設備ごとの設定）。
 * 修正は、設備の項目を置き換えるため、現在の値を読み、取得間隔だけを変えて、送る。
 */
export async function setEquipmentInterval(
  request: APIRequestContext,
  equipmentId: string,
  intervalMinutes: number,
): Promise<void> {
  const tree = await apiOk<{
    facilities: {
      facility: Record<string, unknown>;
      children: Record<string, unknown>[];
    }[];
  }>(request, 'GET', '/equipment');
  const item = tree.facilities
    .flatMap((entry) => [entry.facility, ...entry.children])
    .find((candidate) => candidate.equipmentId === equipmentId);
  if (item === undefined) {
    throw new Error(`設備が見つかりません: ${equipmentId}`);
  }
  await apiOk(request, 'PUT', `/equipment/${equipmentId}`, {
    name: item.name,
    ...(item.facilityId === undefined ? {} : { facilityId: item.facilityId }),
    ...(item.externalId === undefined ? {} : { externalId: item.externalId }),
    ...(item.sourceFilePath === undefined ? {} : { sourceFilePath: item.sourceFilePath }),
    intervalMinutes,
  });
}

/** ジョブ（JB-01〜JB-04）を起動する（開発用 API）。 */
export async function runJob(
  request: APIRequestContext,
  jobId: 'JB-01' | 'JB-02' | 'JB-03' | 'JB-04',
): Promise<void> {
  await apiOk(request, 'POST', `/dev/jobs/${jobId}/run`, {});
}

/** モック（農業情報基盤・Web Push）の状態を切り替える（開発用 API）。ファイルサーバーは、HTTP のテスト用サーバー（support/http-files.ts）。 */
export async function setMock(
  request: APIRequestContext,
  target: 'federation' | 'web-push',
  mode: 'UP' | 'DOWN' | 'SLOW' | 'REJECT',
): Promise<void> {
  await apiOk(request, 'PUT', `/dev/mocks/${target}`, { mode });
}

/** 時計を進める（開発用 API）。 */
export async function advanceMinutes(request: APIRequestContext, minutes: number): Promise<void> {
  await apiOk(request, 'POST', '/dev/clock/advance', { minutes });
}

/**
 * 管理者が決めたパスワードで、最初にログインした利用者が、パスワードの変更を済ませた状態にする（Issue #245。D-45）。
 * 管理者が決めたパスワードは、一時のもの（変更するまで、ほかの操作ができない）。パスワードを、一度、別のものに変え、
 * もとのパスワードに戻す（新しいパスワードは、現在と同じにはできないため）。終わると、変更が必要な旨は外れ、パスワードは、`user.password`。
 * ログインの強制そのものを確かめるテスト以外で、登録した利用者を、そのまま使うための補助。
 */
export async function settlePassword(
  request: APIRequestContext,
  user: Pick<E2eUser, 'userId' | 'password'>,
): Promise<void> {
  const interim = `${user.password}x`;
  const change = async (token: string, currentPassword: string, newPassword: string) => {
    const response = await request.post('/api/v1/auth/password', {
      data: { currentPassword, newPassword },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(
      response.ok(),
      `POST /auth/password（${user.userId}）: ${String(response.status())}`,
    ).toBe(true);
    return LoginResponseSchema.parse(await response.json()).accessToken;
  };
  const login = await request.post('/api/v1/auth/login', {
    data: { userId: user.userId, password: user.password },
  });
  expect(login.ok(), `ログイン（${user.userId}）`).toBe(true);
  const first = LoginResponseSchema.parse(await login.json()).accessToken;
  const second = await change(first, user.password, interim);
  await change(second, interim, user.password);
}

/** ユーザーを追加する（ユーザー管理の API）。管理者が決めたパスワードの変更も、済ませる（`settlePassword`）。 */
export async function addUser(request: APIRequestContext, user: E2eUser): Promise<void> {
  await addUserWithTemporaryPassword(request, user);
  await settlePassword(request, user);
}

/** ユーザーを追加する（ユーザー管理の API）。パスワードは、管理者が決めた、一時のもの（最初のログインで、変更が必要）。 */
export async function addUserWithTemporaryPassword(
  request: APIRequestContext,
  user: E2eUser,
): Promise<void> {
  await apiOk(request, 'POST', '/users', {
    userId: user.userId,
    userName: user.userName,
    password: user.password,
    role: user.role,
  });
}

/**
 * 対象の設備を指定しないときの、手動入力の設備: 環境情報はセンサー、満足度情報はハウス、そのほかはロボット
 * （手動入力のカテゴリは、対象の設備の種別に合うものだけ受ける。Issue #360）。
 */
export function defaultEntryEquipmentId(category: string): string {
  if (category === 'ENVIRONMENT') {
    return SENSOR_ID;
  }
  return category === 'SATISFACTION' ? HOUSE_ID : ROBOT_ID;
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
  return apiOk(request, 'POST', '/manual-entries', {
    equipmentId: defaultEntryEquipmentId(input.category),
    ...input,
  });
}

/** 手動入力を、指定した利用者として API で登録する（入力者が複数の前提のデータの用意）。 */
export async function addEntryAs(
  request: APIRequestContext,
  user: Pick<E2eUser, 'userId' | 'password'>,
  input: {
    equipmentId?: string;
    category: string;
    observedAt: string;
    items: Record<string, number>;
  },
): Promise<void> {
  const response = await request.fetch('/api/v1/manual-entries', {
    method: 'POST',
    data: { equipmentId: defaultEntryEquipmentId(input.category), ...input },
    headers: { authorization: `Bearer ${await accessToken(request, user)}` },
  });
  expect(
    response.ok(),
    `POST /manual-entries（${user.userId}）: ${String(response.status())}`,
  ).toBe(true);
}

// 取り込みの合成データ

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

/** 環境センサーの JSON（合成データ。設備の識別子 sensorId + 記録の配列）。空の文字列は欠損（null）、数値の文字列は数値にする（数値でない文字列は、そのまま）。 */
export function sensorJson(
  rows: readonly {
    hoursAgo: number;
    temperature: number | string;
    humidity: number | string;
    illuminance: number | string;
    co2: number | string;
  }[],
  sensorId: string = SENSOR_EXTERNAL_ID,
): string {
  const value = (raw: number | string) => {
    if (raw === '') {
      return null;
    }
    return typeof raw === 'string' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  };
  return JSON.stringify({
    sensorId,
    records: rows.map((row) => ({
      timestamp: new Date(NOW.getTime() - row.hoursAgo * 3_600_000).toISOString(),
      temperatureCelsius: value(row.temperature),
      humidityPercent: value(row.humidity),
      illuminanceLux: value(row.illuminance),
      co2Ppm: value(row.co2),
    })),
  });
}

// 準備・ブラウザ

/** データを初期化（デモの設備のみ）し、時計を固定する。HTTP のファイルサーバーは、`placeFile` などが、必要になったときに、空にして接続する（support/http-files.ts）。 */
export async function prepareApp(
  request: APIRequestContext,
  options: PrepareOptions = {},
): Promise<void> {
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
 * 狭い幅（900px 以下）では、メニューは「☰ で開く引き出し」のため、メニューが見えていないときだけ、☰ で先に開く（広い幅は、既定で開いている）。
 */
export async function goToMenu(page: Page, name: string): Promise<void> {
  // サイドメニューが閉じていれば（狭い幅の引き出し・広い幅で閉じているとき）、☰ で開く（Issue #354）。
  // 見えているかではなく、☰ の状態（aria-expanded）で判断する（ログイン直後は、画面の描画前で、『見えない』と誤って判断し、開いているメニューを閉じてしまうため。☰ が現れるまで待つ）
  const toggle = page.getByRole('button', { name: 'メニューの開閉' });
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }
  await page
    .getByRole('navigation', { name: 'メニュー' })
    .getByRole('link', { name, exact: true })
    .click();
}

/**
 * ヘッダーのユーザーメニュー（ユーザーアイコン・ユーザー名・ロールのボタン）を開き、メニューを返す（Issue #353）。
 * ユーザー名の変更・パスワードの変更・通知の設定・テーマ・ログアウトは、このメニューの中にある。
 */
export async function openUserMenu(page: Page): Promise<Locator> {
  await page
    .getByRole('banner')
    .getByRole('button', { name: /^ログイン中のユーザー/ })
    .click();
  const menu = page.getByRole('menu', { name: 'ユーザー' });
  await expect(menu).toBeVisible();
  return menu;
}

/** ユーザーメニューの項目（ユーザー名の変更・パスワードの変更・通知の設定・ログアウト）を選ぶ。 */
export async function goToUserMenu(page: Page, name: string): Promise<void> {
  const menu = await openUserMenu(page);
  await menu.getByRole('menuitem', { name, exact: true }).click();
}

/** ログアウトする（ユーザーメニューの「ログアウト」）。 */
export async function logout(page: Page): Promise<void> {
  await goToUserMenu(page, 'ログアウト');
}

/**
 * 通知の一覧を開く。通知は、メニューでなく、ヘッダーの通知のアイコン（リンクの名前は「未読の通知: N件」）から開く（Issue #351）。
 * ヘッダーは、狭い幅でも見えているため、メニューの引き出しを開く必要はない。
 */
export async function goToNotifications(page: Page): Promise<void> {
  await page.getByRole('link', { name: /^未読の通知/ }).click();
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
